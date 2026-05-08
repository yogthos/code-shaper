/**
 * Phase 3 review-fix acceptance:
 *
 *   #1 Sibling capabilities with the same name get distinct ids and
 *      both land in the RPG.
 *   #2 Retry messages follow user → assistant → user shape so chat
 *      providers see strict role alternation.
 *   #3 ProposalInput.temperature flows through to the chat call.
 *   #4 summarizeExistingRPG preserves capability hierarchy via
 *      indentation, not a flat list.
 *   #6 stripFences accepts fences with no language tag and tolerates
 *      missing trailing newlines.
 *  #11 summarizeExistingRPG renders folders, files, and capability
 *      hierarchy together in a stable order.
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  isFolder,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  parsePlanResponse,
  proposeFunctionalityGraph,
  summarizeExistingRPG,
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

describe("review fix #1 — sibling-name collisions", () => {
  it("attaches two same-named siblings as distinct nodes", async () => {
    const rpg = emptyRPG();
    const planJson = JSON.stringify({
      projectName: "p",
      description: "d",
      rootCapabilities: [
        { name: "Module", description: "first" },
        { name: "Module", description: "second" },
      ],
    });
    const { client } = mockClient([planJson]);
    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "x",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachedRootIds).toHaveLength(2);
    expect(new Set(result.attachedRootIds).size).toBe(2);

    const descriptions = result.attachedRootIds
      .map((id) => rpg.nodes[id])
      .filter((n): n is CapabilityNode => !!n && isCapability(n))
      .map((n) => n.description);
    expect(descriptions.sort()).toEqual(["first", "second"]);
  });

  it("disambiguates same-name siblings nested under another node", async () => {
    const rpg = emptyRPG();
    const planJson = JSON.stringify({
      projectName: "p",
      description: "d",
      rootCapabilities: [
        {
          name: "Parent",
          description: "p",
          children: [
            { name: "Child", description: "c1" },
            { name: "Child", description: "c2" },
            { name: "Child", description: "c3" },
          ],
        },
      ],
    });
    const { client } = mockClient([planJson]);
    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "x",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalNodesAdded).toBe(4); // 1 parent + 3 children
    const parent = rpg.nodes[result.attachedRootIds[0]!];
    expect(parent && isCapability(parent)).toBe(true);
    if (!parent || !isCapability(parent)) return;
    expect(parent.children).toHaveLength(3);
    expect(new Set(parent.children).size).toBe(3);
  });
});

describe("review fix #2 — retry message shape", () => {
  it("retry shows the prior assistant turn before the corrective user msg", async () => {
    const rpg = emptyRPG();
    const brokenJson = JSON.stringify({
      projectName: "p",
      description: "d",
      rootCapabilities: [{ name: "x", description: "" }], // empty description fails validation
    });
    const goodJson = JSON.stringify({
      projectName: "p",
      description: "d",
      rootCapabilities: [{ name: "x", description: "ok" }],
    });
    const { client, calls } = mockClient([brokenJson, goodJson]);

    const result = await proposeFunctionalityGraph(client, rpg, {
      description: "x",
      maxAttempts: 2,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);

    // Retry call: roles must strictly alternate after the system prompt:
    //   system, user, assistant, user
    const retryRoles = calls[1]!.messages.map((m: any) => m.role);
    expect(retryRoles).toEqual(["system", "user", "assistant", "user"]);

    // The assistant message replays the broken JSON the model produced.
    const assistant = calls[1]!.messages[2];
    expect(assistant.content).toBe(brokenJson);

    // The corrective user message names the validation problem.
    const corrective = calls[1]!.messages[3];
    expect(corrective.content).toMatch(/validation/i);
  });
});

describe("review fix #3 — temperature override", () => {
  it("threads input.temperature into the chat call", async () => {
    const rpg = emptyRPG();
    const planJson = JSON.stringify({
      projectName: "p",
      description: "d",
      rootCapabilities: [{ name: "x", description: "ok" }],
    });
    const { client, calls } = mockClient([planJson]);

    await proposeFunctionalityGraph(client, rpg, {
      description: "x",
      temperature: 0.05,
    });
    // The provider supports a temperature option via ChatOptions; we
    // surface it here for the proposal call so deterministic-ish runs
    // are easy to set up.
    expect(calls[0]!.options?.temperature).toBe(0.05);
  });
});

describe("review fix #4 — hierarchical existing-RPG summary", () => {
  it("renders capability hierarchy with indentation, not flat", () => {
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId];
    if (!root || !isFolder(root)) throw new Error("bad fixture");

    const parent: CapabilityNode = {
      id: "cap:p",
      kind: "capability",
      name: "Auth",
      parent: rpg.rootId,
      children: ["cap:p/c1", "cap:p/c2"],
      features: [],
      description: "OAuth surface",
      isLeaf: false,
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    const child1: CapabilityNode = {
      id: "cap:p/c1",
      kind: "capability",
      name: "Token Refresh",
      parent: parent.id,
      children: [],
      features: [],
      description: "Refresh tokens via the IdP",
      isLeaf: true,
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    const child2: CapabilityNode = {
      id: "cap:p/c2",
      kind: "capability",
      name: "Login Flow",
      parent: parent.id,
      children: [],
      features: [],
      description: "Initial login redirect",
      isLeaf: true,
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    rpg.nodes[parent.id] = parent;
    rpg.nodes[child1.id] = child1;
    rpg.nodes[child2.id] = child2;
    root.children.push(parent.id);

    const summary = summarizeExistingRPG(rpg);
    // Parent appears at indent 0, children indented under it.
    const lines = summary.split("\n");
    const parentLineIdx = lines.findIndex((l) => /^- Auth/.test(l));
    expect(parentLineIdx).toBeGreaterThanOrEqual(0);
    const child1LineIdx = lines.findIndex((l) => /Token Refresh/.test(l));
    expect(child1LineIdx).toBe(parentLineIdx + 1);
    expect(lines[child1LineIdx]!.startsWith("  ")).toBe(true);
    const child2LineIdx = lines.findIndex((l) => /Login Flow/.test(l));
    expect(lines[child2LineIdx]!.startsWith("  ")).toBe(true);
  });
});

describe("review fix #6 — stripFences edge cases", () => {
  it("accepts fence with no language tag", () => {
    const fenced =
      '```\n{"projectName":"p","description":"d","rootCapabilities":[{"name":"x","description":"y"}]}\n```';
    const r = parsePlanResponse(fenced);
    expect(r.ok).toBe(true);
  });

  it("accepts fence missing the trailing newline", () => {
    const fenced =
      '```json\n{"projectName":"p","description":"d","rootCapabilities":[{"name":"x","description":"y"}]}```';
    const r = parsePlanResponse(fenced);
    expect(r.ok).toBe(true);
  });
});

describe("review fix #11 — summarizeExistingRPG smoke", () => {
  it("renders folders, files-with-exports, and capability hierarchy in stable order", () => {
    const rpg = makeMixedRPG();
    const summary = summarizeExistingRPG(rpg);

    // Sections appear in the documented order.
    const foldersIdx = summary.indexOf("## Folders");
    const filesIdx = summary.indexOf("## Files");
    const capsIdx = summary.indexOf("## Existing capabilities");
    expect(foldersIdx).toBeGreaterThanOrEqual(0);
    expect(filesIdx).toBeGreaterThan(foldersIdx);
    expect(capsIdx).toBeGreaterThan(filesIdx);

    // Folders sorted lexicographically.
    expect(summary).toMatch(/- src\/[\s\S]*- tests\//);

    // Files include their exports.
    expect(summary).toMatch(/exports: foo/);

    // Capability hierarchy renders the parent first, indented child second.
    expect(summary).toMatch(/- Parent[\s\S]*\n  - Leaf/);
  });
});

function makeMixedRPG(): RPG {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId];
  if (!root || !isFolder(root)) throw new Error("bad fixture");

  const srcFolder: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: ["file:src/a.ts"],
    features: [],
    path: "src",
  };
  const testsFolder: FolderNode = {
    id: "folder:tests",
    kind: "folder",
    name: "tests",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "tests",
  };
  const aFile: FileNode = {
    id: "file:src/a.ts",
    kind: "file",
    name: "a.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/a.ts",
    content: "export function foo() {}\n",
    language: "typescript",
    rawImports: [],
    exports: ["foo"],
  };
  const parentCap: CapabilityNode = {
    id: "cap:p",
    kind: "capability",
    name: "Parent",
    parent: rpg.rootId,
    children: ["cap:p/leaf"],
    features: [],
    description: "p",
    isLeaf: false,
    status: "planned",
    mappedToId: null,
      decompositionDepth: 0,
  };
  const leafCap: CapabilityNode = {
    id: "cap:p/leaf",
    kind: "capability",
    name: "Leaf",
    parent: parentCap.id,
    children: [],
    features: [],
    description: "leaf desc",
    isLeaf: true,
    status: "planned",
    mappedToId: null,
      decompositionDepth: 0,
  };
  rpg.nodes[srcFolder.id] = srcFolder;
  rpg.nodes[testsFolder.id] = testsFolder;
  rpg.nodes[aFile.id] = aFile;
  rpg.nodes[parentCap.id] = parentCap;
  rpg.nodes[leafCap.id] = leafCap;
  root.children.push(srcFolder.id, testsFolder.id, parentCap.id);
  return rpg;
}
