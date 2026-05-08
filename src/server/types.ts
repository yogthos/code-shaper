/**
 * Server-layer shapes.
 *
 * The server runs ONE process; each `submit_task` spawns a child
 * process that does the actual pipeline work. The records here track
 * the lifecycle of those tasks from the parent's perspective:
 * what's running, where its log lives, when it finished.
 *
 * The child writes its own RPG snapshot to `resultPath` on exit (or
 * a partial snapshot if it crashed mid-build). The parent doesn't
 * load the RPG into memory — `task_result` reads + relays it.
 */

export type TaskMode =
  /** Auto-detect from `projectDir`: empty → greenfield, non-empty → extend. */
  | "auto"
  /** Build from scratch in an empty folder. Refuses non-empty dirs. */
  | "greenfield"
  /** Extend an existing project. Refuses empty dirs. */
  | "extend"
  /** Bug-fix mode: load existing repo, target a specific failure. */
  | "fix"
  /** Add-feature mode: load existing repo, narrow scope to the feature. */
  | "feature";

export type TaskPhase =
  | "queued"
  | "starting"
  | "proposal"
  | "structure"
  | "interfaces"
  | "refactor"
  | "implementation"
  | "integration"
  | "done"
  | "failed"
  | "cancelled";

export interface TaskSubmission {
  /** Absolute path to the project the child will work in. The child's
   *  filesystem sandbox is rooted here. */
  projectDir: string;
  /** Free-text task description. The child decides how to use it
   *  based on `mode` (greenfield → architect description; extend →
   *  feature description; fix → bug report; etc.). */
  task: string;
  mode?: TaskMode;
  /** Optional disk quota in megabytes. Defaults to DEFAULT_DISK_QUOTA_MB. */
  diskQuotaMb?: number;
}

export interface TaskRecord {
  taskId: string;
  projectDir: string;
  task: string;
  mode: TaskMode;
  phase: TaskPhase;
  /** Set when the child finishes (success OR failure OR cancel). */
  doneAt: number | null;
  /** Set when the task is created. */
  startedAt: number;
  /** Child PID while running; null after exit. */
  pid: number | null;
  /** Path to the file capturing child stdout+stderr line-by-line. */
  logPath: string;
  /** Path the child writes its final result JSON to. */
  resultPath: string;
  /** Set when phase==="failed". */
  error: string | null;
  /** Disk quota applied to the child (MB). */
  diskQuotaMb: number;
}

export interface TaskResult {
  ok: boolean;
  summary: string;
  /** The directory the pipeline materialized into (may be partial on
   *  failure — the materialize is incremental). */
  materializedTo: string;
  /** Per-leaf outcomes from the implementation phase. Empty if the
   *  pipeline didn't reach phase 6. */
  leafResults: Array<{ leafId: string; ok: boolean; reason?: string }>;
  integrationOk: boolean | null;
  error: string | null;
}

/** Default disk quota when the submission doesn't specify one. */
export const DEFAULT_DISK_QUOTA_MB = 1024;

/** Max parallel tasks the server runs concurrently. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 4;

/** How often the disk-quota watchdog samples `du -s projectDir`. */
export const DISK_QUOTA_POLL_MS = 5000;
