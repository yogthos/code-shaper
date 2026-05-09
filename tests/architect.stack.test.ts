/**
 * Phase 0 stack proposal — package.json validation, materialization,
 * and npm install plumbing.
 *
 * The npm-install path is exercised via a mock binary that just
 * exits 0/non-zero based on the test's intent — we don't want
 * the suite to hit npm registry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parsePackageJson,
  proposeStack,
  runNpmInstall,
} from "../src/architect/stack.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "stack-out-"));
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function mockClient(responses: string[]): LLMClient {
  let i = 0;
  return {
    async chat(): Promise<LLMResponse> {
      const content = responses[i++] ?? "";
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
}

const VALID_PKG = {
  name: "todomvc-core",
  version: "0.1.0",
  description: "Tiny todo store",
  type: "module" as const,
  engines: { node: ">=20.0.0" },
  scripts: { test: "vitest run", dev: "tsx src/index.ts" },
  dependencies: {},
  devDependencies: {
    vitest: "^2.0.0",
    tsx: "^4.0.0",
    "@types/node": "^22.0.0",
  },
};

describe("parsePackageJson", () => {
  it("accepts a well-formed package.json", () => {
    const r = parsePackageJson(JSON.stringify(VALID_PKG));
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("todomvc-core");
      expect(r.value.scripts.test).toContain("vitest");
    }
  });

  it("requires npm package-name format (rejects PascalCase)", () => {
    const bad = { ...VALID_PKG, name: "TodoMVC" };
    const r = parsePackageJson(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/npm package-name format/);
  });

  it("accepts scoped names like @org/pkg (review fix #2)", () => {
    const r = parsePackageJson(
      JSON.stringify({ ...VALID_PKG, name: "@org/pkg" }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects names exceeding the 214-char npm cap (review fix #2)", () => {
    const long = "a".repeat(215);
    const r = parsePackageJson(JSON.stringify({ ...VALID_PKG, name: long }));
    expect(r.ok).toBe(false);
  });

  it("rejects unanchored versions like '0.1.0junk' (review fix #3)", () => {
    const r = parsePackageJson(
      JSON.stringify({ ...VALID_PKG, version: "0.1.0junk" }),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts pre-release versions like 1.0.0-rc.1 (review fix #3)", () => {
    const r = parsePackageJson(
      JSON.stringify({ ...VALID_PKG, version: "1.0.0-rc.1" }),
    );
    expect(r.ok).toBe(true);
  });

  it("requires type: module", () => {
    const bad = { ...VALID_PKG, type: "commonjs" };
    const r = parsePackageJson(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be "module"/);
  });

  it("requires scripts.test to invoke vitest", () => {
    const bad = {
      ...VALID_PKG,
      scripts: { test: "node --test", dev: "tsx src/index.ts" },
    };
    const r = parsePackageJson(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must invoke vitest/);
  });

  it("rejects non-string dep version values", () => {
    const bad = { ...VALID_PKG, dependencies: { lodash: 123 } };
    const r = parsePackageJson(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be a version string/);
  });

  it("strips markdown fences before parsing", () => {
    const fenced = "```json\n" + JSON.stringify(VALID_PKG) + "\n```";
    const r = parsePackageJson(fenced);
    expect(r.ok).toBe(true);
  });

  it("surfaces the JSON parse error on malformed input", () => {
    const r = parsePackageJson("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON parse error/);
  });
});

describe("proposeStack — happy path (skipNpmInstall)", () => {
  it("materializes package.json and skips npm install when flag is set", async () => {
    const client = mockClient([JSON.stringify(VALID_PKG)]);
    const r = await proposeStack(client, {
      description: "TodoMVC core",
      outDir,
      skipNpmInstall: true,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.installRan).toBe(false);
    const onDisk = await readFile(path.join(outDir, "package.json"), "utf-8");
    const parsed = JSON.parse(onDisk);
    expect(parsed.name).toBe("todomvc-core");
    expect(parsed.scripts.test).toContain("vitest");
  });

  it("retries on validation failure with prior response replayed", async () => {
    // First response is missing scripts.test; second is valid.
    const broken = { ...VALID_PKG, scripts: {} };
    const client = mockClient([
      JSON.stringify(broken),
      JSON.stringify(VALID_PKG),
    ]);
    const r = await proposeStack(client, {
      description: "x",
      outDir,
      skipNpmInstall: true,
      maxAttempts: 2,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("returns error after exhausting attempts on persistent invalid output", async () => {
    const broken = { name: "no-good", type: "commonjs" };
    const client = mockClient([JSON.stringify(broken), JSON.stringify(broken)]);
    const r = await proposeStack(client, {
      description: "x",
      outDir,
      skipNpmInstall: true,
      maxAttempts: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe("proposeStack — install validation loop", () => {
  // Stub npm binary that exits non-zero on the first call and 0
  // on subsequent calls. Tracks invocation count via a counter
  // file on disk so the test can verify install-failure retry.
  async function makeFailThenSucceedNpm(opts: {
    failStderr: string;
  }): Promise<{ stub: string; counterFile: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "fail-then-ok-"));
    const counterFile = path.join(dir, "count");
    await writeFile(counterFile, "0", "utf-8");
    const stub = path.join(dir, "stub-npm");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const counterFile = ${JSON.stringify(counterFile)};
const n = Number(fs.readFileSync(counterFile, "utf-8")) || 0;
fs.writeFileSync(counterFile, String(n + 1));
if (n === 0) {
  process.stderr.write(${JSON.stringify(opts.failStderr)});
  process.exit(1);
} else {
  process.stdout.write("added 5 packages\\n");
  process.exit(0);
}
`;
    await writeFile(stub, script, "utf-8");
    await chmod(stub, 0o755);
    return { stub, counterFile };
  }

  it("retries the proposal with install-error feedback when npm install fails, then succeeds", async () => {
    const { stub, counterFile } = await makeFailThenSucceedNpm({
      failStderr:
        "npm error gyp ERR! build error\nnpm error gyp ERR! cwd /tmp/foo/node_modules/better-sqlite3\nnpm error gyp ERR! not ok\n",
    });

    // First proposal picks "better-sqlite3"; second swaps to
    // "sql.js" (in response to install error feedback).
    const PKG_BAD = {
      ...VALID_PKG,
      dependencies: { "better-sqlite3": "^11.0.0" },
    };
    const PKG_GOOD = {
      ...VALID_PKG,
      dependencies: { "sql.js": "^1.11.0" },
    };
    const observedMessages: string[] = [];
    let i = 0;
    const client: LLMClient = {
      async chat(messages): Promise<LLMResponse> {
        observedMessages.push(messages[messages.length - 1]!.content);
        const responses = [JSON.stringify(PKG_BAD), JSON.stringify(PKG_GOOD)];
        return { content: responses[i++] ?? "", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await proposeStack(client, {
      description: "x",
      outDir,
      maxAttempts: 3,
      npmBinary: stub,
      npmInstallTimeoutMs: 5_000,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.installRan).toBe(true);
    expect(r.installOk).toBe(true);
    expect(r.attempts).toBe(2);
    // Counter file confirms npm was invoked twice (one fail, one
    // success).
    const callCount = Number(
      (await readFile(counterFile, "utf-8")).trim(),
    );
    expect(callCount).toBe(2);
    // The retry prompt must surface the install stderr to the model.
    expect(observedMessages[1]).toContain("npm install");
    expect(observedMessages[1]).toContain("gyp ERR");
    expect(observedMessages[1]).toMatch(/swap|alternative|broken/i);
    // On-disk package.json must be the GOOD one (the second
    // proposal's deps), not the broken first attempt.
    const onDisk = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf-8"),
    );
    expect(onDisk.dependencies).toHaveProperty("sql.js");
    expect(onDisk.dependencies).not.toHaveProperty("better-sqlite3");
  });

  it("returns ok=false with the install error when every attempt fails install", async () => {
    // Stub that always exits non-zero.
    const dir = await mkdtemp(path.join(tmpdir(), "always-fail-"));
    const stub = path.join(dir, "stub-npm");
    await writeFile(
      stub,
      `#!/usr/bin/env node\nprocess.stderr.write("install fail");\nprocess.exit(1);\n`,
      "utf-8",
    );
    await chmod(stub, 0o755);

    const PKG = {
      ...VALID_PKG,
      dependencies: { "broken-pkg": "^1.0.0" },
    };
    const client = mockClient([
      JSON.stringify(PKG),
      JSON.stringify(PKG),
      JSON.stringify(PKG),
    ]);
    const r = await proposeStack(client, {
      description: "x",
      outDir,
      maxAttempts: 2,
      npmBinary: stub,
      npmInstallTimeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.installRan).toBe(true);
    expect(r.installOk).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.packageJson).toBeDefined();
    expect(r.error).toContain("install fail");
  });
});

describe("proposeStack — extend mode", () => {
  it("loads existing package.json and surfaces it in the prompt", async () => {
    const existing = {
      name: "existing-thing",
      version: "0.0.7",
      type: "module" as const,
      scripts: { test: "vitest run" },
      dependencies: { "left-pad": "^1.3.0" },
    };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(existing, null, 2),
    );

    let observedUserPrompt: string | undefined;
    const client: LLMClient = {
      async chat(messages): Promise<LLMResponse> {
        observedUserPrompt = messages[1]!.content;
        return { content: JSON.stringify(VALID_PKG), finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await proposeStack(client, {
      description: "extend it",
      outDir,
      mode: "extend",
      skipNpmInstall: true,
    });
    expect(r.ok).toBe(true);
    expect(observedUserPrompt).toBeDefined();
    expect(observedUserPrompt!).toContain("Existing package.json");
    expect(observedUserPrompt!).toContain("left-pad");
  });
});

describe("runNpmInstall — happy + sad paths", () => {
  async function makeStubBinary(behavior: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
    sleepMs?: number;
  }): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "stub-bin-"));
    const stub = path.join(dir, "stub-npm");
    const sleep = behavior.sleepMs ?? 0;
    const stdout = behavior.stdout ?? "";
    const stderr = behavior.stderr ?? "";
    const script = `#!/usr/bin/env node
const sleep = ${sleep};
${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ""}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
if (sleep > 0) {
  setTimeout(() => process.exit(${behavior.exitCode}), sleep);
} else {
  process.exit(${behavior.exitCode});
}
`;
    await writeFile(stub, script, "utf-8");
    await chmod(stub, 0o755);
    return stub;
  }

  it("returns ok when the binary exits 0", async () => {
    const stub = await makeStubBinary({
      exitCode: 0,
      stdout: "added 5 packages\n",
    });
    const r = await runNpmInstall({
      cwd: outDir,
      binary: stub,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("added 5 packages");
  });

  it("returns ok=false on non-zero exit", async () => {
    const stub = await makeStubBinary({
      exitCode: 1,
      stderr: "ENOTFOUND registry.npmjs.org\n",
    });
    const r = await runNpmInstall({
      cwd: outDir,
      binary: stub,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ENOTFOUND");
  });

  it("kills + reports timedOut when the binary hangs past timeoutMs", async () => {
    const stub = await makeStubBinary({
      exitCode: 0,
      sleepMs: 60_000,
    });
    const r = await runNpmInstall({
      cwd: outDir,
      binary: stub,
      timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toContain("timed out after 200ms");
  }, 10_000);

  it("returns ok=false with a message when the binary doesn't exist", async () => {
    const r = await runNpmInstall({
      cwd: outDir,
      binary: "/no/such/binary",
      timeoutMs: 1_000,
    });
    expect(r.ok).toBe(false);
    // Either spawn-error or close-with-non-zero; both report a failure.
    expect(r.exitCode).not.toBe(0);
  });
});
