/**
 * Phase 5 extend-mode acceptance.
 *
 *   - mode: "extend" injects an "Extend-mode policy" section into the
 *     user prompt; greenfield does not.
 *   - When a leaf's host file already has AST children (from a prior
 *     loadRepo) AND an exported name matches the leaf description, the
 *     leaf is treated as already-implemented and skipped — the
 *     architect never sees it in the prompt.
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type FunctionNode,
} from "../src/rpg/index.js";
import {
  buildInterfaceUserPrompt,
  designInterfaces,
  renderInterfacePromptBody,
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

describe("Phase 5 extend mode prompt", () => {
  it("greenfield prompt has no extend-mode policy section", () => {
    const text = buildInterfaceUserPrompt({
      projectDescription: "x",
      allowedExtensions: [".ts"],
      body: "",
      mode: "greenfield",
    });
    expect(text).not.toMatch(/extend-mode policy/i);
  });

  it("extend prompt includes the policy paragraph", () => {
    const text = buildInterfaceUserPrompt({
      projectDescription: "x",
      allowedExtensions: [".ts"],
      body: "",
      mode: "extend",
    });
    expect(text).toMatch(/extend-mode policy/i);
    expect(text).toMatch(/integrate with existing/i);
  });
});

describe("Phase 5 extend mode leaf-skip heuristic", () => {
  it("skips leaves whose host file already exports a matching member", async () => {
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId] as FolderNode;

    // Existing file with one real AST function + an export that
    // matches the leaf's description.
    const file: FileNode = {
      id: "file:src/handler.ts",
      kind: "file",
      name: "handler.ts",
      parent: rpg.rootId,
      children: ["function:file:src/handler.ts#handlePost@1"],
      features: [],
      path: "src/handler.ts",
      content: "export function handlePost() {}",
      language: "typescript",
      rawImports: [],
      exports: ["handlePost"],
    };
    const fn: FunctionNode = {
      id: "function:file:src/handler.ts#handlePost@1",
      kind: "function",
      name: "handlePost",
      parent: file.id,
      children: [],
      features: [],
      file: file.id,
      byteRange: { start: 0, end: 28 },
      lineRange: { start: 1, end: 1 },
      exported: true,
    };
    rpg.nodes[file.id] = file;
    rpg.nodes[fn.id] = fn;
    root.children.push(file.id);

    // Two leaves: one whose description matches the existing export
    // (handlePost), one that's brand new.
    const existingLeaf: CapabilityNode = {
      id: "cap:existing",
      kind: "capability",
      name: "POST handler",
      parent: rpg.rootId,
      children: [],
      features: [],
      description: "Handles handlePost incoming submissions.",
      isLeaf: true,
      status: "mapped",
      mappedToId: file.id,
      decompositionDepth: 0,
    };
    const newLeaf: CapabilityNode = {
      id: "cap:new",
      kind: "capability",
      name: "GET handler",
      parent: rpg.rootId,
      children: [],
      features: [],
      description: "Returns the entries on GET requests.",
      isLeaf: true,
      status: "mapped",
      mappedToId: file.id,
      decompositionDepth: 0,
    };
    rpg.nodes[existingLeaf.id] = existingLeaf;
    rpg.nodes[newLeaf.id] = newLeaf;
    root.children.push(existingLeaf.id, newLeaf.id);

    // Plan covers only the new leaf.
    const plan = JSON.stringify({
      interfaces: [
        {
          leafCapabilityId: newLeaf.id,
          filePath: "src/handler.ts",
          kind: "function",
          name: "handleGet",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "GET handler.",
          exported: true,
          isStatic: false,
        },
      ],
      classes: [],
      dataFlow: [],
    });
    const { client, calls } = mockClient([plan]);
    const result = await designInterfaces(client, rpg, {
      description: "Add a GET handler to the guestbook.",
      mode: "extend",
    });
    expect(result.ok, result.error).toBe(true);
    // The architect was *not* asked to plan the existing leaf — so the
    // user prompt's "Leaves to map" table doesn't include its id.
    const userMsg = calls[0]!.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toMatch(/cap:new/);
    expect(userMsg.content).not.toMatch(/cap:existing/);

    // The existing leaf's mapping is untouched.
    const existing = rpg.nodes[existingLeaf.id];
    if (!existing || !isCapability(existing)) throw new Error("kind drift");
    expect(existing.mappedToId).toBe(file.id);

    void renderInterfacePromptBody;
  });
});
