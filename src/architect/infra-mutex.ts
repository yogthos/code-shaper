/**
 * Step S3 — shared mutex for infra-file edits.
 *
 * "Infra files" are project-level config the architect doesn't
 * own per-leaf: package.json, tsconfig.json, vitest.config.ts,
 * .env. Multiple workers may want to edit them concurrently —
 * one for `add_dependency`, another to set `environment: 'jsdom'`,
 * a third to add a tsconfig path alias. Without serialization
 * we get classic lost-update races (two workers each load
 * package.json, modify, write — the second clobbers the first).
 *
 * This module exposes a single Promise-chain mutex
 * (`withInfraLock`) that serializes ALL infra writes across all
 * workers. Reads bypass the lock — they don't need it because
 * single-threaded JS gives us atomic snapshots and the next
 * write goes through the lock anyway.
 *
 * The mutex is module-level intentionally: the orchestrator
 * runs as a single Node process, so a per-process singleton
 * covers every worker. If we ever fork workers as subprocesses
 * the lock would need to move to file-locking (flock) — but
 * that's not the current model.
 */

/** Files that the dev loop's edit_file is allowed to touch
 *  IRRESPECTIVE of which leaf is active. Edits to these go
 *  through `withInfraLock` so concurrent writes serialize. */
export const INFRA_FILES = Object.freeze([
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  ".env",
] as const);

export function isInfraPath(repoRelativePath: string): boolean {
  return (INFRA_FILES as readonly string[]).includes(repoRelativePath);
}

/** Promise chain that serializes infra writes. New writers
 *  attach to the tail; the chain extends with their work; the
 *  next writer waits for them. */
let infraEditChain: Promise<unknown> = Promise.resolve();

/** Run `fn` under the infra mutex. Concurrent calls queue up
 *  and execute one at a time, in arrival order. The inner work
 *  can throw — the lock is released cleanly via finally. */
export async function withInfraLock<T>(fn: () => Promise<T>): Promise<T> {
  // Capture the current tail; our work goes after it.
  const wait = infraEditChain;
  // Reserve our slot in the chain. We wrap fn() in a Promise
  // that resolves AFTER fn settles — that's what subsequent
  // callers will await.
  let release: () => void = () => {};
  const slot = new Promise<void>((r) => {
    release = r;
  });
  infraEditChain = wait.then(() => slot);
  // Wait for the prior holder to finish.
  await wait;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test-only: reset the chain to a clean state. Useful when a
 *  test's `withInfraLock` call throws and leaves the chain in
 *  a permanently-rejected state. Production code should never
 *  call this. */
export function _resetInfraLockForTesting(): void {
  infraEditChain = Promise.resolve();
}
