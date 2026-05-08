/**
 * Phase 7a review-fix acceptance.
 *
 *   #1 decompose works for a leaf whose immediate parent is the root
 *      FOLDER (top-level leaves) — the new sub-leaves are still
 *      created as siblings.
 *   #2 test source is preserved across decompose: when the orchestrator
 *      re-queues the original leaf as an assembly, its tests are NOT
 *      re-authored — the contract stays.
 *   #3 the architect's fresh_approach approachHint is threaded into
 *      the body-author user prompt on the next attempt.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";

import {
  emptyRPG,
  isCapability,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  buildImplementations,
  createHarnessDir,
  decomposeStuckLeaf,
  linkHostNodeModules,
  type DecomposeRequest,
} from "../src/implementor/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

let workDir: string;

beforeAll(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
}, 30_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// ── Fix #1 — top-level leaf decompose ────────────────────────────────

function buildRpgWithTopLevelLeaf(): {
  rpg: RPG;
  hostFile: FileNode;
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
    id: "file:src/lib.ts",
    kind: "file",
    name: "lib.ts",
    parent: folder.id,
    children: [],
    features: [],
    path: "src/lib.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: { classes: [], entries: [] },
  };
  rpg.nodes[file.id] = file;
  folder.children.push(file.id);

  // The leaf capability's parent is the ROOT FOLDER, not another
  // capability. This is the case the original parentCapabilityIdOfLeaf
  // dropped on the floor.
  const leafCap: CapabilityNode = {
    id: "cap:topleaf",
    kind: "capability",
    name: "topleaf",
    parent: rpg.rootId,
    children: [],
    features: [],
    description: "top-level leaf",
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 0,
  };
  rpg.nodes[leafCap.id] = leafCap;
  root.children.push(leafCap.id);

  const planEntry = {
    leafCapabilityId: leafCap.id,
    kind: "function" as const,
    ownerClassName: null,
    name: "topleaf",
    signature: { params: [], returnType: "number", isAsync: false },
    description: "top",
    exported: true,
    isStatic: false,
  };
  file.interfacePlan!.entries.push(planEntry);

  const request: DecomposeRequest = {
    leaf: planEntry,
    hostFile: file,
    rpg,
    testSource: "// t",
    lastBody: "return 0;",
    lastFailure: "x",
    attemptsExhausted: 3,
    decompositionDepth: 0,
  };
  return { rpg, hostFile: file, leafCap, request };
}

function fixedClient(content: string): LLMClient {
  return {
    async chat(): Promise<LLMResponse> {
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
}

describe("review fix #1 — top-level leaf decompose", () => {
  it("creates sub-leaves even when the leaf's parent is the root folder", async () => {
    const { rpg, leafCap, request } = buildRpgWithTopLevelLeaf();
    const client = fixedClient(
      JSON.stringify({
        decision: "decompose",
        reason: "two concerns",
        subLeaves: [
          {
            name: "stepA",
            description: "x",
            signature: { params: [], returnType: "number", isAsync: false },
            kind: "function",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
          {
            name: "stepB",
            description: "y",
            signature: { params: [], returnType: "number", isAsync: false },
            kind: "function",
            ownerClassName: null,
            isStatic: false,
            exported: false,
          },
        ],
      }),
    );
    const r = await decomposeStuckLeaf(client, request);
    expect(r.ok, r.error).toBe(true);
    expect(r.decision?.kind).toBe("decompose");
    if (r.decision?.kind !== "decompose") return;
    expect(r.decision.newCapabilityIds).toHaveLength(2);

    // Each new capability is parented to the same parent the failed
    // leaf had (the root folder), making them siblings of the leaf.
    for (const id of r.decision.newCapabilityIds) {
      const cap = rpg.nodes[id];
      expect(cap && isCapability(cap)).toBe(true);
      if (!cap || !isCapability(cap)) continue;
      expect(cap.parent).toBe(leafCap.parent);
    }
  });
});

// ── Fix #2 — test source preserved across decompose ─────────────────

describe("review fix #2 — test source preserved across decompose", () => {
  it(
    "does not re-author the original leaf's tests after decomposing",
    { timeout: 60_000 },
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
      const file: FileNode = {
        id: "file:src/k.ts",
        kind: "file",
        name: "k.ts",
        parent: "folder:src",
        children: [],
        features: [],
        path: "src/k.ts",
        content: "",
        language: "typescript",
        rawImports: [],
        exports: [],
        interfacePlan: {
          classes: [],
          entries: [
            {
              leafCapabilityId: "cap:k",
              kind: "function",
              ownerClassName: null,
              name: "kFn",
              signature: {
                params: [{ name: "x", type: "number" }],
                returnType: "number",
                isAsync: false,
              },
              description: "Returns 2x. Stuck.",
              exported: true,
              isStatic: false,
            },
          ],
        },
      };
      rpg.nodes[file.id] = file;
      (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
      rpg.nodes["cap:k"] = {
        id: "cap:k",
        kind: "capability",
        name: "kFn",
        parent: rpg.rootId,
        children: [],
        features: [],
        description: "Returns 2x. Stuck.",
        isLeaf: true,
        status: "mapped",
        mappedToId: file.id,
        decompositionDepth: 0,
      };
      root.children.push("cap:k");

      // Track how many TEST-AUTHOR calls each leaf id receives via the
      // user prompt's # Subject under test header.
      const testCallsByLeaf = new Map<string, number>();
      let kAttempt = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          const isTest = sys.includes("producing a vitest test file");
          const isBody = sys.includes("producing the body of a single");
          const isDecompose = sys.includes(
            "Architect agent diagnosing a stuck",
          );
          if (isTest) {
            // Slug the leaf name out of the user prompt — name appears
            // inside backticks after "Function `<name>`" / "Method ...".
            const m = user.match(/Function `([^`]+)`/);
            const leaf = m ? m[1]! : "?";
            testCallsByLeaf.set(leaf, (testCallsByLeaf.get(leaf) ?? 0) + 1);
            if (leaf === "kFn") {
              return {
                content: `import { describe, it, expect } from "vitest";
import { kFn } from "../../src/k.js";
describe("kFn", () => {
  it("doubles", () => {
    expect(kFn(2)).toBe(4);
    expect(kFn(0)).toBe(0);
  });
});
`,
                finishReason: "stop",
              };
            }
            if (leaf === "halve") {
              return {
                content: `import { describe, it, expect } from "vitest";
import { halve } from "../../src/k.js";
describe("halve", () => { it("halves", () => { expect(halve(4)).toBe(2); }); });
`,
                finishReason: "stop",
              };
            }
            if (leaf === "quadruple") {
              return {
                content: `import { describe, it, expect } from "vitest";
import { quadruple } from "../../src/k.js";
describe("quadruple", () => { it("4x", () => { expect(quadruple(1)).toBe(4); }); });
`,
                finishReason: "stop",
              };
            }
          }
          if (isBody) {
            const m = user.match(/Function `([^`]+)`/);
            const leaf = m ? m[1]! : "?";
            if (leaf === "kFn") {
              kAttempt++;
              if (kAttempt <= 2) return { content: "return 0;", finishReason: "stop" };
              return {
                content: "return quadruple(x) - halve(quadruple(x));",
                finishReason: "stop",
              };
            }
            if (leaf === "halve") return { content: "return x / 2;", finishReason: "stop" };
            if (leaf === "quadruple") return { content: "return x * 4;", finishReason: "stop" };
          }
          if (isDecompose) {
            return {
              content: JSON.stringify({
                decision: "decompose",
                reason: "split",
                subLeaves: [
                  {
                    name: "halve",
                    description: "halves",
                    signature: {
                      params: [{ name: "x", type: "number" }],
                      returnType: "number",
                      isAsync: false,
                    },
                    kind: "function",
                    ownerClassName: null,
                    isStatic: false,
                    exported: true,
                  },
                  {
                    name: "quadruple",
                    description: "x4",
                    signature: {
                      params: [{ name: "x", type: "number" }],
                      returnType: "number",
                      isAsync: false,
                    },
                    kind: "function",
                    ownerClassName: null,
                    isStatic: false,
                    exported: true,
                  },
                ],
              }),
              finishReason: "stop",
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await buildImplementations(client, rpg, {
        maxAttemptsPerLeaf: 2,
        hostRepo: process.cwd(),
      });
      expect(result.ok, JSON.stringify(result.decomposeDecisions)).toBe(true);

      // The original leaf's tests must have been authored EXACTLY ONCE.
      // If the orchestrator clears testsByLeafId on decompose, this
      // becomes 2 (re-authored before the assembly).
      expect(testCallsByLeaf.get("kFn")).toBe(1);
    },
  );
});

// ── Fix #3 — fresh_approach hint reaches body author ────────────────

describe("review fix #3 — fresh_approach hint threads to body author", () => {
  it(
    "the next body-author prompt contains the architect's approachHint",
    { timeout: 60_000 },
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
      const file: FileNode = {
        id: "file:src/p.ts",
        kind: "file",
        name: "p.ts",
        parent: "folder:src",
        children: [],
        features: [],
        path: "src/p.ts",
        content: "",
        language: "typescript",
        rawImports: [],
        exports: [],
        interfacePlan: {
          classes: [],
          entries: [
            {
              leafCapabilityId: "cap:p",
              kind: "function",
              ownerClassName: null,
              name: "pFn",
              signature: {
                params: [{ name: "n", type: "number" }],
                returnType: "number",
                isAsync: false,
              },
              description: "Returns 2*n.",
              exported: true,
              isStatic: false,
            },
          ],
        },
      };
      rpg.nodes[file.id] = file;
      (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
      rpg.nodes["cap:p"] = {
        id: "cap:p",
        kind: "capability",
        name: "pFn",
        parent: rpg.rootId,
        children: [],
        features: [],
        description: "Returns 2*n.",
        isLeaf: true,
        status: "mapped",
        mappedToId: file.id,
        decompositionDepth: 0,
      };
      root.children.push("cap:p");

      const HINT = "use bit-shift instead of multiplication";
      const bodyPrompts: string[] = [];
      let pAttempt = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          const isTest = sys.includes("producing a vitest test file");
          const isBody = sys.includes("producing the body of a single");
          const isDecompose = sys.includes("Architect agent diagnosing a stuck");

          if (isTest) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { pFn } from "../../src/p.js";
describe("pFn", () => { it("doubles", () => { expect(pFn(2)).toBe(4); }); });
`,
              finishReason: "stop",
            };
          }
          if (isBody) {
            bodyPrompts.push(user);
            pAttempt++;
            // First two attempts return wrong; third (post fresh_approach) returns correct.
            if (pAttempt <= 2) return { content: "return 0;", finishReason: "stop" };
            return { content: "return n << 1;", finishReason: "stop" };
          }
          if (isDecompose) {
            return {
              content: JSON.stringify({
                decision: "fresh_approach",
                reason: "single concern, retry with a different angle",
                approachHint: HINT,
              }),
              finishReason: "stop",
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await buildImplementations(client, rpg, {
        maxAttemptsPerLeaf: 2,
        hostRepo: process.cwd(),
      });
      expect(result.ok).toBe(true);
      expect(result.decomposeDecisions).toHaveLength(1);
      expect(result.decomposeDecisions[0]!.decision.kind).toBe("fresh_approach");

      // The body prompt issued AFTER fresh_approach must mention the
      // hint. Body prompts so far: 2 failing + 1 success = 3 total;
      // the third one is post-recovery.
      expect(bodyPrompts.length).toBeGreaterThanOrEqual(3);
      const postRecoveryPrompt = bodyPrompts[2]!;
      expect(postRecoveryPrompt).toContain(HINT);
    },
  );
});
