/**
 * Failure-diagnosis MV tests.
 *
 * Covers the §5.3 + Algorithm 4 spec:
 *   - 5 rounds (default), majority wins
 *   - test_brittleness carries a testRewriteHint
 *   - environment carries an envPatchHint
 *   - rounds run in parallel
 *   - tiebreaks favor "implementation"
 *   - malformed responses don't sink the diagnosis
 */

import { describe, it, expect } from "vitest";
import { diagnoseFailure } from "../src/architect/diagnose-failure.js";
import type {
  FailureCategory,
  FailureDiagnosisResult,
} from "../src/architect/diagnose-failure.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function mockClient(
  responseFor: (callIndex: number) => string,
): { client: LLMClient; calls: number } {
  const state = { calls: 0 };
  const client: LLMClient = {
    async chat(): Promise<LLMResponse> {
      const idx = state.calls++;
      return { content: responseFor(idx), finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return {
    get client() {
      return client;
    },
    get calls() {
      return state.calls;
    },
  } as { client: LLMClient; calls: number };
}

const sampleInput = {
  description: "f returns x doubled.",
  failureMessage:
    "AssertionError: expected 4 to equal 6\n at test.ts:5:10",
  testSource: 'expect(f(2)).toBe(6);',
  bodySource: "function f(x) { return x * 2; }",
};

describe("diagnoseFailure — prior-attempts memory (audit gap #5)", () => {
  it("threads priorAttempts into the user prompt", async () => {
    let observedPrompt: string | undefined;
    const client: LLMClient = {
      async chat(messages): Promise<LLMResponse> {
        observedPrompt = messages[1]!.content;
        return {
          content: json({ category: "implementation", reasoning: "x" }),
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    await diagnoseFailure(client, {
      ...sampleInput,
      rounds: 1,
      priorAttempts: [
        {
          category: "environment",
          remediation: "add_dependency better-sqlite3 → install failed: V8 API change",
          outcome: "no_progress",
        },
      ],
    });
    expect(observedPrompt).toContain("Prior diagnostic attempts on this leaf");
    expect(observedPrompt).toContain("better-sqlite3");
    expect(observedPrompt).toContain("install failed");
  });
});

describe("diagnoseFailure — round error surfacing (audit gap #19)", () => {
  it("populates roundErrors when rounds throw or fail to parse", async () => {
    let i = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        i++;
        if (i === 1) {
          throw new Error("rate limit");
        }
        if (i === 2) {
          return { content: "not json", finishReason: "stop" };
        }
        return {
          content: json({ category: "implementation", reasoning: "ok" }),
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await diagnoseFailure(client, { ...sampleInput, rounds: 3 });
    expect(r.fulfilledRounds).toBe(1);
    expect(r.roundErrors.length).toBe(2);
    expect(r.roundErrors.some((e) => e.includes("rate limit"))).toBe(true);
    expect(r.roundErrors.some((e) => e.includes("unparseable"))).toBe(true);
  });

  it("returns category=implementation but with full roundErrors when ALL rounds fail", async () => {
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        throw new Error("provider down");
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await diagnoseFailure(client, { ...sampleInput, rounds: 3 });
    expect(r.category).toBe("implementation");
    expect(r.fulfilledRounds).toBe(0);
    expect(r.roundErrors.length).toBe(3);
    // Caller can now distinguish "diagnostic confidently said
    // implementation" (fulfilledRounds=3, roundErrors=0) from
    // "all rounds errored, defaulted" (fulfilledRounds=0,
    // roundErrors=3).
  });
});

describe("diagnoseFailure — vote tallying", () => {
  it("returns the majority category over 5 rounds", async () => {
    const responses = [
      json({ category: "implementation", reasoning: "body wrong" }),
      json({ category: "implementation", reasoning: "body wrong" }),
      json({ category: "implementation", reasoning: "body wrong" }),
      json({
        category: "test_brittleness",
        reasoning: "test wrong",
        testRewriteHint: "fix matcher",
      }),
      json({ category: "environment", reasoning: "missing dep", envPatchHint: "x" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r: FailureDiagnosisResult = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("implementation");
    expect(r.votes.implementation).toBe(3);
    expect(r.votes.test_brittleness).toBe(1);
    expect(r.votes.environment).toBe(1);
    expect(r.fulfilledRounds).toBe(5);
  });

  it("breaks ties in favor of implementation (plurality alone insufficient)", async () => {
    const responses = [
      json({ category: "test_brittleness", reasoning: "x", testRewriteHint: "y" }),
      json({ category: "test_brittleness", reasoning: "x", testRewriteHint: "y" }),
      json({ category: "implementation", reasoning: "x" }),
      json({ category: "implementation", reasoning: "x" }),
      json({ category: "environment", reasoning: "x", envPatchHint: "z" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    // 2 brittleness vs 2 impl vs 1 env. The strict-majority rule
    // requires brittleness > impl + env (i.e., 2 > 3) which is
    // false; brittleness loses. Falls back to implementation.
    expect(r.category).toBe("implementation");
  });

  it("requires strict majority over the conservative default to choose test_brittleness", async () => {
    // 3 brittleness, 1 impl, 1 env: 3 > 1+1 = 2, so brittleness wins.
    const responses = [
      json({
        category: "test_brittleness",
        reasoning: "x",
        testRewriteHint: "use toEqual",
      }),
      json({
        category: "test_brittleness",
        reasoning: "x",
        testRewriteHint: "use toEqual",
      }),
      json({
        category: "test_brittleness",
        reasoning: "x",
        testRewriteHint: "use toEqual",
      }),
      json({ category: "implementation", reasoning: "x" }),
      json({ category: "environment", reasoning: "x", envPatchHint: "y" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("test_brittleness");
  });

  it("does NOT pick test_brittleness on plurality alone (2-1-2 split)", async () => {
    // 2 brittleness, 1 impl, 2 env. Brittleness has plurality (tied
    // with env) but 2 is not > 1+2 = 3, so brittleness loses. Env
    // similarly not > 2+1 = 3, so env loses. Both fail strict-
    // majority test → conservative default fires.
    const responses = [
      json({
        category: "test_brittleness",
        reasoning: "x",
        testRewriteHint: "y",
      }),
      json({
        category: "test_brittleness",
        reasoning: "x",
        testRewriteHint: "y",
      }),
      json({ category: "implementation", reasoning: "x" }),
      json({ category: "environment", reasoning: "x", envPatchHint: "y" }),
      json({ category: "environment", reasoning: "x", envPatchHint: "y" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("implementation");
  });

  it("captures testRewriteHint when test_brittleness wins", async () => {
    const responses = [
      json({
        category: "test_brittleness",
        reasoning: "matcher wrong",
        testRewriteHint: "use toEqual instead of toBe",
      }),
      json({
        category: "test_brittleness",
        reasoning: "matcher wrong",
        testRewriteHint: "use toEqual",
      }),
      json({
        category: "test_brittleness",
        reasoning: "matcher wrong",
        testRewriteHint: "use toEqual",
      }),
      json({ category: "implementation", reasoning: "x" }),
      json({ category: "implementation", reasoning: "x" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("test_brittleness");
    expect(r.testRewriteHint).toBe("use toEqual instead of toBe");
  });

  it("captures envPatchHint when environment wins", async () => {
    const responses = [
      json({ category: "environment", reasoning: "module not found", envPatchHint: "add zod" }),
      json({ category: "environment", reasoning: "module not found", envPatchHint: "add zod@3" }),
      json({ category: "environment", reasoning: "module not found", envPatchHint: "add zod" }),
      json({ category: "implementation", reasoning: "x" }),
      json({ category: "implementation", reasoning: "x" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("environment");
    expect(r.envPatchHint).toBe("add zod");
  });
});

describe("diagnoseFailure — robustness", () => {
  it("survives malformed JSON in some rounds", async () => {
    const responses = [
      "not valid json",
      json({ category: "implementation", reasoning: "ok" }),
      "{ broken",
      json({ category: "implementation", reasoning: "ok" }),
      json({ category: "implementation", reasoning: "ok" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("implementation");
    expect(r.fulfilledRounds).toBe(3);
    expect(r.votes.implementation).toBe(3);
  });

  it("defaults to implementation when every round fails to parse", async () => {
    const { client } = mockClient(() => "garbage");
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("implementation");
    expect(r.fulfilledRounds).toBe(0);
  });

  it("ignores stale testRewriteHint when implementation wins", async () => {
    const responses = [
      json({
        category: "test_brittleness",
        reasoning: "x",
        testRewriteHint: "ignore me",
      }),
      json({ category: "implementation", reasoning: "y" }),
      json({ category: "implementation", reasoning: "y" }),
      json({ category: "implementation", reasoning: "y" }),
      json({ category: "implementation", reasoning: "y" }),
    ];
    const { client } = mockClient((i) => responses[i]!);
    const r = await diagnoseFailure(client, sampleInput);
    expect(r.category).toBe("implementation");
    expect(r.testRewriteHint).toBeUndefined();
  });
});

describe("diagnoseFailure — concurrency + rounds override", () => {
  it("runs rounds in parallel (calls fan out before any awaits)", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return {
          content: json({ category: "implementation", reasoning: "x" }),
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    await diagnoseFailure(client, sampleInput);
    // All 5 rounds should be in flight together.
    expect(maxInflight).toBe(5);
  });

  it("honors a custom rounds value", async () => {
    let calls = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        calls++;
        return {
          content: json({ category: "implementation", reasoning: "x" }),
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    await diagnoseFailure(client, { ...sampleInput, rounds: 3 });
    expect(calls).toBe(3);
  });
});

function json(obj: unknown): string {
  return JSON.stringify(obj);
}

// Type re-export to silence unused-import warnings.
const _checkType: FailureCategory = "implementation";
void _checkType;
