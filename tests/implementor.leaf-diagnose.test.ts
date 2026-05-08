/**
 * Per-leaf failure diagnosis + auto-fix.
 *
 * Exercises §5.3 + Algorithm 4 wiring:
 *   - When `diagnosis.enabled = true`, every body-retry failure
 *     fires a 5-round MV diagnostic.
 *   - On `test_brittleness` verdict, the test is rewritten via the
 *     test reviser and re-run against the same body.
 *   - On `implementation` verdict, the body retry continues normally.
 *   - The result reports `testRewrites` and the diagnostic trail.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm } from "node:fs/promises";

import {
  emptyRPG,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  createHarnessDir,
  implementLeaf,
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

function buildAddFnRpg(): { rpg: RPG; hostFile: FileNode; leafId: string } {
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
  const leafId = "cap:add";
  const file: FileNode = {
    id: "file:src/add.ts",
    kind: "file",
    name: "add.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/add.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [
        {
          leafCapabilityId: leafId,
          kind: "function",
          ownerClassName: null,
          name: "add",
          signature: {
            params: [
              { name: "a", type: "number" },
              { name: "b", type: "number" },
            ],
            returnType: "number",
            isAsync: false,
          },
          description: "Sum two numbers.",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
  return { rpg, hostFile: file, leafId };
}

// A test that asserts an over-strict thing and one that asserts the
// correct thing. We seed the brittle one and let the diagnostic
// trigger the rewrite.
const BRITTLE_TEST = `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";
describe("add", () => {
  it("returns 99 (over-strict)", () => {
    expect(add(2, 3)).toBe(99);
  });
});
`;

const FIXED_TEST = `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";
describe("add", () => {
  it("returns the sum", () => {
    expect(add(2, 3)).toBe(5);
  });
});
`;

describe("implementLeaf — diagnostic-driven test rewrite", () => {
  it(
    "diagnoses test_brittleness, rewrites the test, retries against the same body, and succeeds",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddFnRpg();
      const callTrail: string[] = [];

      // Mock client: depending on the system prompt content, return:
      //   - body author: a CORRECT implementation (2 + 3 = 5)
      //   - 5 diagnostic rounds: all vote test_brittleness with a hint
      //   - test reviser (test author with revise turn): emit FIXED_TEST
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          // Detect the test reviser by the corrective user turn (it's
          // appended after the prior test source as assistant). The
          // initial test author has only system + user messages.
          if (
            sys.includes("producing a vitest test file") &&
            messages.length > 2
          ) {
            callTrail.push("test_reviser");
            return { content: FIXED_TEST, finishReason: "stop" };
          }
          if (sys.includes("producing a vitest test file")) {
            callTrail.push("test_author");
            return { content: BRITTLE_TEST, finishReason: "stop" };
          }
          if (sys.includes("Diagnostic agent")) {
            callTrail.push("diagnose");
            return {
              content: JSON.stringify({
                category: "test_brittleness",
                reasoning: "expects 99 instead of the actual sum",
                testRewriteHint: "expect add(2,3) to be 5, not 99",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            callTrail.push("body_author");
            return { content: "return a + b;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const bodyByLeafId = new Map<string, string>();
      const testsByLeafId = new Map<string, string>();
      const result = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttempts: 3,
        maxTestRewrites: 5,
        diagnosis: { enabled: true, rounds: 5, afterFailures: 0 },
      });

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.testRewrites).toBe(1);
      expect(result.diagnoses?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(result.diagnoses![0]!.category).toBe("test_brittleness");
      // 5 diagnostic rounds + 1 test reviser call must have fired.
      const diagCount = callTrail.filter((c) => c === "diagnose").length;
      const reviserCount = callTrail.filter(
        (c) => c === "test_reviser",
      ).length;
      expect(diagCount).toBe(5);
      expect(reviserCount).toBe(1);
    },
  );

  it(
    "passes through implementation verdicts unchanged (no test rewrite, normal body retry)",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddFnRpg();
      let bodyAttempt = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            messages.length === 2
          ) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";
describe("add", () => { it("sums", () => { expect(add(2,3)).toBe(5); }); });
`,
              finishReason: "stop",
            };
          }
          if (sys.includes("Diagnostic agent")) {
            return {
              content: JSON.stringify({
                category: "implementation",
                reasoning: "body returns a-b instead of a+b",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            bodyAttempt++;
            // First body wrong, second right. Diagnostic should NOT
            // rewrite the test in between.
            if (bodyAttempt === 1) return { content: "return a - b;", finishReason: "stop" };
            return { content: "return a + b;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 3,
        diagnosis: { enabled: true, rounds: 5, afterFailures: 0 },
      });

      expect(result.ok).toBe(true);
      expect(result.testRewrites ?? 0).toBe(0);
      // One diagnosis fired (first body failed); none on the second
      // attempt (body succeeded).
      expect(result.diagnoses?.length ?? 0).toBe(1);
      expect(result.diagnoses![0]!.category).toBe("implementation");
    },
  );

  it(
    "stops invoking the diagnostic once maxTestRewrites is exhausted (review fix #4)",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddFnRpg();
      let diagCalls = 0;
      let bodyCalls = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            messages.length === 2
          ) {
            return { content: BRITTLE_TEST, finishReason: "stop" };
          }
          if (
            sys.includes("producing a vitest test file") &&
            messages.length > 2
          ) {
            // Reviser keeps producing the same brittle test (so the
            // re-run keeps failing). After maxTestRewrites=1 fires
            // once and is consumed, no further diagnostic should
            // run on subsequent failures.
            return { content: BRITTLE_TEST, finishReason: "stop" };
          }
          if (sys.includes("Diagnostic agent")) {
            diagCalls++;
            return {
              content: JSON.stringify({
                category: "test_brittleness",
                reasoning: "x",
                testRewriteHint: "y",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            bodyCalls++;
            return { content: "return a + b;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 3,
        diagnosis: { enabled: true, rounds: 5, afterFailures: 0 },
        maxTestRewrites: 1,
      });

      expect(result.ok).toBe(false);
      // First failure → diagnostic (5 rounds) → rewrite #1 (still brittle).
      // Second failure → no diagnostic (budget exhausted).
      // Third failure → no diagnostic.
      // Total diagnostic rounds: exactly 5 (one diagnose-and-act
      // event), not 15 (one per failure).
      expect(diagCalls).toBe(5);
      expect(bodyCalls).toBe(3);
      expect(result.testRewrites).toBe(1);
    },
  );

  it(
    "snapshots the original test before the first rewrite (review fix #3)",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddFnRpg();
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            messages.length === 2
          ) {
            return { content: BRITTLE_TEST, finishReason: "stop" };
          }
          if (
            sys.includes("producing a vitest test file") &&
            messages.length > 2
          ) {
            return { content: FIXED_TEST, finishReason: "stop" };
          }
          if (sys.includes("Diagnostic agent")) {
            return {
              content: JSON.stringify({
                category: "test_brittleness",
                reasoning: "x",
                testRewriteHint: "y",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            return { content: "return a + b;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const originalTestsByLeafId = new Map<string, string>();
      const result = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        originalTestsByLeafId,
        workDir,
        maxAttempts: 3,
        diagnosis: { enabled: true, rounds: 5, afterFailures: 0 },
      });

      expect(result.ok).toBe(true);
      // Snapshot map carries the ORIGINAL brittle test that was the
      // contract before the rewrite. Recovery paths in the
      // orchestrator use this to restore the original contract.
      const leafId = hostFile.interfacePlan!.entries[0]!.leafCapabilityId;
      expect(originalTestsByLeafId.has(leafId)).toBe(true);
      // The snapshot should be the ORIGINAL pre-rewrite test, not the
      // FIXED_TEST we ended up running.
      expect(originalTestsByLeafId.get(leafId)).toBe(BRITTLE_TEST.trim());
      expect(originalTestsByLeafId.get(leafId)).not.toBe(FIXED_TEST.trim());
    },
  );

  it(
    "keeps the prior test when the reviser emits unparseable source",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddFnRpg();
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            messages.length === 2
          ) {
            return { content: BRITTLE_TEST, finishReason: "stop" };
          }
          if (
            sys.includes("producing a vitest test file") &&
            messages.length > 2
          ) {
            // Reviser returns prose-laced garbage with mismatched
            // braces — tree-sitter will reject this even with its
            // permissive recovery. (Valid TS that's "not a test"
            // wouldn't be caught by parse validation alone; that's
            // a separate concern.)
            return {
              content: "import { describe } from 'vitest'; { unbalanced",
              finishReason: "stop",
            };
          }
          if (sys.includes("Diagnostic agent")) {
            return {
              content: JSON.stringify({
                category: "test_brittleness",
                reasoning: "x",
                testRewriteHint: "y",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            return { content: "return a + b;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 1,
        diagnosis: { enabled: true, rounds: 1, afterFailures: 0 },
      });

      // Body retry exhausts; rewrite was attempted but dropped due
      // to parse failure; testSource still equals BRITTLE_TEST
      // (after stripCodeFences's .trim()).
      expect(result.testSource).toBe(BRITTLE_TEST.trim());
      expect(result.testRewrites).toBe(0);
    },
  );
});
