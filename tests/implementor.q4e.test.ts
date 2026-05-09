/**
 * Step Q4-E: integration rework via dep blame.
 *
 * When an integration-style leaf (whose test exercises sibling
 * leaves) fails AND the failure message references a symbol
 * owned by one of its dependencies, the orchestrator should
 * fresh_approach the DEP rather than the failing leaf — the dep
 * is the likely culprit and re-attempting the integration
 * against the same broken dep wastes budget.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildImplementations } from "../src/implementor/orchestrator.js";
import { emptyRPG } from "../src/rpg/index.js";
import type {
  CapabilityNode,
  FileNode,
  FolderNode,
  PlannedInterface,
  RPG,
} from "../src/rpg/types.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function plannedFn(name: string, capId: string): PlannedInterface {
  return {
    leafCapabilityId: capId,
    kind: "function",
    name,
    ownerClassName: null,
    description: "",
    signature: {
      params: [
        { name: "a", type: "number" },
        { name: "b", type: "number" },
      ],
      returnType: "number",
      isAsync: false,
    },
    exported: true,
    isStatic: false,
  };
}

function mkFileNode(opts: {
  id: string;
  path: string;
  entries: PlannedInterface[];
}): FileNode {
  return {
    id: opts.id,
    kind: "file",
    name: opts.path.split("/").pop() ?? "",
    path: opts.path,
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    parent: "folder:src",
    children: [],
    features: [],
    interfacePlan: { entries: opts.entries, classes: [] },
  };
}

function rpgWithFiles(files: FileNode[], leafCapIds: string[]): RPG {
  const rpg = emptyRPG();
  const folder: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    path: "src",
    parent: null,
    children: [...files.map((f) => f.id), ...leafCapIds],
    features: [],
  };
  rpg.nodes[folder.id] = folder;
  for (const f of files) rpg.nodes[f.id] = f;
  for (const capId of leafCapIds) {
    const owner = files.find((f) =>
      (f.interfacePlan?.entries ?? []).some(
        (e) => e.leafCapabilityId === capId,
      ),
    );
    const cap: CapabilityNode = {
      id: capId,
      kind: "capability",
      name: capId.replace("cap:", ""),
      description: "",
      parent: "folder:src",
      children: [],
      features: [],
      isLeaf: true,
      status: "planned",
      mappedToId: owner?.id ?? null,
      decompositionDepth: 0,
    };
    rpg.nodes[capId] = cap;
  }
  return rpg;
}

let _outDir: string;

beforeEach(async () => {
  _outDir = await mkdtemp(path.join(tmpdir(), "q4e-"));
});

afterEach(async () => {
  if (_outDir) await rm(_outDir, { recursive: true, force: true });
});

describe("Q4-E — dep blame on integration leaf failure", () => {
  it(
    "fresh_approaches the dep whose symbol appears in the integration failure",
    { timeout: 60_000 },
    async () => {
      // dep `compute` and integration leaf `runIntegration`
      // whose test imports compute. Mock the integration leaf to
      // fail with a message referencing `compute`. Expect
      // decomposeDecisions to record a `fresh_approach` keyed on
      // compute's leaf id.
      const dep = mkFileNode({
        id: "file:compute",
        path: "src/compute.ts",
        entries: [plannedFn("compute", "cap:compute")],
      });
      const integ = mkFileNode({
        id: "file:integ",
        path: "src/integ.ts",
        entries: [plannedFn("runIntegration", "cap:integ")],
      });
      const rpg = rpgWithFiles([dep, integ], ["cap:compute", "cap:integ"]);

      // Pre-populate tests so we control the dep graph deterministically.
      const tests = new Map<string, string>([
        [
          "cap:compute",
          `import { describe, it, expect } from "vitest";
import { compute } from "../../src/compute.js";
describe("compute", () => { it("ok", () => { expect(compute(2,3)).toBe(5); }); });
`,
        ],
        [
          "cap:integ",
          `import { describe, it, expect } from "vitest";
import { runIntegration } from "../../src/integ.js";
import { compute } from "../../src/compute.js";
describe("runIntegration", () => { it("calls compute", () => { expect(runIntegration()).toBe(compute(2,3)); }); });
`,
        ],
      ]);

      // Mock LLM:
      //   - compute leaf: dev loop edits to a WRONG body, test
      //     fails — but dev loop terminates so the leaf gets
      //     marked landed (compute landed first, integ runs
      //     after via dep gating).
      //   - Actually simpler: have compute land green; integ
      //     fail with a failure message referencing "compute".
      //
      // We need to BUMP `attempts` enough that we see the blame
      // path. The blame fires on first failure too — but we'd
      // need to track decomposeDecisions to verify.
      let computeCalls = 0;
      let integCalls = 0;
      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const userPrompt = messages[1]?.content ?? "";
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            // Tests are already pre-populated; the
            // authorAllLeafTests phase should skip these. This
            // branch shouldn't fire — but if it does, return
            // any valid test.
            return {
              content: `import { describe, it, expect } from "vitest";\ndescribe("x", () => { it("ok", () => { expect(true).toBe(true); }); });\n`,
              finishReason: "stop",
            };
          }
          if (sys.includes("Implementor agent") && opts?.tools) {
            const isCompute = userPrompt.includes("`compute`");
            const isInteg = userPrompt.includes("`runIntegration`");
            if (isCompute) {
              computeCalls++;
              const toolMsgCount = messages.filter(
                (m) => m.role === "tool",
              ).length;
              if (toolMsgCount === 0) {
                return {
                  content: "",
                  finishReason: "tool_calls",
                  toolCalls: [
                    {
                      id: `compute-${computeCalls}`,
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "src/compute.ts",
                          old_str: 'throw new Error("compute: not implemented");',
                          new_str: "return a + b;",
                        }),
                      },
                    },
                  ],
                };
              }
              return {
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: `compute-T-${computeCalls}`,
                    type: "function",
                    function: {
                      name: "Terminate",
                      arguments: JSON.stringify({}),
                    },
                  },
                ],
              };
            }
            if (isInteg) {
              integCalls++;
              const toolMsgCount = messages.filter(
                (m) => m.role === "tool",
              ).length;
              if (toolMsgCount === 0) {
                // Edit body to a wrong value (returns 0 instead
                // of compute()). The test will fail and the
                // failure message will reference `compute`.
                return {
                  content: "",
                  finishReason: "tool_calls",
                  toolCalls: [
                    {
                      id: `integ-${integCalls}`,
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "src/integ.ts",
                          old_str:
                            'throw new Error("runIntegration: not implemented");',
                          new_str: "return 0;",
                        }),
                      },
                    },
                  ],
                };
              }
              return {
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: `integ-T-${integCalls}`,
                    type: "function",
                    function: {
                      name: "Terminate",
                      arguments: JSON.stringify({}),
                    },
                  },
                ],
              };
            }
          }
          // Decompose architect call — return depth_exhausted to
          // signal the architect can't help. Blame should fire
          // BEFORE this; if it does fire, the test should fail.
          if (sys.includes("Architect")) {
            return {
              content: JSON.stringify({
                kind: "depth_exhausted",
                reason: "test should not reach here — blame should bypass",
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
        useDevLoop: true,
        devLoopMaxIterations: 3,
        // Tight budgets so the test converges quickly.
        maxAttemptsPerLeaf: 1,
        maxConcurrentLeaves: 1,
        preAuthorTestsAndGateOnDeps: true,
        initialTestsByLeafId: tests,
      });
      const blameDecisions = result.decomposeDecisions.filter(
        (d) =>
          d.decision.kind === "fresh_approach" &&
          d.decision.reason.includes("dep-blame"),
      );
      // Whether blame fires depends on the failure message
      // containing "compute". With our mock, the failing assertion
      // (expected `compute(2,3)` actual `0`) does include the
      // word "compute" in the test source we author. Verify.
      expect(blameDecisions.length).toBeGreaterThan(0);
      const blame = blameDecisions[0]!;
      expect(blame.originLeafId).toBe("cap:integ");
      expect(blame.decision.kind).toBe("fresh_approach");
      expect(blame.decision.reason).toContain("compute");
    },
  );

  it("does not blame when no dep symbol appears in the failure message", { timeout: 30_000 }, async () => {
    // A leaf with a dep, but the failure message doesn't
    // mention the dep. Blame should NOT fire — the architect's
    // decompose path takes over.
    const dep = mkFileNode({
      id: "file:dep",
      path: "src/dep.ts",
      entries: [plannedFn("helperFn", "cap:dep")],
    });
    const main = mkFileNode({
      id: "file:main",
      path: "src/main.ts",
      entries: [plannedFn("mainFn", "cap:main")],
    });
    const rpg = rpgWithFiles([dep, main], ["cap:dep", "cap:main"]);

    // Mock that lands dep then makes main fail with a generic
    // message that doesn't reference helperFn.
    const client: LLMClient = {
      async chat(messages, opts): Promise<LLMResponse> {
        const sys = messages[0]!.content;
        const userPrompt = messages[1]?.content ?? "";
        if (
          sys.includes("producing a vitest test file") &&
          !opts?.tools
        ) {
          // Author tests that DO NOT cross-import (so the dep
          // graph stays empty). This makes "blame" not fire
          // for the right reason — there's no dep relation.
          if (userPrompt.includes("helperFn")) {
            return {
              content: `import { describe, it, expect } from "vitest";\nimport { helperFn } from "../../src/dep.js";\ndescribe("helperFn", () => { it("ok", () => { expect(helperFn(2,3)).toBe(5); }); });\n`,
              finishReason: "stop",
            };
          }
          return {
            content: `import { describe, it, expect } from "vitest";\nimport { mainFn } from "../../src/main.js";\ndescribe("mainFn", () => { it("ok", () => { expect(mainFn(2,3)).toBe(5); }); });\n`,
            finishReason: "stop",
          };
        }
        if (sys.includes("Implementor agent") && opts?.tools) {
          const name = userPrompt.includes("helperFn") ? "helperFn" : "mainFn";
          const file = userPrompt.includes("helperFn") ? "dep" : "main";
          const toolMsgCount = messages.filter((m) => m.role === "tool").length;
          if (toolMsgCount === 0) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `e-${name}`,
                  type: "function",
                  function: {
                    name: "edit_file",
                    arguments: JSON.stringify({
                      path: `src/${file}.ts`,
                      old_str: `throw new Error("${name}: not implemented");`,
                      new_str: name === "mainFn" ? "return 0;" : "return a + b;",
                    }),
                  },
                },
              ],
            };
          }
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `t-${name}`,
                type: "function",
                function: {
                  name: "Terminate",
                  arguments: JSON.stringify({}),
                },
              },
            ],
          };
        }
        if (sys.includes("Architect")) {
          return {
            content: JSON.stringify({
              kind: "depth_exhausted",
              reason: "no fix available",
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
      useDevLoop: true,
      devLoopMaxIterations: 3,
      maxAttemptsPerLeaf: 1,
      maxConcurrentLeaves: 1,
      preAuthorTestsAndGateOnDeps: true,
    });
    // No dep-blame decision should appear (dep graph between
    // these two leaves is empty since their tests don't
    // cross-import).
    const blameDecisions = result.decomposeDecisions.filter(
      (d) =>
        d.decision.kind === "fresh_approach" &&
        d.decision.reason.includes("dep-blame"),
    );
    expect(blameDecisions).toHaveLength(0);
  });
});
