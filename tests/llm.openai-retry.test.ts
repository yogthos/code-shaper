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

  // Body-read stall: GLM (and other providers occasionally) sends
  // headers + connection-keepalive but never finishes streaming
  // the JSON body. The original fetchWithRetry cleared its
  // AbortController timer once `fetch` resolved with the headers,
  // leaving `await response.json()` unguarded — the call hung
  // forever. The fix: keep an abort guard alive until the body is
  // read.
  it(
    "aborts and retries when the response body stalls mid-stream",
    { timeout: 5_000 },
    async () => {
      let calls = 0;
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls++;
        if (calls === 1) {
          // Headers come through, but the body stream never
          // resolves. Wire it through the AbortSignal so a proper
          // abort kills the read.
          const sig = init?.signal;
          const stream = new ReadableStream({
            start(controller) {
              if (!sig) return;
              sig.addEventListener(
                "abort",
                () => {
                  controller.error(makeAbortError());
                },
                { once: true },
              );
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return jsonResponse({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        });
      }) as typeof globalThis.fetch;

      const client = createOpenAIProvider(baseConfig);
      const r = await client.chat([{ role: "user", content: "ping" }]);
      expect(r.content).toBe("hi");
      // First call stalled, second returned immediately.
      expect(calls).toBe(2);
    },
  );

  // Some Node 26+ native errors define `message` as a getter
  // only. Mutating it throws "Cannot set property message of
  // which has only a getter" — which previously took down the
  // orchestrator (interface phase 5).
  it(
    "wraps errors with read-only message getters via a NEW Error rather than mutating",
    { timeout: 20_000 },
    async () => {
      // Construct an Error subclass whose `message` is a getter
      // with no setter — same shape as the offending native
      // errors.
      class GetterOnlyError extends Error {
        constructor(private readonly _msg: string) {
          super();
        }
        override get message(): string {
          return this._msg;
        }
      }
      globalThis.fetch = (async () => {
        throw new GetterOnlyError("upstream failure");
      }) as typeof globalThis.fetch;
      const client = createOpenAIProvider(baseConfig);
      // The provider should re-throw with provider context but
      // without mutating the original error.
      await expect(
        client.chat([{ role: "user", content: "ping" }]),
      ).rejects.toThrow(/test-model.*upstream failure/);
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
