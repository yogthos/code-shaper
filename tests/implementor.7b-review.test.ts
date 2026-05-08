/**
 * Phase 7b review-fix acceptance.
 *
 *   #1 materialize wipes stale test files at the start of a run, so
 *      a leaf or branch removed from the test maps doesn't have its
 *      old test file vitest-resurrected.
 *   #2 failing-branch tracking is incremental: branches that passed
 *      in an earlier round don't get re-flagged as failing just
 *      because they weren't in the next round's filter.
 *   #3 a branch with an unmapped leaf is rejected up front rather
 *      than authoring an integration test with a broken import.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";

import {
  emptyRPG,
  type CapabilityNode,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  createHarnessDir,
  linkHostNodeModules,
  runIntegrationTests,
  runTests,
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

function buildSampleRpg(): { rpg: RPG; hostFile: FileNode } {
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
    id: "file:src/x.ts",
    kind: "file",
    name: "x.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/x.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:fn",
          kind: "function",
          ownerClassName: null,
          name: "fn",
          signature: { params: [], returnType: "number", isAsync: false },
          description: "x",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
  return { rpg, hostFile: file };
}

describe("review fix #1 — stale test files cleared on materialize", () => {
  it(
    "removes a leaf test file that's no longer in the testsByLeafId map",
    { timeout: 30_000 },
    async () => {
      const { rpg } = buildSampleRpg();

      // Round 1: write a test for cap:fn.
      const r1 = await runTests(rpg, {
        bodyByLeafId: new Map([["cap:fn", "return 0;"]]),
        testsByLeafId: new Map([
          [
            "cap:fn",
            `import { describe, it, expect } from "vitest";
import { fn } from "../../src/x.js";
describe("fn", () => { it("returns 0", () => { expect(fn()).toBe(0); }); });
`,
          ],
        ]),
        workDir,
      });
      expect(r1.ok).toBe(true);
      const dir = path.join(workDir, "tests/leaves");
      const filesAfter1 = await readdir(dir);
      expect(filesAfter1).toContain("cap_fn.test.ts");

      // Round 2: empty test map. The directory should be cleared.
      const r2 = await runTests(rpg, {
        bodyByLeafId: new Map([["cap:fn", "return 0;"]]),
        testsByLeafId: new Map(),
        workDir,
      });
      // Run is OK because no tests are written, vitest finds nothing
      // to run — but more importantly, the prior file is gone.
      void r2;
      const filesAfter2 = await readdir(dir);
      expect(filesAfter2).not.toContain("cap_fn.test.ts");
    },
  );
});

describe("review fix #2 — incremental failing-branch tracking", () => {
  it(
    "branches that pass in round 1 stay passing across recovery rounds",
    { timeout: 120_000 },
    async () => {
      // Build an RPG with TWO branches: branchGood (passes always)
      // and branchBad (fails first round, then needs recovery).
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
        id: "file:src/m.ts",
        kind: "file",
        name: "m.ts",
        parent: "folder:src",
        children: [],
        features: [],
        path: "src/m.ts",
        content: "",
        language: "typescript",
        rawImports: [],
        exports: [],
        interfacePlan: {
          classes: [],
          entries: [
            {
              leafCapabilityId: "cap:g1",
              kind: "function",
              ownerClassName: null,
              name: "g1",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "g1",
              exported: true,
              isStatic: false,
            },
            {
              leafCapabilityId: "cap:g2",
              kind: "function",
              ownerClassName: null,
              name: "g2",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "g2",
              exported: true,
              isStatic: false,
            },
            {
              leafCapabilityId: "cap:b1",
              kind: "function",
              ownerClassName: null,
              name: "b1",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "b1",
              exported: true,
              isStatic: false,
            },
            {
              leafCapabilityId: "cap:b2",
              kind: "function",
              ownerClassName: null,
              name: "b2",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "b2",
              exported: true,
              isStatic: false,
            },
          ],
        },
      };
      rpg.nodes[file.id] = file;
      (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);

      const branchGood: CapabilityNode = {
        id: "cap:branchGood",
        kind: "capability",
        name: "Good",
        parent: rpg.rootId,
        children: ["cap:g1", "cap:g2"],
        features: [],
        description: "Good branch.",
        isLeaf: false,
        status: "mapped",
        mappedToId: "folder:src",
        decompositionDepth: 0,
      };
      const branchBad: CapabilityNode = {
        id: "cap:branchBad",
        kind: "capability",
        name: "Bad",
        parent: rpg.rootId,
        children: ["cap:b1", "cap:b2"],
        features: [],
        description: "Bad branch.",
        isLeaf: false,
        status: "mapped",
        mappedToId: "folder:src",
        decompositionDepth: 0,
      };
      for (const id of ["cap:g1", "cap:g2", "cap:b1", "cap:b2"]) {
        const isGood = id.startsWith("cap:g");
        rpg.nodes[id] = {
          id,
          kind: "capability",
          name: id.slice(4),
          parent: isGood ? branchGood.id : branchBad.id,
          children: [],
          features: [],
          description: id,
          isLeaf: true,
          status: "mapped",
          mappedToId: file.id,
          decompositionDepth: 0,
        };
      }
      rpg.nodes[branchGood.id] = branchGood;
      rpg.nodes[branchBad.id] = branchBad;
      root.children.push(branchGood.id, branchBad.id);

      const bodyByLeafId = new Map([
        ["cap:g1", "return 1;"],
        ["cap:g2", "return 2;"],
        // b1 wrong — integration test for branchBad will fail.
        ["cap:b1", "return 0;"],
        ["cap:b2", "return 4;"],
      ]);
      const testsByLeafId = new Map([
        [
          "cap:g1",
          `import { describe, it, expect } from "vitest";
import { g1 } from "../../src/m.js";
describe("g1", () => { it("returns 1", () => { expect(g1()).toBe(1); }); });
`,
        ],
        [
          "cap:g2",
          `import { describe, it, expect } from "vitest";
import { g2 } from "../../src/m.js";
describe("g2", () => { it("returns 2", () => { expect(g2()).toBe(2); }); });
`,
        ],
        [
          "cap:b1",
          `import { describe, it, expect } from "vitest";
import { b1 } from "../../src/m.js";
describe("b1", () => { it("returns 3", () => { expect(b1()).toBe(3); }); });
`,
        ],
        [
          "cap:b2",
          `import { describe, it, expect } from "vitest";
import { b2 } from "../../src/m.js";
describe("b2", () => { it("returns 4", () => { expect(b2()).toBe(4); }); });
`,
        ],
      ]);

      // We need b1 to PASS its unit test even though it fails the
      // integration test. Make b1's unit test compatible with the
      // wrong body — assert b1 returns 0 (the broken behavior).
      testsByLeafId.set(
        "cap:b1",
        `import { describe, it, expect } from "vitest";
import { b1 } from "../../src/m.js";
describe("b1", () => { it("returns 0", () => { expect(b1()).toBe(0); }); });
`,
      );

      const goodIntegration = `import { describe, it, expect } from "vitest";
import { g1, g2 } from "../../src/m.js";
describe("Good", () => { it("composes", () => { expect(g1() + g2()).toBe(3); }); });
`;
      const badIntegration = `import { describe, it, expect } from "vitest";
import { b1, b2 } from "../../src/m.js";
describe("Bad", () => { it("composes", () => { expect(b1() + b2()).toBe(7); }); });
`;
      const fixedB1Test = `import { describe, it, expect } from "vitest";
import { b1 } from "../../src/m.js";
describe("b1", () => { it("returns 3", () => { expect(b1()).toBe(3); }); });
`;
      void fixedB1Test;

      let blameCalls = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          if (sys.includes("integration test for a branch")) {
            if (user.includes("# Branch: Good")) {
              return { content: goodIntegration, finishReason: "stop" };
            }
            return { content: badIntegration, finishReason: "stop" };
          }
          if (sys.includes("diagnosing an integration-test failure")) {
            blameCalls++;
            return {
              content: JSON.stringify({
                culpritLeafId: "cap:b1",
                decision: "fresh_approach",
                reason: "b1 returns 0 instead of 3",
                approachHint: "return 3",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing a vitest test file")) {
            // Used when test source is missing; in our flow it's
            // pre-populated, so this should rarely fire.
            const m = user.match(/Function `([^`]+)`/);
            const leaf = m ? m[1]! : "?";
            return {
              content: testsByLeafId.get(`cap:${leaf}`) ?? "",
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            // Body-author fixes b1 to return 3 (per approachHint).
            return { content: "return 3;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        // The branchGood integration is correct from the start; we
        // also need b1's unit test to flip BACK to expecting 3 once
        // the body is corrected. Simulate that by updating the test
        // map mid-run via `testsByLeafId` after the recovery body
        // would land. Easiest: pre-set both tests identically
        // expecting return-3, but since b1's body is initially wrong
        // its unit test would fail too — which we DON'T want here
        // because the goal is "b1 passes unit test, fails integration."
        //
        // Simpler: just set b1's unit test to expect whatever b1
        // returns at any moment via dynamic assertion. Use a loose
        // assertion that always passes for this test fixture.
        testsByLeafId: new Map([
          ...testsByLeafId,
          [
            "cap:b1",
            `import { describe, it, expect } from "vitest";
import { b1 } from "../../src/m.js";
describe("b1", () => { it("is a number", () => { expect(typeof b1()).toBe("number"); }); });
`,
          ],
        ]),
        workDir,
        maxAttemptsPerLeaf: 2,
      });
      expect(r.ok, r.error ?? r.failingBranchIds.join(",")).toBe(true);
      // Exactly one blame call — branchBad failed, branchGood never
      // had to be re-checked. If the bug were unfixed, we'd see at
      // least 2 blame calls because branchGood would falsely flag.
      expect(blameCalls).toBe(1);
      // Rounds: 1 (initial all-branches) + 1 (recovery) = 2.
      expect(r.rounds).toBe(2);
    },
  );
});

describe("review fix #3 — unmapped leaf in a branch is rejected", () => {
  it("returns ok=false with a clear error when a branch leaf has no host file", async () => {
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

    // The host file holds plan entries for BOTH leaves so the branch
    // is discoverable; one leaf's `mappedToId` is null though, which
    // is the inconsistency we want to detect up-front.
    const file: FileNode = {
      id: "file:src/x.ts",
      kind: "file",
      name: "x.ts",
      parent: "folder:src",
      children: [],
      features: [],
      path: "src/x.ts",
      content: "",
      language: "typescript",
      rawImports: [],
      exports: [],
      interfacePlan: {
        classes: [],
        entries: [
          {
            leafCapabilityId: "cap:l1",
            kind: "function",
            ownerClassName: null,
            name: "l1",
            signature: { params: [], returnType: "number", isAsync: false },
            description: "x",
            exported: true,
            isStatic: false,
          },
          {
            leafCapabilityId: "cap:l2",
            kind: "function",
            ownerClassName: null,
            name: "l2",
            signature: { params: [], returnType: "number", isAsync: false },
            description: "x",
            exported: true,
            isStatic: false,
          },
        ],
      },
    };
    rpg.nodes[file.id] = file;
    (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);

    const branch: CapabilityNode = {
      id: "cap:b",
      kind: "capability",
      name: "B",
      parent: rpg.rootId,
      children: ["cap:l1", "cap:l2"],
      features: [],
      description: "x",
      isLeaf: false,
      status: "mapped",
      mappedToId: rpg.rootId,
      decompositionDepth: 0,
    };
    rpg.nodes["cap:b"] = branch;
    rpg.nodes["cap:l1"] = {
      id: "cap:l1",
      kind: "capability",
      name: "l1",
      parent: branch.id,
      children: [],
      features: [],
      description: "x",
      isLeaf: true,
      status: "mapped",
      mappedToId: file.id,
      decompositionDepth: 0,
    };
    rpg.nodes["cap:l2"] = {
      id: "cap:l2",
      kind: "capability",
      name: "l2",
      parent: branch.id,
      children: [],
      features: [],
      description: "x",
      isLeaf: true,
      // INCONSISTENT: a plan entry exists in `file:src/x.ts` for this
      // leaf, but the capability's mappedToId says it isn't mapped.
      // Phase 7b should reject this rather than author a test that
      // imports from a guessed file.
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    root.children.push(branch.id);

    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: "", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const r = await runIntegrationTests(client, rpg, {
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      workDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unmapped/i);
  });
});
