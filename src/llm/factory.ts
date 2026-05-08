/**
 * Provider factory — turns a `ProviderConfig` (from config.json) into an
 * `LLMClient`. For Phase 0 we only support openai-compatible HTTP
 * endpoints (covers GLM/Zhipu, DeepSeek, OpenAI, OpenRouter, Together,
 * Ollama via /v1, and any local llama.cpp server).
 */

import { createOpenAIProvider } from "./openai-provider.js";
import type { LLMClient, LLMConfig } from "./types.js";
import type { ProviderConfig } from "../config.js";

/**
 * Strip `/chat/completions` (or `/v1/chat/completions`) suffix if the
 * user supplied the full endpoint URL — the provider re-appends it.
 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

export function createClient(name: string, cfg: ProviderConfig): LLMClient {
  const baseUrl = normalizeBaseUrl(cfg.url);
  const llmConfig: LLMConfig = {
    baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    providerHint: name,
    temperature: cfg.options?.temperature,
    topP: cfg.options?.top_p,
    maxTokens: cfg.options?.max_tokens,
    timeoutMs: cfg.options?.timeout_ms,
  };
  return createOpenAIProvider(llmConfig);
}
