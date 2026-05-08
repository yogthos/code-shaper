/**
 * Child-process supervisor.
 *
 * The server spawns one child per task via `runTask`. The child is
 * `bin/run-task.ts` invoked under the platform's sandbox (sandbox-exec
 * on macOS, bwrap on Linux). The parent here:
 *   - Captures stdout/stderr line-by-line into the task's log file
 *   - Updates the task table's `phase` field on each `phase=...` line
 *     the child emits
 *   - Starts a disk-quota watchdog and SIGTERMs the child on breach
 *   - Resolves with the final TaskResult (read from the result file
 *     the child wrote on exit)
 *   - Exposes `cancel()` so callers can SIGTERM mid-flight
 *
 * The runner does NOT know about MCP, the task table, or persistence.
 * It's a pure spawn-and-supervise primitive that the server layer
 * composes with the task table.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startDiskQuotaWatch } from "./disk-quota.js";
import { buildSandboxedSpawn } from "./sandbox.js";
import type {
  TaskMode,
  TaskPhase,
  TaskResult,
} from "./types.js";

export interface RunTaskOptions {
  taskId: string;
  projectDir: string;
  task: string;
  mode: TaskMode;
  /** Where the child writes its final TaskResult JSON. */
  resultPath: string;
  /** Where the parent appends child stdout+stderr lines. */
  logPath: string;
  /** Disk quota in MB. Watchdog SIGTERMs the child on breach. */
  diskQuotaMb: number;
  /** Additional writable dirs (the child's harness work dir).
   *  projectDir is added implicitly. */
  extraWritableRoots?: string[];
  /** Allow outbound network in the sandboxed child. Default true —
   *  the body author needs LLM API access. */
  allowNetwork?: boolean;
  /** Path to the run-task.ts entry. Tests override this with a mock
   *  script. Defaults to `<repoRoot>/bin/run-task.ts`. */
  entryPath?: string;
  /** Optional callback fired when the child reports a phase
   *  transition (`phase=...` line). The server uses this to update
   *  the task table. */
  onPhaseChange?: (phase: TaskPhase) => void;
  /** Optional callback per stdout/stderr line. The server can use
   *  this to push events to MCP clients tailing the task log. */
  onLogLine?: (line: string) => void;
}

export interface RunTaskHandle {
  /** Resolves when the child exits, with the parsed TaskResult. */
  done: Promise<TaskResult>;
  /** SIGTERM the child. The `done` promise then resolves with a
   *  cancelled result. */
  cancel(): void;
  /** Child PID (null until spawn lands). */
  pid(): number | null;
}

const PHASE_LINE_RE = /\bphase=([a-z_-]+)/i;
/** Phases the child may report via stdout. Terminal phases (done /
 *  failed / cancelled) are intentionally NOT in this set: the parent
 *  (acquireAndRun) owns the terminal transition based on the child's
 *  exit code + result file. If the child's "phase=done" stdout line
 *  also wrote a record update, callers polling status would race
 *  with the parent's final write — they'd see "done" momentarily,
 *  end the test, and the parent's final write would then ENOENT
 *  against a torn-down stateDir. */
const VALID_REPORTED_PHASES = new Set<TaskPhase>([
  "queued",
  "starting",
  "proposal",
  "structure",
  "interfaces",
  "refactor",
  "implementation",
  "integration",
]);

