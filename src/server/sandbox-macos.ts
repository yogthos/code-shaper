/**
 * macOS sandbox profile generator for `sandbox-exec`.
 *
 * The profile permits unrestricted reads (per the user's call:
 * destructive operations are the concern, reads aren't), restricts
 * writes to the project + scratch directories, and allows network
 * (the body author needs to call out to LLM providers).
 *
 * `sandbox-exec` is deprecated by Apple but still ships and works on
 * current macOS. Until they ship a documented replacement, this is
 * the standard mechanism for fine-grained per-process FS sandboxing
 * on the platform.
 *
 * Usage:
 *   const profile = renderMacosSandboxProfile({ writableRoots: [...] });
 *   spawn("sandbox-exec", ["-p", profile, "node", "child.mjs"]);
 *
 * The profile is a TinyScheme-flavoured DSL; we render it as a
 * single string and pass via `-p`. (Alternative: write to a temp
 * `.sb` file and pass via `-f`. `-p` avoids the temp-file lifecycle.)
 */

export interface MacosSandboxOptions {
  /** Absolute paths writes are permitted under. */
  writableRoots: string[];
  /** Allow outbound network (default true — body author calls LLM). */
  allowNetwork?: boolean;
  /** Allow process forking. Required for `node` to spawn workers /
   *  child processes (the harness uses them for vitest). */
  allowProcessFork?: boolean;
}

/**
 * Render the profile as an inline `sandbox-exec -p` argument.
 *
 * The shape:
 *   - default deny everything
 *   - allow read everywhere
 *   - allow write only under specific subpath roots
 *   - allow process exec/fork (so node can spawn vitest)
 *   - allow network unless explicitly denied
 *   - allow ipc, mach lookups, sysctl reads (node startup needs these)
 */
export function renderMacosSandboxProfile(
  opts: MacosSandboxOptions,
): string {
  const allowNetwork = opts.allowNetwork ?? true;
  const allowProcessFork = opts.allowProcessFork ?? true;

  const lines: string[] = [];
  lines.push("(version 1)");
  lines.push("(deny default)");
  // System calls every node binary needs to even start up.
  lines.push("(allow process-info*)");
  lines.push("(allow signal (target self))");
  lines.push("(allow sysctl-read)");
  lines.push("(allow ipc-posix-shm)");
  lines.push("(allow mach-lookup)");
  lines.push("(allow mach-priv-host-port)");
  lines.push("(allow iokit-open)");
  lines.push("(allow file-read*)");

  if (allowProcessFork) {
    lines.push("(allow process-fork)");
    lines.push("(allow process-exec)");
  }

  if (allowNetwork) {
    lines.push("(allow network*)");
  }

  // Writes: deny everything, then carve out exceptions.
  //
  // Caller is responsible for including ANY directory the inner
  // process needs to write to in `writableRoots`. We do NOT add a
  // broad carve-out for /tmp or /private/var/folders here, because
  // doing so would let a malicious model write outside the project
  // (a model running `fs.rmSync("/private/var/folders/...")` would
  // succeed if that path were allowlisted).
  //
  // /dev: we previously allowed (subpath "/dev") wholesale because
  // node opens /dev/null + /dev/urandom freely. But that also lets
  // a model open and write to /dev/disk*, /dev/console, /dev/tty*,
  // and any user-writable device nodes. Both of those node startup
  // files are READS, already covered by `(allow file-read*)`. The
  // only writes node actually needs are to /dev/null (a sink, no
  // observable side effects) and /dev/dtracehelper (probe target).
  // Restrict to those literals so the sandbox blocks writes to
  // every other device node.
  lines.push("(deny file-write*)");
  for (const root of opts.writableRoots) {
    // `subpath` includes the root itself + everything beneath it.
    // sandbox-exec requires absolute paths and does NOT resolve
    // symlinks; the caller is responsible for passing realpath-ed
    // values if they want symlink-following semantics.
    lines.push(`(allow file-write* (subpath ${schemeQuote(root)}))`);
  }
  lines.push('(allow file-write-data (literal "/dev/null"))');
  lines.push('(allow file-write-data (literal "/dev/dtracehelper"))');

  return lines.join("\n");
}

/** Scheme string-literal quoter — escapes backslash and double-quote.
 *  Sandbox-exec accepts double-quoted strings; nothing else needs
 *  escaping for path values. */
function schemeQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
