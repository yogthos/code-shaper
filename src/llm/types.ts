/**
 * LLM client contract — minimal subset of rlm-sandbox's interface.
 * One provider = one implementation of LLMClient.
 */

export interface LLMConfig {
  /** Base URL up to (but not including) /chat/completions. */
  baseUrl: string;
  /** API key — caller is responsible for env var interpolation. */
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  /** Identifier used for diagnostics + env-var fallback. */
  providerHint?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatOptions {
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  responseFormat?:
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: {
          schema: Record<string, unknown>;
          name?: string;
          strict?: boolean;
        };
      };
  /** Per-call override for sampling temperature. Falls back to the
   *  provider's `LLMConfig.temperature` when omitted. */
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  finishReason: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
  /**
   * Streaming variant. Optional — providers add it as needed. Calls
   * `onChunk` for each generated token (or token-equivalent delta) and
   * resolves with the full response once the stream closes. Tool-call
   * deltas accumulate into the returned `toolCalls`.
   */
  chatStream?(
    messages: ChatMessage[],
    onChunk: (token: string) => void,
    options?: ChatOptions,
  ): Promise<LLMResponse>;
  listModels(): Promise<string[]>;
}