export function runTask(opts: RunTaskOptions): RunTaskHandle {
  const repoRoot = findRepoRoot();
  // Resolution priority: explicit opts.entryPath > env override >
  // packaged default. The env override is for tests (and rare repro
  // workflows) that want to point at a mock entry without threading
  // it through every caller. NEVER set it in production.
  const entryPath =
    opts.entryPath ??
    process.env.CODE_SHAPER_RUN_TASK_ENTRY ??
    path.join(repoRoot, "bin", "run-task.ts");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

  // Sandbox the child. writableRoots includes the project, the result
  // file's parent dir (so the child can write its result), the log
  // file's parent dir (so node can append to it via stdout
  // redirection — actually the parent owns the log fd, so this is
  // belt-and-suspenders), and any caller-supplied extras (notably
  // the harness work dir).
  //
  // tsx (the TypeScript loader we run children with) creates a Unix
  // domain socket at `<tmpdir>/tsx-<uid>/<pid>.pipe` for ESM-loader
  // IPC. Without write access to that path, even `tsx --version`
  // crashes at startup with EPERM. Carving it out is narrowly scoped
  // (one process per uid) and only matters when running children
  // through tsx — once we precompile to dist/ this won't be needed.
  const tsxTempDir =
    typeof process.getuid === "function"
      ? path.join(tmpdir(), `tsx-${process.getuid()}`)
      : null;
  const writableRoots = [
    opts.projectDir,
    path.dirname(opts.resultPath),
    path.dirname(opts.logPath),
    ...(tsxTempDir ? [tsxTempDir] : []),
    ...(opts.extraWritableRoots ?? []),
  ];
  const innerArgs = [
    entryPath,
    "--project-dir",
    opts.projectDir,
    "--task",
    opts.task,
    "--mode",
    opts.mode,
    "--result-path",
    opts.resultPath,
  ];
  const spawned = buildSandboxedSpawn(
    {
      writableRoots,
      allowNetwork: opts.allowNetwork ?? true,
    },
    tsxBin,
    innerArgs,
  );
  // Defense-in-depth: refuse to run unsandboxed unless the operator
  // has explicitly opted in. Without this, a host that's missing
  // `sandbox-exec` (macOS without the system app) or `bwrap` (Linux
  // without bubblewrap installed) would silently execute model-
  // authored code with full host privileges. Explicit opt-in is via
  // the env var so it's a visible operator decision rather than a
  // submission-time toggle a misconfigured client could enable.
  if (
    spawned.backend === "none" &&
    process.env.CODE_SHAPER_ALLOW_UNSANDBOXED !== "1"
  ) {
    throw new Error(
      `refusing to run task ${opts.taskId}: no sandbox available on this host (sandbox-exec / bwrap not found). ` +
        `Install one, or set CODE_SHAPER_ALLOW_UNSANDBOXED=1 to override.`,
    );
  }

  const handle: { child: ChildProcess | null } = { child: null };
  let cancelled = false;

  const done = (async (): Promise<TaskResult> => {
    // Ensure dirs exist before writing.
    await mkdir(path.dirname(opts.logPath), { recursive: true });
    await mkdir(path.dirname(opts.resultPath), { recursive: true });
    await mkdir(opts.projectDir, { recursive: true });
    // Pre-create the tsx temp dir so realpath resolution + sandbox
    // matching work even on the first child of a fresh boot.
    if (tsxTempDir) await mkdir(tsxTempDir, { recursive: true });
    // Truncate the log file at start (a re-run of the same task id
    // shouldn't pile on top of the prior log).
    await writeFile(opts.logPath, "", "utf-8");

    const child = spawn(spawned.command, spawned.args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Inherit env so the child sees the LLM API keys. The sandbox
      // doesn't isolate env vars; if you wanted that, you'd pass an
      // explicit `env: {}` here. The user's call: trust the user's
      // own machine env.
      env: process.env,
      cwd: opts.projectDir,
    });
    handle.child = child;

    // Start disk-quota watchdog. On breach, SIGTERM the child.
    const quota = startDiskQuotaWatch({
      path: opts.projectDir,
      maxBytes: opts.diskQuotaMb * 1024 * 1024,
      onBreach: (bytes) => {
        const mb = (bytes / (1024 * 1024)).toFixed(1);
        const line = `[disk-quota] breach: ${mb}MB exceeds ${opts.diskQuotaMb}MB; sending SIGTERM\n`;
        void appendFile(opts.logPath, line);
        if (opts.onLogLine) opts.onLogLine(line.trimEnd());
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      },
    });

    // Stream stdout/stderr line-by-line. We line-buffer ourselves
    // because node's child stdio is a chunked stream — splitting on
    // `\n` lets us match `phase=...` cleanly without straddling
    // chunk boundaries.
    //
    // Append writes are SERIALIZED via `logWriteQueue`. Without this,
    // each line spawns its own appendFile promise, and on a fast
    // child those promises can outlive the close handler — leaking
    // into the next test (or the next caller's cleanup) as a
    // mid-rm-rf file creation. Awaiting the queue before resolving
    // `done` guarantees the log file is final before we hand back.
    let logWriteQueue: Promise<void> = Promise.resolve();
    const handleStream = (
      stream: NodeJS.ReadableStream,
    ): void => {
      let carry = "";
      stream.on("data", (chunk: Buffer) => {
        carry += chunk.toString("utf-8");
        let nl: number;
        while ((nl = carry.indexOf("\n")) !== -1) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          logWriteQueue = logWriteQueue
            .then(() => appendFile(opts.logPath, line + "\n"))
            .catch(() => {});
          if (opts.onLogLine) opts.onLogLine(line);
          const match = line.match(PHASE_LINE_RE);
          if (match) {
            const candidate = match[1] as TaskPhase;
            if (
              VALID_REPORTED_PHASES.has(candidate) &&
              opts.onPhaseChange
            ) {
              opts.onPhaseChange(candidate);
            }
          }
        }
      });
    };
    handleStream(child.stdout!);
    handleStream(child.stderr!);

    // Wait for exit. Capture the spawn-error object too — without
    // this, an ENOENT (sandbox-exec / bwrap missing, tsx broken)
    // surfaces only as "child exited without writing result
    // (code=null, signal=none)" with no clue what actually failed.
    let spawnError: Error | null = null;
    const exitInfo = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      let resolved = false;
      const settle = (v: { code: number | null; signal: NodeJS.Signals | null }): void => {
        if (resolved) return;
        resolved = true;
        resolve(v);
      };
      child.on("close", (code, signal) => settle({ code, signal }));
      child.on("error", (err) => {
        spawnError = err instanceof Error ? err : new Error(String(err));
        settle({ code: null, signal: null });
      });
    });
    quota.stop();
    // Drain pending log writes BEFORE attempting to read the result
    // file or returning to the caller. This is the seam where
    // post-completion writes leaked previously.
    await logWriteQueue;

    // Try to read whatever result the child wrote. If the child
    // crashed before writing one, synthesize a failure result.
    let result: TaskResult;
    try {
      const raw = await readFile(opts.resultPath, "utf-8");
      result = JSON.parse(raw) as TaskResult;
    } catch (e) {
      const err: Error = spawnError ?? (e instanceof Error ? e : new Error(String(e)));
      result = {
        ok: false,
        summary: cancelled
          ? "cancelled by caller"
          : spawnError !== null
            ? `child failed to spawn: ${err.message}`
            : `child exited without writing result (code=${exitInfo.code}, signal=${exitInfo.signal ?? "none"})`,
        materializedTo: opts.projectDir,
        leafResults: [],
        integrationOk: null,
        error: err.message,
      };
    }
    return result;
  })();

  return {
    done,
    cancel(): void {
      cancelled = true;
      if (handle.child) {
        try {
          handle.child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    },
    pid(): number | null {
      return handle.child?.pid ?? null;
    },
  };
}

/** Find the repo root by walking up from this file looking for
 *  package.json. Caches on first call. */
let cachedRepoRoot: string | null = null;
function findRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRepoRoot = process.cwd();
  return cachedRepoRoot;
}
