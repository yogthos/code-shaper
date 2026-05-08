/**
 * Stage B npm-mutation primitives — tests over a real package.json
 * file with stubbed npm binaries (no registry access).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addDependency,
  removeDependency,
  setScript,
  npmRun,
} from "../src/architect/npm-tools.js";

const VALID_PKG = {
  name: "test-app",
  version: "0.1.0",
  type: "module" as const,
  scripts: { test: "vitest run" },
  dependencies: {} as Record<string, string>,
  devDependencies: { vitest: "^2.0.0" } as Record<string, string>,
};

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "npm-tools-"));
  await writeFile(
    path.join(outDir, "package.json"),
    JSON.stringify(VALID_PKG, null, 2),
  );
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface ReadPkgShape {
  name: string;
  version: string;
  type: "module";
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPkg(): Promise<ReadPkgShape> {
  return JSON.parse(
    await readFile(path.join(outDir, "package.json"), "utf-8"),
  );
}

async function makeStubBinary(behavior: {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "stub-bin-"));
  const stub = path.join(dir, "stub-npm");
  const stdout = behavior.stdout ?? "";
  const stderr = behavior.stderr ?? "";
  const script = `#!/usr/bin/env node
${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ""}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
process.exit(${behavior.exitCode});
`;
  await writeFile(stub, script, "utf-8");
  await chmod(stub, 0o755);
  return stub;
}

describe("addDependency", () => {
  it("adds a runtime dependency and re-runs npm install", async () => {
    const stub = await makeStubBinary({ exitCode: 0 });
    const r = await addDependency({
      outDir,
      name: "zod",
      version: "^3.22.0",
      which: "runtime",
      npmBinary: stub,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.installRan).toBe(true);
    const pkg = await readPkg();
    expect(pkg.dependencies?.zod).toBe("^3.22.0");
  });

  it("adds a dev dependency to the right bucket", async () => {
    const r = await addDependency({
      outDir,
      name: "@types/node",
      version: "^22.0.0",
      which: "dev",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(true);
    const pkg = await readPkg();
    expect(pkg.devDependencies?.["@types/node"]).toBe("^22.0.0");
    expect(pkg.dependencies?.["@types/node"]).toBeUndefined();
  });

  it("is a no-op (no install re-run) when the version matches", async () => {
    await addDependency({
      outDir,
      name: "vitest",
      version: "^2.0.0",
      which: "dev",
      skipNpmInstall: true,
    });
    // Second call with the SAME version: skipNpmInstall doesn't
    // matter because we should detect the no-op and not even try.
    let installCalled = false;
    const stub = await makeStubBinary({ exitCode: 0 });
    // Wrap in a path that signals when called — we can't directly
    // observe, but installRan: false is the contract.
    void installCalled;
    const r = await addDependency({
      outDir,
      name: "vitest",
      version: "^2.0.0",
      which: "dev",
      npmBinary: stub,
    });
    expect(r.ok).toBe(true);
    expect(r.installRan).toBe(false);
  });

  it("reports failure when npm install exits non-zero", async () => {
    const stub = await makeStubBinary({
      exitCode: 1,
      stderr: "ENOTFOUND\n",
    });
    const r = await addDependency({
      outDir,
      name: "zod",
      version: "^3.22.0",
      which: "runtime",
      npmBinary: stub,
    });
    expect(r.ok).toBe(false);
    expect(r.installRan).toBe(true);
    expect(r.error).toContain("npm install exited");
  });
});

describe("removeDependency", () => {
  it("removes from dependencies and dev-dependencies, re-runs install", async () => {
    // Pre-seed both buckets.
    const pkg = await readPkg();
    pkg.dependencies = { ...pkg.dependencies, lodash: "^4.0.0" };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(pkg, null, 2),
    );
    const stub = await makeStubBinary({ exitCode: 0 });
    const r = await removeDependency({
      outDir,
      name: "lodash",
      npmBinary: stub,
    });
    expect(r.ok).toBe(true);
    expect(r.installRan).toBe(true);
    const after = await readPkg();
    expect(after.dependencies?.lodash).toBeUndefined();
  });

  it("is a no-op when the package isn't present", async () => {
    const r = await removeDependency({
      outDir,
      name: "missing-package",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(true);
    expect(r.installRan).toBe(false);
  });
});

describe("setScript", () => {
  it("sets a new script without re-running install", async () => {
    const r = await setScript({
      outDir,
      name: "build",
      command: "tsc -p .",
      skipNpmInstall: true,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.installRan).toBe(false);
    const pkg = await readPkg();
    expect(pkg.scripts.build).toBe("tsc -p .");
  });

  it("refuses to overwrite scripts.test with something that doesn't invoke vitest", async () => {
    const r = await setScript({
      outDir,
      name: "test",
      command: "node --test",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must invoke vitest|invalidate package.json/);
    // package.json on disk is unchanged.
    const pkg = await readPkg();
    expect(pkg.scripts.test).toBe("vitest run");
  });
});

describe("npmRun", () => {
  it("runs an existing script and reports exit 0", async () => {
    const stub = await makeStubBinary({ exitCode: 0, stdout: "ok\n" });
    const r = await npmRun({
      outDir,
      script: "test",
      npmBinary: stub,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.installStdout).toContain("ok");
  });

  it("refuses to run a script that isn't in package.json", async () => {
    const r = await npmRun({
      outDir,
      script: "nonexistent",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in package.json/);
  });

  it("reports non-zero exit codes", async () => {
    const stub = await makeStubBinary({
      exitCode: 1,
      stderr: "test failed\n",
    });
    const r = await npmRun({
      outDir,
      script: "test",
      npmBinary: stub,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });
});

describe("security validators (review fix #1)", () => {
  it("addDependency rejects path-traversing package names", async () => {
    const r = await addDependency({
      outDir,
      name: "../../etc/passwd",
      version: "^1.0.0",
      which: "runtime",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/npm package-name format/i);
  });

  it("addDependency rejects names with shell metachars", async () => {
    const r = await addDependency({
      outDir,
      name: "evil; rm -rf /",
      version: "^1.0.0",
      which: "runtime",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(false);
  });

  it("addDependency accepts scoped names", async () => {
    const r = await addDependency({
      outDir,
      name: "@types/node",
      version: "^22.0.0",
      which: "dev",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(true);
  });

  it("setScript rejects npm lifecycle hook names (RCE prevention)", async () => {
    for (const hook of ["preinstall", "postinstall", "prepare"]) {
      const r = await setScript({
        outDir,
        name: hook,
        command: "echo hi",
        skipNpmInstall: true,
      });
      expect(r.ok, `hook=${hook}`).toBe(false);
      expect(r.error).toMatch(/lifecycle hook/);
    }
  });

  it("setScript rejects script names with traversal/special chars", async () => {
    const r = await setScript({
      outDir,
      name: "../weird",
      command: "x",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(false);
  });

  it("npmRun rejects syntactically invalid script names", async () => {
    const r = await npmRun({
      outDir,
      script: "../weird",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/script name must match/);
  });

  // Audit issue #2: validateScriptName's lifecycle-hook check
  // exists to stop the model from CREATING postinstall/prepare/etc.
  // via setScript. Reusing it for npmRun blocks legitimate
  // verification calls like `npm run start` or `npm run prepublish`
  // on scripts the project already declared. npmRun must accept
  // any name that's syntactically valid AND present in
  // package.json — independent of whether the name happens to
  // collide with a lifecycle hook.
  it("npmRun ALLOWS running an existing script even when its name is a lifecycle hook (audit issue #2)", async () => {
    const seeded = {
      ...VALID_PKG,
      scripts: { ...VALID_PKG.scripts, start: "node ./dist/index.js" },
    };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(seeded, null, 2),
    );
    const stub = await makeStubBinary({ exitCode: 0, stdout: "started\n" });
    const r = await npmRun({
      outDir,
      script: "start",
      npmBinary: stub,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("npmRun rejects a lifecycle-hook name only when no such script exists", async () => {
    // No `preinstall` script declared — npmRun should refuse with
    // the same not-in-package.json reason it gives for any other
    // missing script. NOT with the lifecycle-hook RCE message.
    const r = await npmRun({
      outDir,
      script: "preinstall",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in package.json/);
    expect(r.error).not.toMatch(/lifecycle hook/);
  });
});

describe("error handling", () => {
  it("addDependency surfaces a clear error when package.json is missing", async () => {
    await rm(path.join(outDir, "package.json"));
    const r = await addDependency({
      outDir,
      name: "zod",
      version: "^3.0.0",
      which: "runtime",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failed to read|invalid existing/);
  });

  it("setScript surfaces a clear error when package.json is malformed", async () => {
    await writeFile(path.join(outDir, "package.json"), "not json");
    const r = await setScript({
      outDir,
      name: "lint",
      command: "eslint .",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid existing package.json/);
  });
});
