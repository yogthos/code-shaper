/**
 * Streaming + stall-watchdog tests for the OpenAI-compatible
 * provider's chatStream.
 *
 * The harness mocks fetch with a ReadableStream we control: tests
 * push SSE chunks at the cadence they want to simulate (fast,
 * trickle, stall, mid-response disconnect). This lets us cover the
 * stall-detect-and-retry path without going to network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOpenAIProvider } from "../src/llm/openai-provider.js";
import type { LLMConfig } from "../src/llm/types.js";

const baseConfig: LLMConfig = {
  model: "test-model",
  baseUrl: "https://example.invalid/v1",
  apiKey: "sk-test",
  providerHint: "test",
  // Total request timeout is generous; we want stall detection to
  // be the active mechanism, not request-timeout.
  timeoutMs: 30_000,
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Build a fake Response carrying an SSE body whose chunks are
 *  pushed at the caller's discretion. The signal arg, when supplied,
 *  wires the body to error out on abort — which is what the real
 *  fetch does and what consumeSSE relies on to break out of the
 *  read loop on stall/caller-abort. */
function makeSSEResponse(signal?: AbortSignal): {
  response: Response;
  push: (data: string) => void;
  end: () => void;
  abort: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  const errorOut = (): void => {
    try {
      const e = new Error("aborted");
      e.name = "AbortError";
      controller.error(e);
    } catch {
      /* already closed */
    }
  };
  if (signal) {
    if (signal.aborted) errorOut();
    else signal.addEventListener("abort", errorOut, { once: true });
  }
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push(data: string): void {
      try {
        controller.enqueue(enc.encode(data));
      } catch {
        /* may already be closed/errored */
      }
    },
    end(): void {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    abort: errorOut,
  };
}

describe("chatStream — happy path", () => {
  it(
    "emits each delta.content via onChunk and accumulates final content",
    { timeout: 5_000 },
    async () => {
      const fake = makeSSEResponse();
      globalThis.fetch = (async () => fake.response) as typeof globalThis.fetch;
      const chunks: string[] = [];
      const client = createOpenAIProvider(baseConfig);
      const promise = client.chatStream!(
        [{ role: "user", content: "hi" }],
        (t) => chunks.push(t),
      );
      // Push three deltas with newlines, then [DONE].
      fake.push(
        `data: {"choices":[{"delta":{"content":"hello "}}]}\n\n`,
      );
      fake.push(
        `data: {"choices":[{"delta":{"content":"world"}}]}\n\n`,
      );
      fake.push(
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      );
      fake.push(`data: [DONE]\n\n`);
      fake.end();
      const result = await promise;
      expect(result.content).toBe("hello world");
      expect(chunks).toEqual(["hello ", "world"]);
      expect(result.finishReason).toBe("stop");
    },
  );

  it("parses split chunks across SSE event boundaries", async () => {
    const fake = makeSSEResponse();
    globalThis.fetch = (async () => fake.response) as typeof globalThis.fetch;
    const client = createOpenAIProvider(baseConfig);
    const promise = client.chatStream!(
      [{ role: "user", content: "hi" }],
      () => {},
    );
    // Push in fragments that straddle SSE message boundaries.
    fake.push(`data: {"choices":[{"delta":{"content":"a"}}]}\n`);
    fake.push(`\ndata: {"choices":[{"delta":{"content":"b"`);
    fake.push(`}}]}\n\ndata: [DONE]\n\n`);
    fake.end();
    const result = await promise;
    expect(result.content).toBe("ab");
  });
});

describe("chatStream — stall watchdog", () => {
  it(
    "aborts and retries when no chunk arrives within stallTimeoutMs",
    { timeout: 10_000 },
    async () => {
      let calls = 0;
      const fakes: ReturnType<typeof makeSSEResponse>[] = [];
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls++;
        const f = makeSSEResponse(init?.signal ?? undefined);
        fakes.push(f);
        if (calls === 1) {
          // First attempt: send headers, then nothing → stall.
          // The stall timer should fire and abort.
        } else {
          // Second attempt: stream a real response.
          setTimeout(() => {
            f.push(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`);
            f.push(`data: [DONE]\n\n`);
            f.end();
          }, 10);
        }
        return f.response;
      }) as typeof globalThis.fetch;

      const client = createOpenAIProvider(baseConfig);
      const result = await client.chatStream!(
        [{ role: "user", content: "hi" }],
        () => {},
        { stallTimeoutMs: 200 },
      );
      expect(result.content).toBe("ok");
      expect(calls).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "doesn't abort when chunks arrive within the stall window",
    { timeout: 10_000 },
    async () => {
      const fake = makeSSEResponse();
      globalThis.fetch = (async () => fake.response) as typeof globalThis.fetch;
      const client = createOpenAIProvider(baseConfig);
      const promise = client.chatStream!(
        [{ role: "user", content: "hi" }],
        () => {},
        { stallTimeoutMs: 500 },
      );
      // Trickle chunks at 200ms intervals (below the 500ms stall
      // threshold). The total takes longer than stallTimeoutMs but
      // each individual gap is shorter.
      const tokens = ["one ", "two ", "three ", "four"];
      for (let i = 0; i < tokens.length; i++) {
        await new Promise((r) => setTimeout(r, 200));
        fake.push(
          `data: {"choices":[{"delta":{"content":${JSON.stringify(tokens[i])}}}]}\n\n`,
        );
      }
      fake.push(`data: [DONE]\n\n`);
      fake.end();
      const result = await promise;
      expect(result.content).toBe("one two three four");
    },
  );
});

describe("chatStream — caller-abort", () => {
  it(
    "propagates AbortError immediately when caller signal fires",
    { timeout: 5_000 },
    async () => {
      let calls = 0;
      globalThis.fetch = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        calls++;
        const f = makeSSEResponse(init?.signal ?? undefined);
        // Never push anything. The caller will abort.
        return f.response;
      }) as typeof globalThis.fetch;
      const callerCtl = new AbortController();
      const client = createOpenAIProvider(baseConfig);
      setTimeout(() => callerCtl.abort(), 50);
      await expect(
        client.chatStream!([{ role: "user", content: "hi" }], () => {}, {
          signal: callerCtl.signal,
          stallTimeoutMs: 60_000,
        }),
      ).rejects.toThrow(/abort/i);
      // Caller-aborts must not retry.
      expect(calls).toBe(1);
    },
  );
});

describe("chatStream — malformed chunks", () => {
  it("skips malformed JSON SSE events without aborting the stream", async () => {
    const fake = makeSSEResponse();
    globalThis.fetch = (async () => fake.response) as typeof globalThis.fetch;
    const client = createOpenAIProvider(baseConfig);
    const promise = client.chatStream!(
      [{ role: "user", content: "hi" }],
      () => {},
    );
    // First a valid chunk, then a garbage SSE event, then more valid.
    fake.push(`data: {"choices":[{"delta":{"content":"a"}}]}\n\n`);
    fake.push(`data: {not-json}\n\n`);
    fake.push(`data: {"choices":[{"delta":{"content":"b"}}]}\n\n`);
    fake.push(`data: [DONE]\n\n`);
    fake.end();
    const result = await promise;
    expect(result.content).toBe("ab");
  });
});
