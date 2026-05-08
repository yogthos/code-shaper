/**
 * Phase 4 review-fix acceptance:
 *
 *   #1 Extend mode adds an "Existing structure policy" section to the
 *      user prompt; greenfield mode does not.
 *   #2 When the LLM silently omits a required mapping (validation
 *      passes, but a non-leaf capability got no path), the orchestrator
 *      reports ok=false + unmappedRequired naming the missing ids.
 */

import { describe, it, expect } from "vitest";

import { emptyRPG, isCapability, type CapabilityNode } from "../src/rpg/index.js";
import {
  buildStructureUserPrompt,
  encodeFileStructure,
  proposeFunctionalityGraph,
  renderStructurePromptBody,
} from "../src/architect/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function mockClient(responses: string[]): {
  client: LLMClient;
  calls: Array<{ messages: any[]; options?: any }>;
} {
  const calls: Array<{ messages: any[]; options?: any }> = [];
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
  return { client, calls };
}

const SIMPLE_PLAN = JSON.stringify({
  projectName: "p",
  description: "d",
  rootCapabilities: [
    {
      name: "Module A",
      description: "first module",
      children: [{ name: "feat-a1", description: "leaf" }],
    },
    {
      name: "Module B",
      description: "second module",
      children: [{ name: "feat-b1", description: "leaf" }],
    },
  ],
});

describe("review fix #1 — mode-conditional prompt", () => {
  it("greenfield prompt has no existing-structure policy section", () => {
    const rpg = emptyRPG();
    const body = renderStructurePromptBody(rpg);
    const text = buildStructureUserPrompt({
      projectDescription: "x",
      mode: "greenfield",
      allowedExtensions: [".ts"],
      body,
    });
    expect(text).not.toMatch(/existing.structure policy/i);
  });

  it("extend prompt adds an explicit policy paragraph", () => {
    const rpg = emptyRPG();
    const body = renderStructurePromptBody(rpg);
    const text = buildStructureUserPrompt({
      projectDescription: "x",
      mode: "extend",
      allowedExtensions: [".ts"],
      body,
    });
    expect(text).toMatch(/existing.structure policy/i);
    // The instruction should mention reuse over invention.
    expect(text).toMatch(/(reuse|existing folder|do not invent)/i);
  });
});

describe("review fix #2 — unmappedRequired reporting", () => {
  it("ok=false + unmappedRequired when LLM omits a required mapping", async () => {
    const rpg = emptyRPG();
    const { client: setupClient } = mockClient([SIMPLE_PLAN]);
    const proposal = await proposeFunctionalityGraph(setupClient, rpg, {
      description: "x",
    });
    expect(proposal.ok).toBe(true);

    const findCap = (name: string): CapabilityNode => {
      for (const n of Object.values(rpg.nodes)) {
        if (isCapability(n) && n.name === name) return n;
      }
      throw new Error(`cap ${name} not found`);
    };
    const moduleA = findCap("Module A");
    const moduleB = findCap("Module B");

    // Plan maps only Module A; Module B is silently skipped despite
    // being required (non-leaf).
    const partial = JSON.stringify({
      mappings: [
        { capabilityId: moduleA.id, kind: "folder", path: "src/a" },
        // Module B missing.
      ],
    });
    // Provide the same partial response on every retry attempt so the
    // orchestrator exhausts its budget and surfaces the error.
    const { client } = mockClient([partial, partial, partial]);

    const result = await encodeFileStructure(client, rpg, {
      description: "x",
      maxAttempts: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/omitted|unmapped/i);
    expect(result.unmappedRequired).toContain(moduleB.id);
    expect(result.unmappedRequired).not.toContain(moduleA.id);
  });
});
