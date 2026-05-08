/**
 * Phase 7a — decompose-on-stuck acceptance.
 *
 *  - decomposeStuckLeaf returns "fresh_approach" with a hint when
 *    the architect picks that path.
 *  - decomposeStuckLeaf creates new sub-leaf capabilities + plan
 *    entries on "decompose", with depth+1 on the children.
 *  - At MAX_DECOMPOSE_DEPTH-1, the validator REJECTS a decompose
 *    decision and only accepts fresh_approach.
 *  - At MAX_DECOMPOSE_DEPTH, decomposeStuckLeaf short-circuits to
 *    "depth_exhausted" without calling the LLM.
 *  - Sub-leaves get a dataFlow edge to the original leaf so the
 *    topological build runs them first.
 *  - Validation rejects: bad camelCase, sub-leaves without owner
 *    class for kind=method, sub-leaves count outside [2,5].
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  MAX_DECOMPOSE_DEPTH,
  decomposeStuckLeaf,
  type DecomposeRequest,
} from "../src/implementor/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function mockClient(responses: string[]): {
  client: LLMClient;
  calls: Array<{ messages: any[] }>;
} {
  const calls: Array<{ messages: any[] }> = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages): Promise<LLMResponse> {
      calls.push({ messages });
      const content = responses[i++] ?? "";
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, calls };
}

function buildRpgWithLeaf(): {
  rpg: RPG;
  hostFile: FileNode;
  parentCap: CapabilityNode;
  leafCap: CapabilityNode;
  request: DecomposeRequest;
} {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  const folder: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src",
  };
  rpg.nodes[folder.id] = folder;
  root.children.push(folder.id);
  const file: FileNode = {
    id: "file:src/util.ts",
    kind: "file",
    name: "util.ts",
    parent: folder.id,
    children: [],
    features: [],
    path: "src/util.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [],
    },
  };
  rpg.nodes[file.id] = file;
  folder.children.push(file.id);

  const parentCap: CapabilityNode = {
    id: "cap:parent",
    kind: "capability",
    name: "Util Group",
    parent: rpg.rootId,
    children: [],
    features: [],
    description: "group",
    isLeaf: false,
    status: "mapped",
    mappedToId: folder.id,
    decompositionDepth: 0,
  };
  rpg.nodes[parentCap.id] = parentCap;
  root.children.push(parentCap.id);

  const leafCap: CapabilityNode = {
    id: "cap:doStuff",
    kind: "capability",
    name: "doStuff",
    parent: parentCap.id,
    children: [],
    features: [],
    description: "Does stuff.",
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 0,
  };
  rpg.nodes[leafCap.id] = leafCap;
  parentCap.children.push(leafCap.id);

  const planEntry = {
    leafCapabilityId: leafCap.id,
    kind: "function" as const,
    ownerClassName: null,
    name: "doStuff",
    signature: { params: [], returnType: "number", isAsync: false },
    description: "Does stuff.",
    exported: true,
    isStatic: false,
  };
  file.interfacePlan!.entries.push(planEntry);

  const request: DecomposeRequest = {
    leaf: planEntry,
    hostFile: file,
    rpg,
    testSource: "// test",
    lastBody: "return 0;",
    lastFailure: "expected 5, got 0",
    attemptsExhausted: 3,
    decompositionDepth: 0,
  };
  return { rpg, hostFile: file, parentCap, leafCap, request };
}

describe("decomposeStuckLeaf — fresh approach", () => {
  it("returns the architect's hint when decision is fresh_approach", async () => {
    const { request } = buildRpgWithLeaf();
    const { client } = mockClient([
      JSON.stringify({
        decision: "fresh_approach",
        reason: "single concern; just need a different angle",
        approachHint: "use reduce instead of a manual loop",
      }),
    ]);
    const r = await decomposeStuckLeaf(client, { ...request });
    expect(r.ok).toBe(true);
    expect(r.decision?.kind).toBe("fresh_approach");
    if (r.decision?.kind !== "fresh_approach") return;
    expect(r.decision.approachHint).toMatch(/reduce/);
    expect(r.decision.reason).toMatch(/single concern/);
  });
});

describe("decomposeStuckLeaf — decompose", () => {
  it("creates sub-leaf capabilities with depth+1 + interface plan entries", async () => {
    const { rpg, hostFile, parentCap, leafCap, request } = buildRpgWithLeaf();
    const subLeaves = [
      {
        name: "stepOne",
        description: "first step",
        signature: {
          params: [{ name: "x", type: "number" }],
          returnType: "number",
          isAsync: false,
        },
        kind: "function",
        ownerClassName: null,
        isStatic: false,
        exported: false,
      },
      {
        name: "stepTwo",
        description: "second step",
        signature: {
          params: [{ name: "y", type: "number" }],
          returnType: "number",
          isAsync: false,
        },
        kind: "function",
        ownerClassName: null,
        isStatic: false,
        exported: false,
      },
    ];
    const { client } = mockClient([
      JSON.stringify({
        decision: "decompose",
        reason: "two distinct concerns",
        subLeaves,
      }),
    ]);
    const r = await decomposeStuckLeaf(client, { ...request });
    expect(r.ok, r.error).toBe(true);
    expect(r.decision?.kind).toBe("decompose");
    if (r.decision?.kind !== "decompose") return;
    expect(r.decision.newCapabilityIds).toHaveLength(2);

    // Each new capability is a leaf with depth=1 and parent=parentCap.
    for (const id of r.decision.newCapabilityIds) {
      const cap = rpg.nodes[id];
      expect(cap && isCapability(cap)).toBe(true);
      if (!cap || !isCapability(cap)) continue;
      expect(cap.decompositionDepth).toBe(1);
      expect(cap.parent).toBe(parentCap.id);
      expect(cap.mappedToId).toBe(hostFile.id);
      expect(cap.isLeaf).toBe(true);
    }
    // Parent capability now has the failed leaf + the two new
    // siblings.
    expect(parentCap.children).toHaveLength(1 + 2);
    expect(parentCap.children).toContain(leafCap.id);

    // Interface plan now has 1 (original) + 2 (new) entries.
    expect(hostFile.interfacePlan!.entries).toHaveLength(3);
    const newNames = hostFile
      .interfacePlan!.entries.map((e) => e.name)
      .sort();
    expect(newNames).toEqual(["doStuff", "stepOne", "stepTwo"]);

    // Data-flow edges: each new leaf produces output consumed by the
    // original leaf.
    for (const id of r.decision.newCapabilityIds) {
      const edge = rpg.dataFlow.find(
        (e) => e.fromNode === id && e.toNode === leafCap.id,
      );
      expect(edge).toBeDefined();
    }
  });
});

describe("decomposeStuckLeaf — depth handling", () => {
  it("rejects decompose at depth = MAX-1 and demands fresh_approach", async () => {
    const { request } = buildRpgWithLeaf();
    request.decompositionDepth = MAX_DECOMPOSE_DEPTH - 1;
    const subLeaves = [
      {
        name: "a",
        description: "x",
        signature: { params: [], returnType: "void", isAsync: false },
        kind: "function",
        ownerClassName: null,
        isStatic: false,
        exported: false,
      },
      {
        name: "b",
        description: "x",
        signature: { params: [], returnType: "void", isAsync: false },
        kind: "function",
        ownerClassName: null,
        isStatic: false,
        exported: false,
      },
    ];
    const { client } = mockClient([
      // First response: ignores the limit, returns decompose. Should
      // be rejected.
      JSON.stringify({ decision: "decompose", reason: "x", subLeaves }),
      // Second response: corrected to fresh_approach.
      JSON.stringify({
        decision: "fresh_approach",
        reason: "use a different algorithm",
        approachHint: "use a hashmap",
      }),
    ]);
    const r = await decomposeStuckLeaf(client, { ...request, maxAttempts: 2 });
    expect(r.ok).toBe(true);
    expect(r.decision?.kind).toBe("fresh_approach");
    expect(r.attempts).toBe(2);
  });

  it("short-circuits with depth_exhausted at MAX, no LLM call", async () => {
    const { request } = buildRpgWithLeaf();
    request.decompositionDepth = MAX_DECOMPOSE_DEPTH;
    const { client, calls } = mockClient([]);
    const r = await decomposeStuckLeaf(client, { ...request });
    expect(r.ok).toBe(true);
    expect(r.decision?.kind).toBe("depth_exhausted");
    expect(calls).toHaveLength(0);
  });
});

describe("decomposeStuckLeaf — validation", () => {
  it("rejects fewer than 2 sub-leaves", async () => {
    const { request } = buildRpgWithLeaf();
    const { client } = mockClient([
      JSON.stringify({
        decision: "decompose",
        reason: "x",
        subLeaves: [
          {
            name: "only",
            description: "x",
            signature: { params: [], returnType: "void", isAsync: false },
            kind: "function",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
        ],
      }),
    ]);
    const r = await decomposeStuckLeaf(client, {
      ...request,
      maxAttempts: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/2-5/);
  });

  it("rejects non-camelCase names", async () => {
    const { request } = buildRpgWithLeaf();
    const { client } = mockClient([
      JSON.stringify({
        decision: "decompose",
        reason: "x",
        subLeaves: [
          {
            name: "BadName",
            description: "x",
            signature: { params: [], returnType: "void", isAsync: false },
            kind: "function",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
          {
            name: "ok",
            description: "x",
            signature: { params: [], returnType: "void", isAsync: false },
            kind: "function",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
        ],
      }),
    ]);
    const r = await decomposeStuckLeaf(client, {
      ...request,
      maxAttempts: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/camelCase/);
  });

  it("rejects method sub-leaves without an ownerClassName", async () => {
    const { request } = buildRpgWithLeaf();
    const { client } = mockClient([
      JSON.stringify({
        decision: "decompose",
        reason: "x",
        subLeaves: [
          {
            name: "doIt",
            description: "x",
            signature: { params: [], returnType: "void", isAsync: false },
            kind: "method",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
          {
            name: "doMore",
            description: "x",
            signature: { params: [], returnType: "void", isAsync: false },
            kind: "function",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
        ],
      }),
    ]);
    const r = await decomposeStuckLeaf(client, {
      ...request,
      maxAttempts: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ownerClassName/);
  });
});
