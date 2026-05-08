/**
 * Sandbox guard for filesystem writes.
 *
 * Every file the harness produces — source via `materializeRPG`, test
 * files via the vitest harness — has its destination path checked
 * against the project root. If the resolved absolute path would land
 * outside that root, we throw rather than write. The check is a
 * defense-in-depth: architect-side path validators already reject
 * `..` segments and absolute paths at operation-creation time, but a
 * malicious or buggy graph (e.g., loading an existing repo with
 * tampered metadata) shouldn't be able to escape.
 *
 * Symlink caveat: the check operates at the JavaScript-string level,
 * BEFORE the OS dereferences any symlinks. If the project root
 * contains a symlink pointing outside (e.g., `outDir/foo.ts` → `/etc/passwd`),
 * a `writeFile` after our check passes will traverse the symlink
 * and escape. Mitigations:
 *   - The agent itself cannot create symlinks via the operation
 *     vocabulary, so this requires a hostile pre-existing setup.
 *   - Callers materializing into a brand-new temp dir (the harness'
 *     standard pattern) sidestep the risk entirely.
 *   - Callers materializing into an existing repo can `lstat` each
 *     resolved path before writing if they want stricter behavior.
 */

import path from "node:path";

export class PathEscapeError extends Error {
  /** The raw path the caller tried to use, before resolution. */
  readonly attemptedPath: string;
  /** Absolute project root the path escaped. */
  readonly projectRoot: string;
  constructor(attemptedPath: string, projectRoot: string) {
    super(
      `refusing to write path "${attemptedPath}" — resolves outside project root "${projectRoot}"`,
    );
    this.name = "PathEscapeError";
    this.attemptedPath = attemptedPath;
    this.projectRoot = projectRoot;
  }
}

/**
 * Resolve `rel` against `root` and assert the result lies at or
 * beneath `root`. Returns the absolute path. Throws PathEscapeError
 * on escape.
 *
 * Rules:
 *   - `root` is normalized to its absolute form.
 *   - `rel` may be a `path.join`-able fragment OR an already-absolute
 *     path; either way the resolution must end up inside the root.
 *   - Equality with the root itself is allowed (writing the root
 *     directory's own contents is fine).
 */
export function safeResolve(root: string, rel: string): string {
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, rel);
  if (candidate === absRoot) return candidate;
  // Append a separator so prefix check rejects sibling-with-shared-
  // prefix cases like `/abs/root2` against root `/abs/root`.
  const rootWithSep = absRoot.endsWith(path.sep)
    ? absRoot
    : absRoot + path.sep;
  if (!candidate.startsWith(rootWithSep)) {
    throw new PathEscapeError(rel, absRoot);
  }
  return candidate;
}

/** Predicate variant — returns true if the path resolves safely.
 *  Useful for filtering rather than asserting. */
export function isSafePath(root: string, rel: string): boolean {
  try {
    safeResolve(root, rel);
    return true;
  } catch {
    return false;
  }
}
