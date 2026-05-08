/**
 * Phase 7a — orchestrator integration with the decompose loop.
 *
 * Drives `buildImplementations` against a mocked LLM that:
 *   1. Authors a test for a leaf called `combine`.
 *   2. Returns a wrong body twice, exhausting the per-leaf budget.
 *   3. Decomposes into two sub-leaves (`stepOne`, `stepTwo`).
 *   4. Authors tests + bodies for each sub-leaf (correct).
 *   5. Authors a fresh body for `combine` that calls the helpers.
 *
 * The build should end ok=true, decompose decision recorded, and the
 * sub-leaves' implementations present in the rendered code.
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
  linkHostNodeModules,
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

function buildRpg(): {
  rpg: RPG;
  parentCap: CapabilityNode;
  leafCap: CapabilityNode;
  hostFile: FileNode;
} {
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
    id: "file:src/combine.ts",
    kind: "file",
    name: "combine.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/combine.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:combine",
          kind: "function",
          ownerClassName: null,
          name: "combine",
          signature: {
            params: [
              { name: "a", type: "number" },
              { name: "b", type: "number" },
            ],
            returnType: "number",
            isAsync: false,
          },
          description: "Returns 2*a + 3*b. Stuck — needs decomposition.",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);

  const parentCap: CapabilityNode = {
    id: "cap:parent",
    kind: "capability",
    name: "Combine Group",
    parent: rpg.rootId,
    children: [],
    features: [],
    description: "group",
    isLeaf: false,
    status: "mapped",
    mappedToId: "folder:src",
    decompositionDepth: 0,
  };
  rpg.nodes[parentCap.id] = parentCap;
  root.children.push(parentCap.id);

  const leafCap: CapabilityNode = {
    id: "cap:combine",
    kind: "capability",
    name: "combine",
    parent: parentCap.id,
    children: [],
    features: [],
    description: "Returns 2*a + 3*b. Stuck — needs decomposition.",
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 0,
  };
  rpg.nodes[leafCap.id] = leafCap;
  parentCap.children.push(leafCap.id);
  return { rpg, parentCap, leafCap, hostFile: file };
}

const COMBINE_TEST_SOURCE = `import { describe, it, expect } from "vitest";
import { combine } from "../../src/combine.js";

describe("combine", () => {
  it("returns 2*a + 3*b", () => {
    expect(combine(2, 3)).toBe(13);
    expect(combine(0, 0)).toBe(0);
  });
});
`;

const STEP_ONE_TEST_SOURCE = `import { describe, it, expect } from "vitest";
import { stepOne } from "../../src/combine.js";

describe("stepOne", () => {
  it("doubles a", () => {
    expect(stepOne(2)).toBe(4);
  });
});
`;

const STEP_TWO_TEST_SOURCE = `import { describe, it, expect } from "vitest";
import { stepTwo } from "../../src/combine.js";

describe("stepTwo", () => {
  it("triples b", () => {
    expect(stepTwo(3)).toBe(9);
  });
});
`;

describe("buildImplementations — decompose recovery", () => {
  it(
    "decomposes a stuck leaf into helpers, then assembles successfully",
    { timeout: 120_000 },
    async () => {
      const { rpg, parentCap } = buildRpg();
      void parentCap;

      // We model the LLM's full conversation via a small state
      // machine indexed by a counter; the discriminator chooses the
      // right canned response based on which prompt arrived.
      const callLog: Array<{ phase: string; content: string }> = [];

      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          const isTest = sys.includes("producing a vitest test file");
          const isBody = sys.includes("producing the body of a single");
          const isDecompose = sys.includes("Architect agent diagnosing a stuck");

          let content = "";
          let phase = "?";

          if (isTest) {
            // Which leaf?
            if (user.includes("`combine`")) {
              content = COMBINE_TEST_SOURCE;
              phase = "test:combine";
            } else if (user.includes("`stepOne`")) {
              content = STEP_ONE_TEST_SOURCE;
              phase = "test:stepOne";
            } else if (user.includes("`stepTwo`")) {
              content = STEP_TWO_TEST_SOURCE;
              phase = "test:stepTwo";
            }
          } else if (isBody) {
            // Track which leaf via the user prompt's # Subject line.
            if (user.includes("Function `combine`")) {
              const combineCalls = callLog.filter((c) =>
                c.phase.startsWith("body:combine"),
              ).length;
              if (combineCalls === 0) content = "return 0;"; // wrong
              else if (combineCalls === 1) content = "return 1;"; // wrong
              // Third combine body call (after decompose) → assembly.
              else content = "return stepOne(a) + stepTwo(b);";
              phase = `body:combine#${combineCalls}`;
            } else if (user.includes("Function `stepOne`")) {
              content = "return a * 2;";
              phase = "body:stepOne";
            } else if (user.includes("Function `stepTwo`")) {
              content = "return b * 3;";
              phase = "body:stepTwo";
            }
          } else if (isDecompose) {
            content = JSON.stringify({
              decision: "decompose",
              reason: "two distinct concerns: doubling a, tripling b",
              subLeaves: [
                {
                  name: "stepOne",
                  description: "Returns a * 2.",
                  signature: {
                    params: [{ name: "a", type: "number" }],
                    returnType: "number",
                    isAsync: false,
                  },
                  kind: "function",
                  ownerClassName: null,
                  isStatic: false,
                  exported: true,
                },
                {
                  name: "stepTwo",
                  description: "Returns b * 3.",
                  signature: {
                    params: [{ name: "b", type: "number" }],
                    returnType: "number",
                    isAsync: false,
                  },
                  kind: "function",
                  ownerClassName: null,
                  isStatic: false,
                  exported: true,
                },
              ],
            });
            phase = "decompose";
          }

          callLog.push({ phase, content });
          return { content, finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await buildImplementations(client, rpg, {
        maxAttemptsPerLeaf: 2, // small budget so decompose triggers fast
        hostRepo: process.cwd(),
      });

      expect(
        result.ok,
        `build failed; decisions=${JSON.stringify(result.decomposeDecisions)}; leafResults=${JSON.stringify(result.leafResults.map((r) => ({ id: r.leafId, ok: r.ok, fatal: r.fatal })))}`,
      ).toBe(true);

      // Decompose decision was recorded.
      expect(result.decomposeDecisions).toHaveLength(1);
      const decision = result.decomposeDecisions[0]!;
      expect(decision.originLeafId).toBe("cap:combine");
      expect(decision.decision.kind).toBe("decompose");

      // Final assembly body uses the helpers.
      const file = rpg.nodes["file:src/combine.ts"] as FileNode;
      expect(file.content).toContain("function stepOne");
      expect(file.content).toContain("function stepTwo");
      expect(file.content).toContain("return stepOne(a) + stepTwo(b)");

      // Sub-leaves landed as capability nodes with depth=1.
      const newCaps = Object.values(rpg.nodes).filter(
        (n): n is CapabilityNode =>
          isCapability(n) && n.decompositionDepth === 1,
      );
      expect(newCaps.length).toBe(2);
      for (const cap of newCaps) {
        expect(cap.mappedToId).toBe(file.id);
        expect(cap.parent).toBe("cap:parent");
      }
    },
  );
});
