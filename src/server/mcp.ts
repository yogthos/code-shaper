/**
 * MCP server — five tools exposed over stdio.
 *
 *   submit_task    {projectDir, task, mode?, diskQuotaMb?} → {taskId}
 *   task_status    {taskId} → {phase, startedAt, doneAt?, pid?, error?}
 *   task_log_tail  {taskId, since?} → {events[]}
 *   task_result    {taskId} → {ok, summary, materializedTo, leafResults[], integrationOk, error}
 *   cancel_task    {taskId} → {ok}
 *
 * The server is single-threaded: it owns one TaskTable + holds a
 * Map<taskId, RunTaskHandle> for in-flight handles. Submit spawns
 * a child via the runner; status/log/result read state from the
 * table or the on-disk log/result files; cancel resolves a handle
 * and SIGTERMs.
 *
 * We don't import the MCP SDK at module scope so unit tests can
 * exercise the tool handlers without a stdio transport.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";

import { runTask, type RunTaskHandle } from "./runner.js";
import type { TaskTable } from "./task-table.js";
import type {
  TaskMode,
  TaskRecord,
  TaskResult,
  TaskSubmission,
} from "./types.js";

export interface ServerContext {
  table: TaskTable;
  /** taskId → in-flight handle (cleared when the task ends). */
  inflight: Map<string, RunTaskHandle>;
}

export function createServerContext(table: TaskTable): ServerContext {
  return { table, inflight: new Map() };
}

// ── Tool handlers ────────────────────────────────────────────────────

export async function handleSubmitTask(
  ctx: ServerContext,
  input: TaskSubmission,
): Promise<{ taskId: string }> {
  validateSubmission(input);
  const mode: TaskMode = input.mode ?? "auto";
  const record = await ctx.table.create({
    projectDir: input.projectDir,
    task: input.task,
    mode,
    ...(input.diskQuotaMb !== undefined
      ? { diskQuotaMb: input.diskQuotaMb }
      : {}),
  });

  // Acquire the projectDir mutex on a background promise; once we
  // have it, spawn the child. If a prior task on the same dir is
  // still running, we wait until it releases. Importantly: we don't
  // await acquisition here — submit_task returns immediately with
  // the taskId, and the child starts whenever the mutex frees.
  void acquireAndRun(ctx, record);

  return { taskId: record.taskId };
}

export interface TaskStatusResponse {
  taskId: string;
  phase: TaskRecord["phase"];
  projectDir: string;
  task: string;
  mode: TaskMode;
  startedAt: number;
  doneAt: number | null;
  pid: number | null;
  error: string | null;
}

export function handleTaskStatus(
  ctx: ServerContext,
  input: { taskId: string },
): TaskStatusResponse {
  const record = mustGet(ctx, input.taskId);
  return {
    taskId: record.taskId,
    phase: record.phase,
    projectDir: record.projectDir,
    task: record.task,
    mode: record.mode,
    startedAt: record.startedAt,
    doneAt: record.doneAt,
    pid: record.pid,
    error: record.error,
  };
}

export interface LogTailResponse {
  events: string[];
  /** Caller passes this back as `since` on the next call to receive
   *  only new events. */
  nextSince: number;
}

/** Read the task's log file from byte offset `since` and split on
 *  newlines. Cheap and correct for line-oriented logs. */
export async function handleLogTail(
  ctx: ServerContext,
  input: { taskId: string; since?: number },
): Promise<LogTailResponse> {
  const record = mustGet(ctx, input.taskId);
  const since = input.since ?? 0;
  let raw = "";
  try {
    raw = await readFile(record.logPath, "utf-8");
  } catch {
    return { events: [], nextSince: since };
  }
  const slice = raw.slice(since);
  const events = slice.split("\n").filter((line) => line.length > 0);
  return { events, nextSince: raw.length };
}

