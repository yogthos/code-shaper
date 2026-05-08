/**
 * Sandbox profile tests.
 *
 * Two layers:
 *   1. Profile/argv generation — pure string output, fully unit-testable.
 *   2. Actual sandbox enforcement — only runs if the platform's sandbox
 *      tool is available. Spawns a tiny node child that tries to write
 *      both inside and outside the writable roots; asserts only the
 *      inside write succeeds.
 *
 * The enforcement test is platform-conditional. CI on macOS exercises
 * sandbox-exec; CI on Linux with bubblewrap exercises bwrap. Other
 * environments skip with a console note.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import path from "node:path";

import { renderMacosSandboxProfile } from "../src/server/sandbox-macos.js";
import { renderBwrapArgv } from "../src/server/sandbox-linux.js";
import { buildSandboxedSpawn } from "../src/server/sandbox.js";

describe("macos profile generator", () => {
  it("denies default and permits reads everywhere", () => {
    const profile = renderMacosSandboxProfile({
      writableRoots: ["/Users/me/proj"],
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow file-read*)");
  });

  it("scopes file-write* to the writable roots", () => {
    const profile = renderMacosSandboxProfile({
      writableRoots: ["/Users/me/proj", "/tmp/work"],
    });
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/Users/me/proj")');
    expect(profile).toContain('(subpath "/tmp/work")');
  });

  it("allows network by default; denies when explicitly false", () => {
    const allow = renderMacosSandboxProfile({ writableRoots: [] });
    expect(allow).toContain("(allow network*)");
    const deny = renderMacosSandboxProfile({
      writableRoots: [],
      allowNetwork: false,
    });
    expect(deny).not.toContain("(allow network*)");
  });

  it("escapes path values with double-quotes inside", () => {
    const profile = renderMacosSandboxProfile({
      writableRoots: ['/path/with "quote"'],
    });
    expect(profile).toContain('/path/with \\"quote\\"');
  });
});

describe("linux bwrap argv generator", () => {
  it("emits ro-bind / followed by rw bind for each root", () => {
    const argv = renderBwrapArgv(
      { writableRoots: ["/proj1", "/proj2"] },
      "node",
      ["script.mjs"],
    );
    // ro-bind comes first.
    const roIdx = argv.indexOf("--ro-bind");
    const bindIdx = argv.indexOf("--bind");
    expect(roIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThan(roIdx);
    // Both writable roots appear.
    expect(argv).toContain("/proj1");
    expect(argv).toContain("/proj2");
  });

  it("includes user/pid/ipc/uts unshare flags", () => {
    const argv = renderBwrapArgv({ writableRoots: [] }, "true", []);
    expect(argv).toContain("--unshare-user");
    expect(argv).toContain("--unshare-pid");
    expect(argv).toContain("--unshare-ipc");
    expect(argv).toContain("--unshare-uts");
  });

  it("unshares network when allowNetwork is false", () => {
    const allow = renderBwrapArgv(
      { writableRoots: [], allowNetwork: true },
      "true",
      [],
    );
    expect(allow).not.toContain("--unshare-net");
    const deny = renderBwrapArgv(
      { writableRoots: [], allowNetwork: false },
      "true",
      [],
    );
    expect(deny).toContain("--unshare-net");
  });

  it("appends the inner command after a -- separator", () => {
    const argv = renderBwrapArgv({ writableRoots: [] }, "node", ["x.mjs", "y"]);
    const sepIdx = argv.lastIndexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(argv.slice(sepIdx)).toEqual(["--", "node", "x.mjs", "y"]);
  });
});

describe("buildSandboxedSpawn dispatch", () => {
  it("returns backend=none when the platform tool is missing", () => {
    // We can't easily simulate a missing tool, but we CAN verify the
    // shape on the current platform: if the tool is present, backend
    // is the platform-specific one; either way the inner command +
    // args are reachable from the result.
    const r = buildSandboxedSpawn(
      { writableRoots: ["/tmp"] },
      "node",
      ["--version"],
    );
    expect(r.args.includes("node") || r.command === "node").toBe(true);
    expect(["macos-sandbox-exec", "linux-bwrap", "none"]).toContain(r.backend);
  });
});

const sandboxAvailableForOs = (): "macos" | "linux" | "none" => {
  if (platform() === "darwin") {
    const r = spawnSync("which", ["sandbox-exec"], { encoding: "utf-8" });
    return r.status === 0 && r.stdout.trim().length > 0 ? "macos" : "none";
  }
  if (platform() === "linux") {
    const r = spawnSync("which", ["bwrap"], { encoding: "utf-8" });
    return r.status === 0 && r.stdout.trim().length > 0 ? "linux" : "none";
  }
  return "none";
};

describe("sandbox enforcement (platform-conditional)", () => {
  const backend = sandboxAvailableForOs();

  if (backend === "none") {
    it.skip(`no sandbox tool available on ${platform()}; enforcement test skipped`, () => {});
    return;
  }

  it(
    "permits writes inside the project dir but denies writes outside",
    { timeout: 30_000 },
    async () => {
      const projectDir = await mkdtemp(path.join(tmpdir(), "sandbox-proj-"));
      const outsideDir = await mkdtemp(path.join(tmpdir(), "sandbox-outside-"));
      const scriptDir = await mkdtemp(path.join(tmpdir(), "sandbox-script-"));
      try {
        // Tiny node script: writes one file inside projectDir (should
        // succeed) and one file outside (should fail with EPERM-ish
        // error). Reports outcome via exit codes:
        //   0 — both behaviors as expected
        //   1 — inside write failed
        //   2 — outside write succeeded (sandbox failure)
        //   3 — unexpected error
        const script = `
import { writeFile } from "node:fs/promises";
const inside = process.argv[2];
const outside = process.argv[3];
let insideOk = false;
try { await writeFile(inside, "x"); insideOk = true; } catch {}
let outsideBlocked = false;
try { await writeFile(outside, "x"); }
catch { outsideBlocked = true; }
if (!insideOk) process.exit(1);
if (!outsideBlocked) process.exit(2);
process.exit(0);
`;
        const scriptPath = path.join(scriptDir, "probe.mjs");
        await writeFile(scriptPath, script, "utf-8");
        const insidePath = path.join(projectDir, "wrote-inside.txt");
        const outsidePath = path.join(outsideDir, "wrote-outside.txt");

        const spawned = buildSandboxedSpawn(
          {
            writableRoots: [projectDir, scriptDir],
            allowNetwork: true,
          },
          process.execPath,
          [scriptPath, insidePath, outsidePath],
        );
        expect(spawned.backend).not.toBe("none");

        const result = spawnSync(spawned.command, spawned.args, {
          encoding: "utf-8",
          timeout: 15_000,
        });
        // status === 0 means the script saw both behaviors correctly.
        if (result.status !== 0) {
          throw new Error(
            `sandbox probe exited with ${result.status}; stdout=${result.stdout} stderr=${result.stderr}`,
          );
        }
      } finally {
        await rm(projectDir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
        await rm(scriptDir, { recursive: true, force: true });
      }
    },
  );
});
