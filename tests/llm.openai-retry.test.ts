/**
 * Retry behavior of the OpenAI-compatible provider.
 *
 * The chat call wraps fetch with two abort sources:
 *   - Internal timeout (our setTimeout → controller.abort)
 *   - Caller-supplied opts.signal
 *
 * A *timeout-induced* abort should be retried with a fresh
 * AbortController — that's the failure mode that took down the
 * TodoMVC build (one slow GLM call → AbortError → uncaught crash).
 *
 * A *caller-induced* abort (opts.signal aborted) should propagate
 * immediately — the user asked us to stop.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOpenAIProvider } from "../src/llm/openai-provider.js";
import type { LLMConfig } from "../src/llm/types.js";

const baseConfig: LLMConfig = {
  model: "test-model",
  baseUrl: "https://example.invalid/v1",
  apiKey: "sk-test",
  providerHint: "test",
  // Short so the test doesn't have to wait minutes.
  timeoutMs: 50,
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeAbortError(): Error {
  const e = new Error("operation aborted");
  e.name = "AbortError";
  return e;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("openai-provider retry on AbortError", () => {
  it(
    "retries when the internal timeout aborts a fetch and succeeds on the next attempt",
    { timeout: 5_000 },
    async () => {
      let calls = 0;
      // First call hangs past the 50ms timeout (our controller fires).
      // Second call returns immediately.
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls++;
        if (calls === 1) {
          // Simulate the request stalling: wait for the abort signal.
          return await new Promise<Response>((_, reject) => {
            const sig = init?.signal;
            if (!sig) {
              reject(new Error("test setup error: no signal"));
              return;
            }
            sig.addEventListener("abort", () => reject(makeAbortError()), {
              once: true,
            });
          });
        }
        return jsonResponse({
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        });
      }) as typeof globalThis.fetch;

      const client = createOpenAIProvider(baseConfig);
      const result = await client.chat([{ role: "user", content: "ping" }]);
      expect(result.content).toBe("pong");
      expect(calls).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "propagates AbortError immediately when the caller's signal fires",
    { timeout: 5_000 },
    async () => {
      let calls = 0;
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls++;
        return await new Promise<Response>((_, reject) => {
          const sig = init?.signal;
          if (!sig) {
            reject(new Error("test setup error: no signal"));
            return;
          }
          sig.addEventListener("abort", () => reject(makeAbortError()), {
            once: true,
          });
        });
      }) as typeof globalThis.fetch;

      const callerCtl = new AbortController();
      const client = createOpenAIProvider({
        ...baseConfig,
        // Long timeout so it's clear the abort came from the caller.
        timeoutMs: 60_000,
      });
      // Fire the caller signal after a tick so the request is in-flight.
      setTimeout(() => callerCtl.abort(), 10);
      await expect(
        client.chat([{ role: "user", content: "ping" }], {
          signal: callerCtl.signal,
        }),
      ).rejects.toThrow(/abort/i);
      // Caller cancellations must NOT trigger fetch retries.
      expect(calls).toBe(1);
    },
  );

  it(
    "gives up after MAX_RETRIES timeouts and surfaces a meaningful error",
    { timeout: 10_000 },
    async () => {
      let calls = 0;
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls++;
        return await new Promise<Response>((_, reject) => {
          const sig = init?.signal;
          if (!sig) {
            reject(new Error("test setup error: no signal"));
            return;
          }
          sig.addEventListener("abort", () => reject(makeAbortError()), {
            once: true,
          });
        });
      }) as typeof globalThis.fetch;

      const client = createOpenAIProvider(baseConfig);
      await expect(
        client.chat([{ role: "user", content: "ping" }]),
      ).rejects.toThrow();
      // 1 initial + 3 retries = 4 attempts.
      expect(calls).toBeGreaterThanOrEqual(4);
    },
  );
});
