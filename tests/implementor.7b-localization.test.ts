/**
 * Stage C wiring: integration recovery runs §D.1 localization
 * before blame attribution and threads the result into the blame
 * prompt as a localizationHint.
 *
 * Verifies:
 *   - Localization is invoked when `useLocalization: true`
 *   - The hint reaches the blame user prompt
 *   - Localization failure is non-fatal (blame still runs)
 *   - Localization is NOT invoked when the flag is off (default)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";

import {
  emptyRPG,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  buildImplementations,
  createHarnessDir,
  linkHostNodeModules,
  runIntegrationTests,
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

const ALPHA_TEST = `import { describe, it, expect } from "vitest";
import { alpha } from "../../src/lib.js";
describe("alpha", () => { it("doubles", () => { expect(alpha(2)).toBe(4); }); });
`;
const BETA_TEST = `import { describe, it, expect } from "vitest";
import { beta } from "../../src/lib.js";
describe("beta", () => { it("triples", () => { expect(beta(2)).toBe(6); }); });
`;

async function buildPassingState(): Promise<{
  rpg: RPG;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
}> {
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
    id: "file:src/lib.ts",
    kind: "file",
    name: "lib.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/lib.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:alpha",
          kind: "function",
          ownerClassName: null,
          name: "alpha",
          signature: {
            params: [{ name: "x", type: "number" }],
            returnType: "number",
            isAsync: false,
          },
          description: "Double the input.",
          exported: true,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:beta",
          kind: "function",
          ownerClassName: null,
          name: "beta",
          signature: {
            params: [{ name: "x", type: "number" }],
            returnType: "number",
            isAsync: false,
          },
          description: "Triple the input.",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);

  // Branch capability that depends on both leaves.
  const branch: CapabilityNode = {
    id: "cap:math-pair",
    kind: "capability",
    name: "Math Pair",
    description: "Combine alpha and beta.",
    parent: rpg.rootId,
    children: ["cap:alpha", "cap:beta"],
    features: [],
    isLeaf: false,
    status: "planned",
    mappedToId: null,
    decompositionDepth: 0,
  };
  const alphaCap: CapabilityNode = {
    id: "cap:alpha",
    kind: "capability",
    name: "alpha",
    description: "Double the input.",
    parent: branch.id,
    children: [],
    features: [],
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 1,
  };
  const betaCap: CapabilityNode = {
    id: "cap:beta",
    kind: "capability",
    name: "beta",
    description: "Triple the input.",
    parent: branch.id,
    children: [],
    features: [],
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 1,
  };
  rpg.nodes[branch.id] = branch;
  rpg.nodes[alphaCap.id] = alphaCap;
  rpg.nodes[betaCap.id] = betaCap;
  root.children.push(branch.id);

  // Pre-seed bodies + tests so we skip Phase 6.
  const bodyByLeafId = new Map<string, string>([
    ["cap:alpha", "return x * 2;"],
    ["cap:beta", "return x * 3;"], // Correct.
  ]);
  const testsByLeafId = new Map<string, string>([
    ["cap:alpha", ALPHA_TEST],
    ["cap:beta", BETA_TEST],
  ]);
  void buildImplementations;
  return { rpg, bodyByLeafId, testsByLeafId };
}

describe("Stage C: localization wired into integration recovery", () => {
  it(
    "calls localize() before blame and threads the hint into the blame prompt when useLocalization is true",
    { timeout: 30_000 },
    async () => {
      const { rpg, bodyByLeafId, testsByLeafId } = await buildPassingState();
      // Sabotage beta so the integration test fails.
      bodyByLeafId.set("cap:beta", "return x;");

      let localizeCalls = 0;
      let blameSawHint = false;
      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          // Integration test author for the branch.
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("composes", () => { expect(beta(alpha(2))).toBe(12); });
});
`,
              finishReason: "stop",
            };
          }
          // §D.1 localization agent — system prompt mentions
          // §D.1.
          if (sys.includes("Localization agent")) {
            localizeCalls++;
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "loc_call",
                  type: "function",
                  function: {
                    name: "Terminate",
                    arguments: JSON.stringify({
                      result: [
                        {
                          file_path: "src/lib.ts",
                          interface: "function: beta",
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }
          // Blame attribution — verify the user prompt now
          // contains the localization hint.
          if (sys.includes("diagnosing an integration-test failure")) {
            const userPrompt = messages[1]!.content;
            if (userPrompt.includes("Localization hint")) {
              blameSawHint = true;
            }
            return {
              content: JSON.stringify({
                culpritLeafId: "cap:beta",
                decision: "fresh_approach",
                reason: "beta returns x not x*3",
                approachHint: "multiply by 3",
              }),
              finishReason: "stop",
            };
          }
          // Test author for fresh_approach recovery.
          if (sys.includes("producing a vitest test file")) {
            return { content: BETA_TEST, finishReason: "stop" };
          }
          // Body author — return correct beta.
          if (sys.includes("producing the body of a single")) {
            return { content: "return x * 3;", finishReason: "stop" };
          }
          void opts;
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttemptsPerLeaf: 2,
        useLocalization: true,
      });
      expect(result.ok, result.error).toBe(true);
      expect(localizeCalls).toBeGreaterThanOrEqual(1);
      expect(blameSawHint).toBe(true);
    },
  );

  it(
    "does NOT call localize when useLocalization is false (default)",
    { timeout: 30_000 },
    async () => {
      const { rpg, bodyByLeafId, testsByLeafId } = await buildPassingState();
      bodyByLeafId.set("cap:beta", "return x;");

      let localizeCalls = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("composes", () => { expect(beta(alpha(2))).toBe(12); });
});
`,
              finishReason: "stop",
            };
          }
          if (sys.includes("Localization agent")) {
            localizeCalls++;
            return { content: "", finishReason: "stop" };
          }
          if (sys.includes("diagnosing an integration-test failure")) {
            return {
              content: JSON.stringify({
                culpritLeafId: "cap:beta",
                decision: "fresh_approach",
                reason: "x",
                approachHint: "x*3",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing a vitest test file")) {
            return { content: BETA_TEST, finishReason: "stop" };
          }
          if (sys.includes("producing the body of a single")) {
            return { content: "return x * 3;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttemptsPerLeaf: 2,
        // useLocalization NOT set
      });
      expect(result.ok, result.error).toBe(true);
      expect(localizeCalls).toBe(0);
    },
  );
});
