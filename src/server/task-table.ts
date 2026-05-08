/**
 * Task registry — in-memory, persisted to disk on each mutation.
 *
 * Three responsibilities:
 *   1. Create + look up + update task records
 *   2. Serialize the registry to `stateDir/tasks.json` so a server
 *      restart can list prior runs (it cannot resume them — children
 *      are gone — but `task_result` still works on completed tasks)
 *   3. Per-projectDir mutex so two concurrent submissions on the same
 *      folder serialize rather than race on materialize
 *
 * Everything is in-process; no shared lock files or PIDs cross-process.
 * If you run two server instances pointing at the same stateDir, they
 * will clobber each other's index — don't do that.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  DEFAULT_DISK_QUOTA_MB,
  type TaskMode,
  type TaskRecord,
} from "./types.js";

export interface TaskTableInit {
  /** Directory the registry persists to. Holds `tasks.json` plus
   *  per-task log/result files under `logs/<taskId>.log` and
   *  `results/<taskId>.json`. Created if missing. */
  stateDir: string;
}

export interface CreateTaskInput {
  projectDir: string;
  task: string;
  mode: TaskMode;
  diskQuotaMb?: number;
}

export interface TaskTable {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(taskId: string): TaskRecord | null;
  list(): TaskRecord[];
  update(taskId: string, patch: Partial<TaskRecord>): Promise<void>;
  /** Serialize on the projectDir. Returns a release function the
   *  caller MUST call (try/finally) when their task ends. */
  acquireProjectDir(projectDir: string): Promise<() => void>;
  /** Async hook for testing — returns the resolved log + result paths
   *  for a record without consulting state. */
  pathsFor(taskId: string): { logPath: string; resultPath: string };
}

export async function createTaskTable(init: TaskTableInit): Promise<TaskTable> {
  const stateDir = path.resolve(init.stateDir);
  const indexPath = path.join(stateDir, "tasks.json");
  const logDir = path.join(stateDir, "logs");
  const resultDir = path.join(stateDir, "results");
  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(resultDir, { recursive: true });

  // Insertion-ordered map. Map preserves insertion order natively.
  const records = new Map<string, TaskRecord>();

  // Try to recover prior index. Garbage or missing → empty state.
  try {
    const raw = await readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as { tasks: TaskRecord[] };
    if (Array.isArray(parsed.tasks)) {
      for (const r of parsed.tasks) {
        if (r && typeof r.taskId === "string") {
          records.set(r.taskId, r);
        }
      }
    }
  } catch {
    // Either the file doesn't exist yet (first boot) or it's
    // corrupt. Either way: start fresh; the next persist() will
    // overwrite the file.
  }

  // Per-projectDir mutex: each key holds a Promise chain. Acquiring
  // appends a new tail; release resolves the tail.
  const dirChainTails = new Map<string, Promise<void>>();

  function persist(): Promise<void> {
    const tasks = Array.from(records.values());
    return writeFile(indexPath, JSON.stringify({ tasks }, null, 2), "utf-8");
  }

  function makeId(): string {
    // 4 random bytes → 8 hex chars. Plenty of entropy for an
    // in-process registry; collision probability is negligible
    // even after thousands of tasks.
    return `t-${randomBytes(4).toString("hex")}`;
  }

  function clone(r: TaskRecord): TaskRecord {
    return JSON.parse(JSON.stringify(r));
  }

  function pathsFor(taskId: string): { logPath: string; resultPath: string } {
    return {
      logPath: path.join(logDir, `${taskId}.log`),
      resultPath: path.join(resultDir, `${taskId}.json`),
    };
  }

  function normalizeProjectDir(p: string): string {
    return path.resolve(p).replace(/\/+$/, "");
  }

  return {
    async create(input: CreateTaskInput): Promise<TaskRecord> {
      const taskId = makeId();
      const { logPath, resultPath } = pathsFor(taskId);
      const record: TaskRecord = {
        taskId,
        projectDir: path.resolve(input.projectDir),
        task: input.task,
        mode: input.mode,
        phase: "queued",
        startedAt: Date.now(),
        doneAt: null,
        pid: null,
        logPath,
        resultPath,
        error: null,
        diskQuotaMb: input.diskQuotaMb ?? DEFAULT_DISK_QUOTA_MB,
      };
      records.set(taskId, record);
      await persist();
      return clone(record);
    },

    get(taskId: string): TaskRecord | null {
      const r = records.get(taskId);
      return r ? clone(r) : null;
    },

    list(): TaskRecord[] {
      return Array.from(records.values()).map(clone);
    },

    async update(
      taskId: string,
      patch: Partial<TaskRecord>,
    ): Promise<void> {
      const existing = records.get(taskId);
      if (!existing) throw new Error(`task not found: ${taskId}`);
      const { taskId: _ignore, ...allowed } = patch as Record<string, unknown>;
      void _ignore;
      Object.assign(existing, allowed);
      await persist();
    },

    async acquireProjectDir(projectDir: string): Promise<() => void> {
      const key = normalizeProjectDir(projectDir);
      const previous = dirChainTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      dirChainTails.set(
        key,
        previous.then(() => next),
      );
      // Wait for the prior holder to release before returning. The
      // returned release function resolves OUR slot so the next
      // waiter can run.
      await previous;
      return () => {
        release();
        // Garbage-collect the chain when no one's waiting.
        if (dirChainTails.get(key) === previous.then(() => next)) {
          // Note: this comparison rarely succeeds because the chain
          // tail is the new `next` promise, not `previous.then(...)`.
          // GC happens implicitly when the map entry's value is
          // replaced. Leaving for clarity; safe to no-op.
        }
      };
    },

    pathsFor,
  };
}
