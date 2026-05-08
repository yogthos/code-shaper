/**
 * Linux sandbox argv generator for `bwrap` (bubblewrap).
 *
 * Bubblewrap is the most-portable of the Linux sandbox tools: it
 * ships with most distros (`apt install bubblewrap`, `dnf install
 * bubblewrap`), runs unprivileged via user namespaces, and has a
 * stable command-line surface.
 *
 * Like the macOS profile, this allows reads (we only restrict
 * destructive operations) but denies writes outside the project +
 * scratch dirs.
 *
 * Mechanism:
 *   - bind-mount the writable roots read-write into the sandbox
 *   - bind-mount the host filesystem read-only EVERYWHERE ELSE that
 *     reads need to work (we use `--ro-bind /` for simplicity, then
 *     punch read-write holes for the writable roots)
 *   - keep the same /proc, /tmp, /dev, /run as host (node needs them)
 *   - share the network namespace (allow network)
 *
 * Returns the argv to pass to spawn(): `bwrap` + flags + the inner
 * command + its args. Caller is responsible for verifying `bwrap`
 * exists on the host.
 */

export interface LinuxSandboxOptions {
  writableRoots: string[];
  allowNetwork?: boolean;
}

export function renderBwrapArgv(
  opts: LinuxSandboxOptions,
  innerCommand: string,
  innerArgs: string[],
): string[] {
  const allowNetwork = opts.allowNetwork ?? true;
  const argv: string[] = ["bwrap"];

  // Filesystem: read-only everywhere by default…
  argv.push("--ro-bind", "/", "/");
  // …then read-write holes for the writable roots. Order matters in
  // bwrap: each `--bind` overrides any earlier mount at the same path.
  for (const root of opts.writableRoots) {
    argv.push("--bind", root, root);
  }
  // /tmp + /dev + /proc + /sys: standard tmpfs/proc setup so node can
  // open random files, /dev/null, /dev/urandom, etc.
  argv.push("--proc", "/proc");
  argv.push("--dev", "/dev");
  argv.push("--tmpfs", "/tmp");

  // Namespace isolation. We DO want a separate PID namespace so the
  // sandboxed process can't signal others on the host, and a fresh
  // user namespace so writes don't escalate. We DON'T isolate the
  // network namespace by default — body author needs to talk to the
  // LLM API.
  argv.push("--unshare-user");
  argv.push("--unshare-pid");
  if (!allowNetwork) {
    argv.push("--unshare-net");
  }
  // IPC, UTS, cgroup: isolate; nothing the harness does cares.
  argv.push("--unshare-ipc");
  argv.push("--unshare-uts");
  argv.push("--unshare-cgroup-try");

  // Don't propagate signals from inside the sandbox to the parent —
  // `--die-with-parent` ensures the sandbox dies if WE die, which is
  // the right default for cancel/server-restart cases.
  argv.push("--die-with-parent");

  argv.push("--", innerCommand, ...innerArgs);
  return argv;
}
