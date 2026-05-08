/**
 * Cross-platform sandbox dispatcher.
 *
 * Picks the right backend based on the host OS. Returns a description
 * of how to spawn the inner command — caller passes it to
 * `child_process.spawn`. Returns `null` when no sandbox is available
 * on the host (e.g., Linux without bubblewrap, or an unsupported OS):
 * the caller decides whether to refuse the task or run unsandboxed.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";

import { renderMacosSandboxProfile } from "./sandbox-macos.js";
import { renderBwrapArgv } from "./sandbox-linux.js";

export interface SandboxOptions {
  /** Absolute paths writes are permitted under. Caller should pass
   *  `realpath`-resolved values to defeat symlink escapes. */
  writableRoots: string[];
  /** Allow outbound network. Default true (body author needs LLM
   *  API access). */
  allowNetwork?: boolean;
}

export interface SandboxedSpawn {
  /** The actual binary to spawn. */
  command: string;
  /** Args including the inner command and its args at the end. */
  args: string[];
  /** Backend used; "none" means no sandbox available — caller's
   *  policy decides whether to proceed. */
  backend: "macos-sandbox-exec" | "linux-bwrap" | "none";
}

/** Wrap an inner command in the host's sandbox.
 *
 * On macOS, sandbox-exec matches against canonicalized (symlink-
 * resolved) paths. `/var/folders/...` (where `mkdtemp` puts work
 * dirs) is a symlink to `/private/var/folders/...`, so we realpath
 * each root before rendering the profile. Otherwise an allowlist
 * entry for `/var/folders/X` wouldn't match a write at the same
 * location.
 *
 * Linux bwrap doesn't have this problem — it operates on inode
 * mounts, not path matching — but realpath-ing is harmless there. */
export function buildSandboxedSpawn(
  opts: SandboxOptions,
  innerCommand: string,
  innerArgs: string[],
): SandboxedSpawn {
  const os = platform();
  const resolvedRoots = opts.writableRoots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r; // Non-existent path; pass through.
    }
  });
  if (os === "darwin") {
    if (!isExecutableAvailable("sandbox-exec")) {
      return {
        command: innerCommand,
        args: innerArgs,
        backend: "none",
      };
    }
    const profile = renderMacosSandboxProfile({
      writableRoots: resolvedRoots,
      allowNetwork: opts.allowNetwork ?? true,
      allowProcessFork: true,
    });
    return {
      command: "sandbox-exec",
      args: ["-p", profile, innerCommand, ...innerArgs],
      backend: "macos-sandbox-exec",
    };
  }
  if (os === "linux") {
    if (!isExecutableAvailable("bwrap")) {
      return {
        command: innerCommand,
        args: innerArgs,
        backend: "none",
      };
    }
    const argv = renderBwrapArgv(
      {
        writableRoots: resolvedRoots,
        allowNetwork: opts.allowNetwork ?? true,
      },
      innerCommand,
      innerArgs,
    );
    return {
      command: argv[0]!,
      args: argv.slice(1),
      backend: "linux-bwrap",
    };
  }
  return { command: innerCommand, args: innerArgs, backend: "none" };
}

function isExecutableAvailable(binary: string): boolean {
  try {
    const r = spawnSync("which", [binary], { encoding: "utf-8" });
    return r.status === 0 && (r.stdout?.trim().length ?? 0) > 0;
  } catch {
    return false;
  }
}
