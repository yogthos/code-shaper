/**
 * Step U1 — per-file mutex.
 *
 * Generalizes the previous "infra mutex" (which serialized all
 * package.json/tsconfig/vitest.config writes through a single
 * global lock) into a per-path mutex. Two workers editing
 * DIFFERENT files run in parallel; two editing the SAME file
 * serialize.
 *
 * Use case in the dev loop: any tool that mutates a file
 * (edit_file, add_dependency, remove_dependency, npm scripts,
 * future ones) wraps its body in `withFileLock(path, fn)`.
 * Cross-worker races on the same file are eliminated; parallel
 * edits to different files retain their throughput benefit.
 *
 * Implementation: a Map<filePath, Promise> holds the tail of
 * each file's lock chain. New writers attach to the tail; the
 * chain extends with their work; the next writer awaits them.
 * When a chain settles to its quiescent state (no pending
 * work), the entry is GC'd to keep the map bounded.
 */

const fileLockChains = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const wait = fileLockChains.get(filePath) ?? Promise.resolve();
  let release: () => void = () => {};
  const slot = new Promise<void>((r) => {
    release = r;
  });
  fileLockChains.set(
    filePath,
    wait.then(() => slot),
  );
  await wait;
  try {
    return await fn();
  } finally {
    release();
    // GC: if our slot is the current tail, remove the entry so
    // the map doesn't grow without bound across many distinct
    // file paths. The next acquire will start a fresh chain.
    queueMicrotask(() => {
      const current = fileLockChains.get(filePath);
      if (current === undefined) return;
      // Use a sentinel resolution: if the chain has settled to a
      // promise indistinguishable from Promise.resolve(), drop
      // it. This is a heuristic — false negatives just leave the
      // entry around, which is benign.
      void current.then(() => {
        if (fileLockChains.get(filePath) === current) {
          fileLockChains.delete(filePath);
        }
      });
    });
  }
}

/** Test-only helper to clear all locks. Useful between tests
 *  whose error-path semantics rely on a clean state. */
export function _resetFileLocksForTesting(): void {
  fileLockChains.clear();
}
