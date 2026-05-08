/**
 * Disk-quota watchdog.
 *
 * Periodically samples the on-disk size of a directory and invokes a
 * callback when it crosses a threshold. The server uses this to bound
 * how much disk a runaway task can consume — the sandbox stops a task
 * from writing OUTSIDE its project, but doesn't bound how much it
 * writes INSIDE.
 *
 * Implementation: `du -s -k path` runs cheaply (single syscall walk
 * cached by the kernel for recently-touched files). Polling at 5s
 * gives the orchestrator time to materialize new files between
 * samples; bursts get caught on the next tick.
 *
 * The watchdog is opt-in via `start()`. The returned handle has
 * `stop()` to detach. On quota breach, `onBreach` fires once with the
 * measured KB; the watchdog auto-stops itself afterwards (the caller
 * will SIGTERM the child).
 */

import { spawn } from "node:child_process";

import { DISK_QUOTA_POLL_MS } from "./types.js";

export interface DiskQuotaWatchOptions {
  /** Absolute path to the directory under watch. */
  path: string;
  /** Maximum bytes allowed before `onBreach` fires. The server passes
   *  `diskQuotaMb * 1024 * 1024`. */
  maxBytes: number;
  /** Sample interval (ms). Defaults to DISK_QUOTA_POLL_MS. */
  pollMs?: number;
  /** Fired exactly once when the path exceeds maxBytes. After this,
   *  the watcher stops itself. */
  onBreach: (measuredBytes: number) => void;
  /** Optional: fired on every sample (testing/observability hook). */
  onSample?: (measuredBytes: number) => void;
}

export interface DiskQuotaWatchHandle {
  stop(): void;
  /** Force a one-shot probe (used by tests). */
  probe(): Promise<number>;
}

export function startDiskQuotaWatch(
  opts: DiskQuotaWatchOptions,
): DiskQuotaWatchHandle {
  const pollMs = opts.pollMs ?? DISK_QUOTA_POLL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const probe = (): Promise<number> => {
    return new Promise<number>((resolve) => {
      const child = spawn("du", ["-s", "-k", opts.path], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf-8");
      });
      child.on("error", () => resolve(0));
      child.on("close", () => {
        // `du -s -k <path>` prints `<kb><tab><path>`. Parse the
        // first whitespace-separated number.
        const match = stdout.match(/^(\d+)/);
        if (!match) {
          resolve(0);
          return;
        }
        const kb = parseInt(match[1]!, 10);
        resolve(kb * 1024);
      });
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const bytes = await probe();
    if (stopped) return;
    if (opts.onSample) opts.onSample(bytes);
    if (bytes > opts.maxBytes) {
      stopped = true;
      if (timer) clearInterval(timer);
      opts.onBreach(bytes);
      return;
    }
  };

  // First sample fires immediately; subsequent samples on the
  // interval. Without this, we'd miss tasks that start above quota.
  void tick();
  timer = setInterval(() => void tick(), pollMs);
  // Don't keep the event loop alive purely for the watchdog.
  if (timer.unref) timer.unref();

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    probe,
  };
}
