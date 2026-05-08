/**
 * Server module re-exports.
 *
 * Consumers can import from `code-shaper/server` once the package is
 * published; until then, internal callers do the same via relative
 * paths.
 */

export { createTaskTable } from "./task-table.js";
export type { TaskTable } from "./task-table.js";

export {
  createServerContext,
  handleSubmitTask,
  handleTaskStatus,
  handleLogTail,
  handleTaskResult,
  handleCancelTask,
  projectDirExists,
} from "./mcp.js";
export type {
  ServerContext,
  TaskStatusResponse,
  LogTailResponse,
} from "./mcp.js";

export { runTask } from "./runner.js";
export type { RunTaskOptions, RunTaskHandle } from "./runner.js";

export { buildSandboxedSpawn } from "./sandbox.js";
export type { SandboxOptions, SandboxedSpawn } from "./sandbox.js";

export { startDiskQuotaWatch } from "./disk-quota.js";
export type {
  DiskQuotaWatchOptions,
  DiskQuotaWatchHandle,
} from "./disk-quota.js";

export type {
  TaskMode,
  TaskPhase,
  TaskRecord,
  TaskResult,
  TaskSubmission,
} from "./types.js";
export {
  DEFAULT_DISK_QUOTA_MB,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DISK_QUOTA_POLL_MS,
} from "./types.js";
