/**
 * Phase 5 parallelization: when leaves group across multiple mapped
 * ancestors and parallelism > 1, designInterfaces fans out. Each
 * group gets its own LLM call scoped to its leaves; results are
 * merged into one plan.
 */

import { describe, it, expect } from "vitest";
import { designInterfaces } from "../src/architect/index.js";
import {
  emptyRPG,
  type CapabilityNode,
  type FolderNode,
} from "../src/rpg/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function buildTwoGroupRpg(): {
  rpg: ReturnType<typeof emptyRPG>;
  leafA: CapabilityNode;
  leafB: CapabilityNode;
} {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  // Two folder nodes (the two groups) + one leaf per folder.
  rpg.nodes["folder:src/http"] = {
    id: "folder:src/http",
    kind: "folder",
    name: "http",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src/http",
  };
  rpg.nodes["folder:src/persist"] = {
    id: "folder:src/persist",
    kind: "folder",
    name: "persist",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src/persist",
  };
  root.children.push("folder:src/http", "folder:src/persist");

  const leafA: CapabilityNode = {
    id: "cap:routeGet",
    kind: "capability",
    name: "GET /entries",
    description: "GET handler",
    parent: rpg.rootId,
    children: [],
    features: [],
    isLeaf: true,
    status: "mapped",
    mappedToId: "folder:src/http",
    decompositionDepth: 0,
  };
  const leafB: CapabilityNode = {
    id: "cap:read",
    kind: "capability",
    name: "Read entries",
    description: "Reader",
    parent: rpg.rootId,
    children: [],
    features: [],
    isLeaf: true,
    status: "mapped",
    mappedToId: "folder:src/persist",
    decompositionDepth: 0,
  };
  rpg.nodes[leafA.id] = leafA;
  rpg.nodes[leafB.id] = leafB;
  return { rpg, leafA, leafB };
}

describe("designInterfaces — parallel fan-out per group", () => {
  it(
    "fans out one LLM call per ancestor group when parallelism > 1",
    async () => {
      const { rpg, leafA, leafB } = buildTwoGroupRpg();
      const calls: Array<{ scope: string }> = [];
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          // Record which leaf id appears in this call's prompt to
          // identify which group it's for. The non-scoped leaves
          // are filtered out via the prompt body's skipLeafIds, so
          // each call only sees its own group's leaf.
          const userPrompt = messages[messages.length - 1]!.content;
          const containsA = userPrompt.includes(leafA.id);
          const containsB = userPrompt.includes(leafB.id);
          let scope: string;
          let response: string;
          if (containsA && !containsB) {
            scope = "groupA";
            response = JSON.stringify({
              interfaces: [
                {
                  leafCapabilityId: leafA.id,
                  filePath: "src/http/handlers.ts",
                  kind: "function",
                  ownerClassName: null,
                  name: "handleGet",
                  signature: { params: [], returnType: "void", isAsync: false },
                  description: "Handles GET.",
                  exported: true,
                  isStatic: false,
                },
              ],
              classes: [],
              dataFlow: [],
            });
          } else if (containsB && !containsA) {
            scope = "groupB";
            response = JSON.stringify({
              interfaces: [
                {
                  leafCapabilityId: leafB.id,
                  filePath: "src/persist/store.ts",
                  kind: "function",
                  ownerClassName: null,
                  name: "readEntries",
                  signature: { params: [], returnType: "string[]", isAsync: false },
                  description: "Reads.",
                  exported: true,
                  isStatic: false,
                },
              ],
              classes: [],
              dataFlow: [],
            });
          } else {
            scope = "unknown";
            response = "";
          }
          calls.push({ scope });
          return { content: response, finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await designInterfaces(client, rpg, {
        description: "x",
        parallelism: 4,
      });
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect(calls).toHaveLength(2);
      // Both scopes invoked.
      const scopes = new Set(calls.map((c) => c.scope));
      expect(scopes).toEqual(new Set(["groupA", "groupB"]));
    },
  );

  it(
    "falls back to single call when there's only one ancestor group",
    async () => {
      const rpg = emptyRPG();
      const root = rpg.nodes[rpg.rootId] as FolderNode;
      rpg.nodes["folder:src"] = {
        id: "folder:src",
        kind: "folder",
        name: "src",
        parent: rpg.rootId,
        children: [],
        features: [],
        path: "src",
      };
      root.children.push("folder:src");
      const leaf: CapabilityNode = {
        id: "cap:do",
        kind: "capability",
        name: "Do",
        description: "Does it",
        parent: rpg.rootId,
        children: [],
        features: [],
        isLeaf: true,
        status: "mapped",
        mappedToId: "folder:src",
        decompositionDepth: 0,
      };
      rpg.nodes[leaf.id] = leaf;

      let calls = 0;
      const client: LLMClient = {
        async chat(): Promise<LLMResponse> {
          calls++;
          return {
            content: JSON.stringify({
              interfaces: [
                {
                  leafCapabilityId: leaf.id,
                  filePath: "src/x.ts",
                  kind: "function",
                  ownerClassName: null,
                  name: "doIt",
                  signature: {
                    params: [],
                    returnType: "void",
                    isAsync: false,
                  },
                  description: "x",
                  exported: true,
                  isStatic: false,
                },
              ],
              classes: [],
              dataFlow: [],
            }),
            finishReason: "stop",
          };
        },
        async listModels() {
          return ["mock"];
        },
      };
      const result = await designInterfaces(client, rpg, {
        description: "x",
        parallelism: 4,
      });
      expect(result.ok).toBe(true);
      // Single group → single call regardless of parallelism setting.
      expect(calls).toBe(1);
    },
  );

  it(
    "surfaces a consolidated error when one of N groups fails validation",
    async () => {
      const { rpg, leafA, leafB } = buildTwoGroupRpg();
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const prompt = messages[messages.length - 1]!.content;
          if (prompt.includes(leafA.id)) {
            return {
              content: JSON.stringify({
                interfaces: [
                  {
                    leafCapabilityId: leafA.id,
                    filePath: "src/http/h.ts",
                    kind: "function",
                    ownerClassName: null,
                    name: "ok",
                    signature: { params: [], returnType: "void", isAsync: false },
                    description: "x",
                    exported: true,
                    isStatic: false,
                  },
                ],
                classes: [],
                dataFlow: [],
              }),
              finishReason: "stop",
            };
          }
          // Group B always returns invalid JSON.
          if (prompt.includes(leafB.id)) {
            return { content: "not valid json", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };
      const result = await designInterfaces(client, rpg, {
        description: "x",
        parallelism: 4,
        maxAttempts: 1,
      });
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toContain("parallel phase 5 failed");
      // The good group's leaves are NOT listed as unplanned;
      // unplannedLeaves only covers the failed group.
      expect(result.unplannedLeaves).toEqual([leafB.id]);
    },
  );
});
