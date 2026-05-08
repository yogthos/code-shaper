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