export async function handleTaskResult(
  ctx: ServerContext,
  input: { taskId: string },
): Promise<TaskResult> {
  const record = mustGet(ctx, input.taskId);
  if (record.phase !== "done" && record.phase !== "failed" && record.phase !== "cancelled") {
    return {
      ok: false,
      summary: `task is still ${record.phase}; result not yet available`,
      materializedTo: record.projectDir,
      leafResults: [],
      integrationOk: null,
      error: null,
    };
  }
  try {
    const raw = await readFile(record.resultPath, "utf-8");
    return JSON.parse(raw) as TaskResult;
  } catch (e) {
    return {
      ok: false,
      summary: "result file missing or unreadable",
      materializedTo: record.projectDir,
      leafResults: [],
      integrationOk: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function handleCancelTask(
  ctx: ServerContext,
  input: { taskId: string },
): Promise<{ ok: boolean; alreadyDone: boolean }> {
  const record = mustGet(ctx, input.taskId);
  const handle = ctx.inflight.get(record.taskId);
  if (!handle) {
    return { ok: false, alreadyDone: true };
  }
  handle.cancel();
  return { ok: true, alreadyDone: false };
}

// ── Internals ────────────────────────────────────────────────────────

async function acquireAndRun(
  ctx: ServerContext,
  record: TaskRecord,
): Promise<void> {
  const release = await ctx.table.acquireProjectDir(record.projectDir);
  // Per-task write queue. Every async table.update() the runner
  // triggers (via onPhaseChange) is chained onto this. Awaiting it
  // before the final phase=done|failed write guarantees no
  // post-completion writes leak past the test's afterEach cleanup,
  // and that callers never observe a stale phase between two
  // updates. Errors are swallowed (table.update only fails on
  // unknown taskId, which can't happen here) so one failed update
  // doesn't break the chain.
  let pending: Promise<void> = Promise.resolve();
  try {
    await ctx.table.update(record.taskId, { phase: "starting" });
    const handle = runTask({
      taskId: record.taskId,
      projectDir: record.projectDir,
      task: record.task,
      mode: record.mode,
      resultPath: record.resultPath,
      logPath: record.logPath,
      diskQuotaMb: record.diskQuotaMb,
      onPhaseChange: (phase) => {
        pending = pending
          .then(() => ctx.table.update(record.taskId, { phase }))
          .catch(() => {});
      },
    });
    ctx.inflight.set(record.taskId, handle);
    const pid = handle.pid();
    if (pid !== null) {
      await ctx.table.update(record.taskId, { pid });
    }
    const result = await handle.done;
    ctx.inflight.delete(record.taskId);
    // Drain queued onPhaseChange writes before the final transition
    // so the persisted ordering matches the in-memory ordering.
    await pending;
    await ctx.table.update(record.taskId, {
      phase: result.ok ? "done" : "failed",
      doneAt: Date.now(),
      pid: null,
      error: result.error,
    });
  } catch (e) {
    ctx.inflight.delete(record.taskId);
    await pending.catch(() => {});
    await ctx.table.update(record.taskId, {
      phase: "failed",
      doneAt: Date.now(),
      pid: null,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    release();
  }
}

function mustGet(ctx: ServerContext, taskId: string): TaskRecord {
  const record = ctx.table.get(taskId);
  if (!record) throw new Error(`unknown taskId: ${taskId}`);
  return record;
}

function validateSubmission(input: TaskSubmission): void {
  if (!input.projectDir || typeof input.projectDir !== "string") {
    throw new Error("projectDir is required");
  }
  if (!path.isAbsolute(input.projectDir)) {
    throw new Error("projectDir must be an absolute path");
  }
  // Reject system paths the user shouldn't be touching from a
  // generic agent. The sandbox would block writes too, but failing
  // early gives a clear error message.
  const resolved = (() => {
    try {
      return realpathSync(input.projectDir);
    } catch {
      return input.projectDir;
    }
  })();
  for (const banned of ["/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc"]) {
    if (resolved === banned || resolved.startsWith(banned + "/")) {
      throw new Error(
        `projectDir cannot be inside system path "${banned}"; got "${resolved}"`,
      );
    }
  }
  if (!input.task || typeof input.task !== "string") {
    throw new Error("task is required");
  }
  if (input.task.trim().length === 0) {
    throw new Error("task must not be empty");
  }
  if (
    input.mode !== undefined &&
    !["auto", "greenfield", "extend", "fix", "feature"].includes(input.mode)
  ) {
    throw new Error(`invalid mode: ${input.mode}`);
  }
}

/** Resolve once the projectDir exists; the caller is expected to
 *  pre-create or pass an existing path. Used as a sanity check
 *  outside the validation flow (validation already runs at submit). */
export async function projectDirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
