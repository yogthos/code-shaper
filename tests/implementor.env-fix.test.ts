/**
 * env-fix tool-call author — Stage C of feature #5.
 *
 * Multi-turn (audit gap #4 + #16): the model can call multiple
 * tools in sequence, with tool results sent back as tool messages,
 * and signals end-of-session via Terminate. Tool refusals (bad
 * args, lifecycle hook names, etc.) become tool-error messages so
 * the model gets a chance to retry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyEnvFixViaTools } from "../src/implementor/env-fix.js";
import type { ChatMessage, LLMClient, LLMResponse } from "../src/llm/types.js";

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

interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
  /** Override JSON.stringify(args) — used to inject malformed JSON. */
  rawArgs?: string;
}

/** Returns the scripted call sequence; auto-Terminates after the
 *  scripted calls run out so the loop converges. */
function scriptedClient(
  calls: ScriptedCall[],
): LLMClient & { messages: ChatMessage[][] } {
  let i = 0;
  const messages: ChatMessage[][] = [];
  return {
    messages,
    async chat(msgs: ChatMessage[]): Promise<LLMResponse> {
      messages.push([...msgs]);
      const c =
        calls[i] ??
        ({ name: "Terminate", args: { reason: "scripted-end" } } as ScriptedCall);
      i++;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call_${i}`,
            type: "function",
            function: {
              name: c.name,
              arguments: c.rawArgs ?? JSON.stringify(c.args),
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
  // Tight budget so error-path tests converge quickly.
  maxIterations: 4,
};

describe("applyEnvFixViaTools — happy paths (multi-turn)", () => {
  it("applies add_dependency, then Terminates", async () => {
    const client = scriptedClient([
      {
        name: "add_dependency",
        args: { name: "zod", version: "^3.22.0", which: "runtime" },
      },
      { name: "Terminate", args: { reason: "added" } },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.terminatedExplicitly).toBe(true);
    expect(r.trail).toHaveLength(2);
    expect(r.trail[0]!.tool).toBe("add_dependency");
    expect(r.trail[1]!.tool).toBe("Terminate");
    const pkg = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf-8"),
    );
    expect(pkg.dependencies.zod).toBe("^3.22.0");
  });

  // Audit issue #11: npm_run is a probe — installRan/installOk
  // are meaningless for it. The serialized tool result must NOT
  // include those fields, otherwise the model reads
  // "ok:true, installRan:false, installOk:false" on a clean
  // build and treats it as a failure signal.
  it("strips installRan/installOk from npm_run tool result (audit issue #11)", async () => {
    // Pre-seed a `build` script so npmRun has something to invoke.
    const seeded = {
      name: "test-app",
      version: "0.1.0",
      type: "module" as const,
      scripts: { test: "vitest run", build: "echo ok" },
      dependencies: {},
      devDependencies: { vitest: "^2.0.0" },
    };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(seeded, null, 2),
    );
    const client = scriptedClient([
      { name: "npm_run", args: { script: "build" } },
      { name: "Terminate", args: {} },
    ]);
    await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    // Inspect the second turn's tool message — that's the result
    // sent back to the model after npm_run.
    const secondTurnMessages = client.messages[1]!;
    const toolMsg = secondTurnMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg!.content) as Record<string, unknown>;
    expect(parsed["installRan"]).toBeUndefined();
    expect(parsed["installOk"]).toBeUndefined();
    // exitCode must still be there for the model to verify the
    // build succeeded.
    expect(parsed["exitCode"]).toBe(0);
    expect(parsed["ok"]).toBe(true);
  });

  it("threads tool result back to next turn (audit gap #16: npm_run output)", async () => {
    // First call: set_script. Second turn the model should see
    // the result. Third: Terminate.
    const client = scriptedClient([
      { name: "set_script", args: { name: "build", command: "tsc -p ." } },
      { name: "Terminate", args: {} },
    ]);
    await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    // The second chat call's message list should contain a tool
    // message with the set_script result — that's the proof the
    // model can see what happened.
    const secondTurnMessages = client.messages[1]!;
    const toolMsg = secondTurnMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parsed = JSON.parse(toolMsg!.content) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
  });

  it("applies remove_dependency", async () => {
    const seeded = { ...VALID_PKG, dependencies: { lodash: "^4.0.0" } };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(seeded, null, 2),
    );
    const client = scriptedClient([
      { name: "remove_dependency", args: { name: "lodash" } },
      { name: "Terminate", args: {} },
    ]);
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

  it("multi-step: remove broken binding then add alternative", async () => {
    const seeded = {
      ...VALID_PKG,
      dependencies: { "better-sqlite3": "^11.0.0" },
    };
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(seeded, null, 2),
    );
    const client = scriptedClient([
      { name: "remove_dependency", args: { name: "better-sqlite3" } },
      {
        name: "add_dependency",
        args: { name: "libsql", version: "^0.4.0", which: "runtime" },
      },
      { name: "Terminate", args: { reason: "swapped binding" } },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(true);
    expect(r.trail.map((e) => e.tool)).toEqual([
      "remove_dependency",
      "add_dependency",
      "Terminate",
    ]);
    const pkg = JSON.parse(
      await readFile(path.join(outDir, "package.json"), "utf-8"),
    );
    expect(pkg.dependencies["better-sqlite3"]).toBeUndefined();
    expect(pkg.dependencies.libsql).toBe("^0.4.0");
  });
});

describe("applyEnvFixViaTools — error paths (recovery via tool messages)", () => {
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

  it("recovers from an unknown tool name on retry (audit gap #4)", async () => {
    const client = scriptedClient([
      { name: "totally_made_up", args: {} },
      // Model sees the tool-error message and corrects:
      {
        name: "add_dependency",
        args: { name: "zod", version: "^3.22.0", which: "runtime" },
      },
      { name: "Terminate", args: {} },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(true);
    // First trail entry records the rejection.
    expect(r.trail[0]!.error).toMatch(/unknown tool/);
    // Audit issue #5: pre-apply rejection labelled `_invalid`
    // (not "Terminate") so the trail accurately reflects what
    // happened.
    expect(r.trail[0]!.tool).toBe("_invalid");
    // Second trail entry is the successful retry.
    expect(r.trail[1]!.tool).toBe("add_dependency");
  });

  it("propagates underlying npm-tool errors via the trail (set_script breaking vitest invariant)", async () => {
    const client = scriptedClient([
      { name: "set_script", args: { name: "test", command: "node --test" } },
      { name: "Terminate", args: { reason: "giving up" } },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    // Trail records the npm-tool refusal; ok stays false because
    // no real mutation landed.
    expect(r.ok).toBe(false);
    expect(r.terminatedExplicitly).toBe(true);
    const setScriptEntry = r.trail.find((e) => e.tool === "set_script");
    expect(setScriptEntry?.npmResult?.ok).toBe(false);
    expect(setScriptEntry?.npmResult?.error).toMatch(/vitest|invalidate/);
  });

  it("recovers from malformed JSON arguments on retry", async () => {
    const client = scriptedClient([
      // First: garbage JSON.
      { name: "add_dependency", args: {}, rawArgs: "{ broken" },
      // Retry with valid args.
      {
        name: "add_dependency",
        args: { name: "zod", version: "^3.0.0", which: "runtime" },
      },
      { name: "Terminate", args: {} },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(true);
    expect(r.trail[0]!.error).toMatch(/JSON parse/);
    expect(r.trail[1]!.npmResult?.ok).toBe(true);
  });

  it("recovers from bad arg types on retry", async () => {
    const client = scriptedClient([
      {
        name: "add_dependency",
        args: { name: "zod", version: "^3.0.0", which: "wrong-bucket" },
      },
      {
        name: "add_dependency",
        args: { name: "zod", version: "^3.0.0", which: "runtime" },
      },
      { name: "Terminate", args: {} },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.ok).toBe(true);
    expect(r.trail[0]!.npmResult?.ok).toBe(false);
    expect(r.trail[0]!.npmResult?.error).toMatch(/which/);
    // Audit issue #13: error names the offending arg AND its
    // actual value so the model can see what it sent.
    expect(r.trail[0]!.npmResult?.error).toMatch(/wrong-bucket/);
  });

  // Audit issue #13: arg-type errors must echo the offending
  // value's type and a snippet, not a generic "must be strings".
  it("echoes the offending arg name and value snippet on type errors", async () => {
    const client = scriptedClient([
      // version is null instead of a string.
      {
        name: "add_dependency",
        args: { name: "zod", version: null, which: "runtime" },
      },
      { name: "Terminate", args: { reason: "bailing" } },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    const trail0 = r.trail[0]!;
    expect(trail0.npmResult?.ok).toBe(false);
    expect(trail0.npmResult?.error).toMatch(/version/);
    expect(trail0.npmResult?.error).toMatch(/null|object/i);
  });

  // Audit issue #10: Terminate must not overwrite lastTool /
  // lastArgs / lastNpmResult — they should describe the most
  // recent SUBSTANTIVE step (e.g., the add_dependency that
  // mutated disk).
  it("preserves lastTool/lastArgs from the last substantive step on Terminate", async () => {
    const client = scriptedClient([
      {
        name: "add_dependency",
        args: { name: "zod", version: "^3.22.0", which: "runtime" },
      },
      { name: "Terminate", args: { reason: "added" } },
    ]);
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(r.terminatedExplicitly).toBe(true);
    // The "last" reflects the add_dependency, not the Terminate.
    expect(r.lastTool).toBe("add_dependency");
    expect((r.lastArgs as Record<string, unknown>).name).toBe("zod");
    expect(r.lastNpmResult?.ok).toBe(true);
  });

  // Audit issue #6: chat-failure on iteration 1 must report
  // iterations: 1, not 0. Off-by-one was breaking telemetry and
  // summarizeEnvFix's iteration counter.
  it("reports iterations: 1 when chat throws on the first iteration", async () => {
    let calls = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        calls++;
        throw new Error("upstream 503");
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await applyEnvFixViaTools(client, {
      ...baseInput,
      projectDir: outDir,
    });
    expect(calls).toBe(1);
    expect(r.iterations).toBe(1);
    expect(r.error).toMatch(/upstream 503/);
  });

  it("exhausts iteration budget when the model never Terminates", async () => {
    // Fixed client always returns the same dud call.
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "x",
              type: "function",
              function: { name: "totally_made_up", arguments: "{}" },
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
      maxIterations: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.iterations).toBe(3);
    expect(r.error).toMatch(/exhausted 3 iterations/);
  });
});
