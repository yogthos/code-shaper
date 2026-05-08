/**
 * OpenAI-compatible provider. Works with any service that speaks
 * /chat/completions: OpenAI, DeepSeek, GLM (Zhipu), OpenRouter, Together.
 *
 * Adapted from rlm-sandbox/src/rlm/providers/openai.ts — kept minimal
 * for Phase 0 (no streaming yet; we'll bring it back when we need it).
 */

import type {
  LLMConfig,
  LLMClient,
  ChatMessage,
  LLMResponse,
  ChatOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

interface OpenAIChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string };
}

/**
 * Per-attempt fetch with a fresh AbortController each try.
 *
 * Two abort sources are distinguished:
 *   - Internal timeout (`timeoutMs` → controller.abort): retried with
 *     a fresh controller. This is the recoverable case — a slow
 *     upstream API hang shouldn't take down the whole pipeline.
 *   - Caller-supplied `callerSignal`: propagated immediately. The
 *     caller asked us to stop; honor it without retries.
 *
 * 4xx responses bypass retry entirely (caller's problem); 5xx and
 * timeout-aborts both retry with backoff. After MAX_RETRIES, the last
 * error is rethrown.
 */
async function fetchWithRetry(
  url: string,
  baseInit: Omit<RequestInit, "signal">,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (callerSignal?.aborted) {
      const e = new Error("operation aborted by caller");
      e.name = "AbortError";
      throw e;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
      onCallerAbort = () => controller.abort();
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const response = await fetch(url, {
        ...baseInit,
        signal: controller.signal,
      });
      // 2xx → success; 4xx → caller's problem (auth, bad request, etc.) and
      // retrying won't change the answer, so return the response as-is and
      // let `chat()` parse the error body. 5xx falls through to retry.
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // Caller-initiated abort: bubble up immediately, no retry.
      if (lastError.name === "AbortError" && callerSignal?.aborted) {
        throw lastError;
      }
      // Internal timeout abort: fall through to retry with a fresh
      // controller. This is the GLM-stalled-out failure mode that
      // previously crashed the whole pipeline.
    } finally {
      clearTimeout(timer);
      if (onCallerAbort && callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
    if (attempt < maxRetries) {
      const delay =
        INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt) +
        Math.random() * INITIAL_RETRY_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

/**
 * Streaming impl with retry-on-stall + retry-on-network-error.
 *
 * Two timers per attempt:
 *   - Total timeout: hard ceiling on the whole request
 *   - Stall timeout: reset on every chunk; if no chunk arrives for
 *     `stallTimeoutMs`, abort + retry. Catches the case where the
 *     API sent headers but stopped emitting tokens — the original
 *     plain-fetch path can't tell that apart from "still working."
 *
 * Retries follow the same policy as fetchWithRetry: caller-aborts
 * propagate; everything else gets up to MAX_RETRIES with backoff.
 *
 * Accumulates `delta.content` from each `data: {…}` SSE event into
 * the returned `content`. Tool-call deltas are accumulated into the
 * returned `toolCalls`. `[DONE]` ends the stream.
 */
async function chatStreamingImpl(
  baseUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  totalTimeoutMs: number,
  stallTimeoutMs: number,
  callerSignal: AbortSignal | undefined,
  onChunk: (token: string) => void,
  providerHint: string | undefined,
  model: string,
): Promise<LLMResponse> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (callerSignal?.aborted) {
      const e = new Error("operation aborted by caller");
      e.name = "AbortError";
      throw e;
    }
    const controller = new AbortController();
    let resolved = false;
    const totalTimer = setTimeout(() => {
      if (!resolved) controller.abort();
    }, totalTimeoutMs);
    let stallTimer: NodeJS.Timeout | null = null;
    const resetStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!resolved) controller.abort();
      }, stallTimeoutMs);
    };
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
      onCallerAbort = () => controller.abort();
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status >= 400 && response.status < 500) {
        // 4xx is the caller's problem; don't retry.
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          /* ignore */
        }
        throw new Error(
          `${providerHint ?? "openai"} API error: ${response.status} ${response.statusText}${
            errorBody ? ` - ${errorBody.slice(0, 500)}` : ""
          }`,
        );
      }
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        // Fall through to retry.
      } else if (response.body === null) {
        lastError = new Error("response body missing");
      } else {
        resetStall();
        const result = await consumeSSE(response.body, onChunk, resetStall);
        resolved = true;
        return {
          content: result.content,
          finishReason: result.finishReason ?? "stop",
          toolCalls:
            result.toolCalls && result.toolCalls.length > 0
              ? result.toolCalls
              : undefined,
          ...(result.usage !== null ? { usage: result.usage } : {}),
        };
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (lastError.name === "AbortError" && callerSignal?.aborted) {
        throw lastError;
      }
      // Internal abort (total timeout OR stall) and network errors
      // both fall through to retry. providerHint surfaces in the
      // final error message via the caller's wrapper.
    } finally {
      clearTimeout(totalTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (onCallerAbort && callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
    if (attempt < MAX_RETRIES) {
      const delay =
        INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt) +
        Math.random() * INITIAL_RETRY_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw (
    lastError ??
    new Error(`${providerHint ?? "openai"}/${model}: stream failed after retries`)
  );
}

interface SSEResult {
  content: string;
  finishReason: string | null;
  toolCalls: LLMResponse["toolCalls"];
  usage: LLMResponse["usage"] | null;
}

/** Read SSE chunks from the response body, parse `data: {...}`
 *  events, accumulate content + tool deltas, surface progress to
 *  `onChunk`, and reset the stall timer on every chunk we see. */
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onChunk: (token: string) => void,
  resetStall: () => void,
): Promise<SSEResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  const toolCallAccum = new Map<
    number,
    { id: string; name: string; argsBuffer: string }
  >();
  let usage: LLMResponse["usage"] | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    resetStall();
    buffer += decoder.decode(value, { stream: true });
    // SSE messages are separated by blank lines.
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const eventBlock = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      // Each block has one or more `data: ...` lines.
      for (const rawLine of eventBlock.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          return {
            content,
            finishReason,
            toolCalls: Array.from(toolCallAccum.entries())
              .sort(([a], [b]) => a - b)
              .map(([, t]) => ({
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: t.argsBuffer },
              })),
            usage,
          };
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };
          const choice = json.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            content += delta.content;
            onChunk(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const slot = toolCallAccum.get(tc.index) ?? {
                id: "",
                name: "",
                argsBuffer: "",
              };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name = tc.function.name;
              if (tc.function?.arguments)
                slot.argsBuffer += tc.function.arguments;
              toolCallAccum.set(tc.index, slot);
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (json.usage) {
            usage = {
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
              totalTokens: json.usage.total_tokens ?? 0,
            };
          }
        } catch {
          // Malformed JSON in a stream chunk — skip rather than fail
          // the whole call. Real providers occasionally emit keep-
          // alive comments or incomplete events; the next chunk
          // usually carries on cleanly.
        }
      }
    }
  }
  return {
    content,
    finishReason,
    toolCalls: Array.from(toolCallAccum.entries())
      .sort(([a], [b]) => a - b)
      .map(([, t]) => ({
        id: t.id,
        type: "function" as const,
        function: { name: t.name, arguments: t.argsBuffer },
      })),
    usage,
  };
}

