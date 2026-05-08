/**
 * env-fix tool-call author — Stage C of feature #5.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyEnvFixViaTools } from "../src/implementor/env-fix.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

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
  outDir = await mkdtemp(path.join(tmpdir(), "envfix-"));
  await writeFile(
    path.join(outDir, "package.json"),
    JSON.stringify(VALID_PKG, null, 2),
  );
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function toolCallClient(
  toolName: string,
  args: Record<string, unknown>,
): LLMClient {
  return {
    async chat(): Promise<LLMResponse> {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          },
        ],
      };
    },
    async listModels() {
      return ["mock"];
    },
  };
}

const baseInput = {
  projectDir: "" /* set per test */,
  envPatchHint: "the test imports zod but it isn't in package.json",
  failureMessage: "Cannot find module 'zod'",
  bodySource: "return parse(input);",
  testSource: 'import { z } from "zod"; ...',
  skipNpmInstall: true,
};

describe("applyEnvFixViaTools — happy paths", () => {
  it("applies add_dependency and writes package.json", async () => {
    const client = toolCallClient("add_dependency", {
      name: "zod",
      version: "^3.22.0",
      which: "runtime",
    });
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.tool).toBe("add_dependency");
    const pkg = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf-8"),
    );
    expect(pkg.dependencies.zod).toBe("^3.22.0");
  });

  it("applies remove_dependency", async () => {
    // Pre-seed a dep to remove.
    const seeded = {
      ...VALID_PKG,
      dependencies: { lodash: "^4.0.0" },
    };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(seeded, null, 2),
    );
    const client = toolCallClient("remove_dependency", { name: "lodash" });
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(true);
    const pkg = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf-8"),
    );
    expect(pkg.dependencies.lodash).toBeUndefined();
  });

  it("applies set_script", async () => {
    const client = toolCallClient("set_script", {
      name: "build",
      command: "tsc -p .",
    });
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(true);
    const pkg = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf-8"),
    );
    expect(pkg.scripts.build).toBe("tsc -p .");
  });
});

describe("applyEnvFixViaTools — error paths", () => {
  it("rejects when the model emits no tool call", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: "I don't know how", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not emit/);
  });

  it("rejects unknown tool names", async () => {
    const client = toolCallClient("totally_made_up", {});
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown tool/);
  });

  it("propagates underlying npm-tool errors (set_script breaking vitest invariant)", async () => {
    // Tool call attempts to overwrite scripts.test with non-vitest.
    const client = toolCallClient("set_script", {
      name: "test",
      command: "node --test",
    });
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vitest|invalidate/);
  });

  it("rejects malformed JSON arguments", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "x",
              type: "function",
              function: {
                name: "add_dependency",
                arguments: "{ broken",
              },
            },
          ],
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not parse/);
  });

  it("rejects bad arg types", async () => {
    const client = toolCallClient("add_dependency", {
      name: "zod",
      version: "^3.0.0",
      which: "wrong-bucket",
    });
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/runtime.*dev/);
  });
});
