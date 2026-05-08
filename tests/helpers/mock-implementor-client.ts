/**
 * Shared mock LLM client for implementor-layer tests.
 *
 * Discriminates test-author vs body-author calls by unique phrases in
 * each system prompt. Both prompts mention "test file" so naive
 * substring detection conflates them — these helpers use the
 * unique phrases that ONLY appear in their target prompt.
 *
 * Usage:
 *   const { client, calls, isTestAuthor, isBodyAuthor } = makeMockClient([
 *     "<test file source>",
 *     "<body source>",
 *     ...
 *   ]);
 */

import type { LLMClient, LLMResponse } from "../../src/llm/types.js";

/** Phrase that appears ONLY in the test-author system prompt. */
const TEST_AUTHOR_MARKER = "producing a vitest test file";
/** Phrase that appears ONLY in the body-author system prompt. */
const BODY_AUTHOR_MARKER = "producing the body of a single";

export interface MockImplementorClient {
  client: LLMClient;
  /** Every chat call captured in order. */
  calls: Array<{ messages: ChatMessage[]; options?: any }>;
  /** Filter helper — chat calls whose system prompt is the test author. */
  testAuthorCalls(): Array<{ messages: ChatMessage[] }>;
  /** Filter helper — chat calls whose system prompt is the body author. */
  bodyAuthorCalls(): Array<{ messages: ChatMessage[] }>;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Build a mock client that returns canned responses in order, regardless
 *  of caller. Use this when the test only cares about call shape, not
 *  per-author dispatch. */
export function makeMockClient(responses: string[]): MockImplementorClient {
  const calls: Array<{ messages: ChatMessage[]; options?: any }> = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages, options): Promise<LLMResponse> {
      calls.push({ messages, options });
      const content = responses[i++] ?? "";
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return {
    client,
    calls,
    testAuthorCalls: () => calls.filter((c) => isTestAuthor(c.messages)),
    bodyAuthorCalls: () => calls.filter((c) => isBodyAuthor(c.messages)),
  };
}

/** Build a mock that dispatches to per-author response queues based on
 *  the system-prompt marker. Useful when tests need to stage different
 *  responses for test-author vs body-author calls. */
export function makeRoleAwareClient(args: {
  testAuthorResponses: string[];
  bodyAuthorResponses: string[];
}): MockImplementorClient {
  const calls: Array<{ messages: ChatMessage[]; options?: any }> = [];
  let testIndex = 0;
  let bodyIndex = 0;
  const client: LLMClient = {
    async chat(messages, options): Promise<LLMResponse> {
      calls.push({ messages, options });
      if (isTestAuthor(messages)) {
        const content = args.testAuthorResponses[testIndex++] ?? "";
        return { content, finishReason: "stop" };
      }
      if (isBodyAuthor(messages)) {
        const content = args.bodyAuthorResponses[bodyIndex++] ?? "";
        return { content, finishReason: "stop" };
      }
      return { content: "", finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return {
    client,
    calls,
    testAuthorCalls: () => calls.filter((c) => isTestAuthor(c.messages)),
    bodyAuthorCalls: () => calls.filter((c) => isBodyAuthor(c.messages)),
  };
}

export function isTestAuthor(messages: ChatMessage[]): boolean {
  return (messages[0]?.content ?? "").includes(TEST_AUTHOR_MARKER);
}

export function isBodyAuthor(messages: ChatMessage[]): boolean {
  return (messages[0]?.content ?? "").includes(BODY_AUTHOR_MARKER);
}