function buildBody(
  config: LLMConfig,
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
    // Per-call override wins over the config default. Falls back to
    // 0.7 when neither is set (matches OpenAI's documented default).
    temperature: options?.temperature ?? config.temperature ?? 0.7,
    ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
    ...(config.topP !== undefined ? { top_p: config.topP } : {}),
  };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    if (options.toolChoice !== undefined) {
      body.tool_choice = options.toolChoice;
    }
  }
  if (options?.responseFormat) {
    body.response_format = options.responseFormat;
  }
  return body;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

export function createOpenAIProvider(config: LLMConfig): LLMClient {
  if (!config.baseUrl) {
    throw new Error("OpenAI-compatible provider requires baseUrl");
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = config.apiKey;

  return {
    async chat(
      messages: ChatMessage[],
      opts?: ChatOptions,
    ): Promise<LLMResponse> {
      try {
        const body = buildBody(config, messages, opts, false);
        const response = await fetchWithRetry(
          `${baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: buildHeaders(apiKey),
            body: JSON.stringify(body),
          },
          timeoutMs,
          opts?.signal,
        );

        if (!response.ok) {
          let errorBody = "";
          try {
            errorBody = await response.text();
          } catch {
            /* ignore */
          }
          throw new Error(
            `${config.providerHint ?? "openai"} API error: ${response.status} ${response.statusText}${
              errorBody ? ` - ${errorBody.slice(0, 500)}` : ""
            }`,
          );
        }

        const data = (await response.json()) as OpenAIResponse;
        if (data.error) {
          throw new Error(
            `${config.providerHint ?? "openai"} API error: ${data.error.message ?? JSON.stringify(data.error)}`,
          );
        }
        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? "";
        const toolCalls = choice?.message?.tool_calls;

        return {
          content,
          finishReason: choice?.finish_reason ?? "stop",
          toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens ?? 0,
                completionTokens: data.usage.completion_tokens ?? 0,
                totalTokens: data.usage.total_tokens ?? 0,
              }
            : undefined,
        };
      } catch (e) {
        // Re-throw with provider context so failures upstream are
        // attributable to a specific provider rather than a bare
        // AbortError or fetch error.
        if (e instanceof Error && !e.message.includes(config.model)) {
          e.message = `[${config.providerHint ?? "openai"}/${config.model}] ${e.message}`;
        }
        throw e;
      }
    },

    async chatStream(
      messages: ChatMessage[],
      onChunk: (token: string) => void,
      opts?: ChatOptions,
    ): Promise<LLMResponse> {
      try {
        return await chatStreamingImpl(
          baseUrl,
          buildHeaders(apiKey),
          buildBody(config, messages, opts, true),
          timeoutMs,
          opts?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
          opts?.signal,
          onChunk,
          config.providerHint,
          config.model,
        );
      } catch (e) {
        if (e instanceof Error && !e.message.includes(config.model)) {
          e.message = `[${config.providerHint ?? "openai"}/${config.model}] ${e.message}`;
        }
        throw e;
      }
    },

    async listModels(): Promise<string[]> {
      try {
        const resp = await fetch(`${baseUrl}/models`, {
          headers: buildHeaders(apiKey),
        });
        if (!resp.ok) return [config.model];
        const data = (await resp.json()) as { data?: Array<{ id: string }> };
        const ids = data.data?.map((m) => m.id) ?? [];
        return ids.length > 0 ? ids : [config.model];
      } catch {
        return [config.model];
      }
    },
  };
}
