/**
 * Phase 7b acceptance.
 *
 *  - discoverBranches finds non-leaf capabilities with ≥2 leaf
 *    descendants and ignores everything else.
 *  - happy path: integration test passes on first run, ok=true,
 *    no recoveries.
 *  - recovery via fresh_approach: integration test fails first,
 *    architect blames a leaf, the next leaf body satisfies the
 *    integration assertion.
 *  - blame validation rejects an unknown culpritLeafId.
 *  - exhaustion: when every recovery still fails the integration,
 *    runIntegrationTests reports failingBranchIds + an error.
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
  discoverBranches,
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

/**
 * Build an RPG with a branch containing two leaves (`alpha`, `beta`)
 * mapped to one host file. Used by every test below.
 */
function buildRpg(): {
  rpg: RPG;
  branchCap: CapabilityNode;
  alpha: { cap: CapabilityNode };
  beta: { cap: CapabilityNode };
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
          description: "Returns x + 1.",
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
          description: "Returns x * 2.",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);

  const branchCap: CapabilityNode = {
    id: "cap:branch",
    kind: "capability",
    name: "Math Pair",
    parent: rpg.rootId,
    children: ["cap:alpha", "cap:beta"],
    features: [],
    description: "Pair of related math helpers.",
    isLeaf: false,
    status: "mapped",
    mappedToId: "folder:src",
    decompositionDepth: 0,
  };
  const alphaCap: CapabilityNode = {
    id: "cap:alpha",
    kind: "capability",
    name: "alpha",
    parent: branchCap.id,
    children: [],
    features: [],
    description: "Returns x + 1.",
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 0,
  };
  const betaCap: CapabilityNode = {
    id: "cap:beta",
    kind: "capability",
    name: "beta",
    parent: branchCap.id,
    children: [],
    features: [],
    description: "Returns x * 2.",
    isLeaf: true,
    status: "mapped",
    mappedToId: file.id,
    decompositionDepth: 0,
  };
  rpg.nodes[branchCap.id] = branchCap;
  rpg.nodes[alphaCap.id] = alphaCap;
  rpg.nodes[betaCap.id] = betaCap;
  root.children.push(branchCap.id);

  return {
    rpg,
    branchCap,
    alpha: { cap: alphaCap },
    beta: { cap: betaCap },
    hostFile: file,
  };
}

const ALPHA_TEST = `import { describe, it, expect } from "vitest";
import { alpha } from "../../src/lib.js";
describe("alpha", () => {
  it("adds 1", () => { expect(alpha(2)).toBe(3); });
});
`;

const BETA_TEST = `import { describe, it, expect } from "vitest";
import { beta } from "../../src/lib.js";
describe("beta", () => {
  it("doubles", () => { expect(beta(3)).toBe(6); });
});
`;

/** Stage a build that's already passed Phase 6 — body + test maps
 *  populated, host file rendered with bodies. Mirrors what the user
 *  would have on entering Phase 7b. */
async function passingBuild(): Promise<{
  rpg: RPG;
  branchCap: CapabilityNode;
  hostFile: FileNode;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
}> {
  const { rpg, branchCap, hostFile } = buildRpg();
  // Simulate Phase 6 having run by populating bodies + tests directly.
  const bodyByLeafId = new Map([
    ["cap:alpha", "return x + 1;"],
    ["cap:beta", "return x * 2;"],
  ]);
  const testsByLeafId = new Map([
    ["cap:alpha", ALPHA_TEST],
    ["cap:beta", BETA_TEST],
  ]);
  return { rpg, branchCap, hostFile, bodyByLeafId, testsByLeafId };
}

describe("discoverBranches", () => {
  it("returns the non-leaf capability with 2 leaves", () => {
    const { rpg } = buildRpg();
    const branches = discoverBranches(rpg);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.branch.id).toBe("cap:branch");
    expect(branches[0]!.leaves.map((l) => l.capability.id).sort()).toEqual([
      "cap:alpha",
      "cap:beta",
    ]);
  });

  it("ignores branches with fewer than 2 leaves", () => {
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    rpg.nodes["cap:single"] = {
      id: "cap:single",
      kind: "capability",
      name: "Solo",
      parent: rpg.rootId,
      children: ["cap:lone"],
      features: [],
      description: "x",
      isLeaf: false,
      status: "mapped",
      mappedToId: rpg.rootId,
      decompositionDepth: 0,
    };
    rpg.nodes["cap:lone"] = {
      id: "cap:lone",
      kind: "capability",
      name: "lone",
      parent: "cap:single",
      children: [],
      features: [],
      description: "x",
      isLeaf: true,
      status: "mapped",
      mappedToId: rpg.rootId,
      decompositionDepth: 0,
    };
    root.children.push("cap:single");
    expect(discoverBranches(rpg)).toEqual([]);
  });
});

describe("runIntegrationTests — happy path", () => {
  it(
    "passes on the first run with no recoveries",
    { timeout: 60_000 },
    async () => {
      const { rpg, bodyByLeafId, testsByLeafId } = await passingBuild();

      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("alpha then beta", () => {
    expect(beta(alpha(2))).toBe(6); // (2+1)*2
  });
});
`,
              finishReason: "stop",
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir,
      });
      expect(r.ok, r.error ?? r.failingBranchIds.join(",")).toBe(true);
      expect(r.recoveries).toEqual([]);
      expect(r.testsByBranchId.size).toBe(1);
    },
  );
});

describe("runIntegrationTests — fresh_approach recovery", () => {
  it(
    "blames the right leaf, applies fresh_approach, then passes",
    { timeout: 120_000 },
    async () => {
      const { rpg, bodyByLeafId, testsByLeafId } = await passingBuild();
      // Sabotage `beta`'s body so the integration test fails.
      bodyByLeafId.set("cap:beta", "return x;"); // off by ×2

      let blameCalls = 0;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("alpha then beta", () => {
    expect(beta(alpha(2))).toBe(6);
  });
});
`,
              finishReason: "stop",
            };
          }
          if (sys.includes("diagnosing an integration-test failure")) {
            blameCalls++;
            return {
              content: JSON.stringify({
                culpritLeafId: "cap:beta",
                decision: "fresh_approach",
                reason: "beta returns x instead of x*2",
                approachHint: "multiply x by 2",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing a vitest test file")) {
            // Re-author beta's unit test (cleared on culprit body
            // re-implement). Use the same content as before.
            return { content: BETA_TEST, finishReason: "stop" };
          }
          if (sys.includes("producing the body of a single")) {
            // Body author for beta — return the correct body (the
            // approachHint says multiply by 2).
            void user;
            return { content: "return x * 2;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttemptsPerLeaf: 2,
      });
      expect(r.ok, r.error).toBe(true);
      expect(r.recoveries).toHaveLength(1);
      expect(r.recoveries[0]!.culpritLeafId).toBe("cap:beta");
      expect(r.recoveries[0]!.decision).toBe("fresh_approach");
      expect(blameCalls).toBe(1);
      expect(bodyByLeafId.get("cap:beta")).toBe("return x * 2;");
    },
  );
});

describe("runIntegrationTests — recovery never satisfies the unit test", () => {
  it(
    "reports failing branches + an error when the culprit's body keeps failing its own unit test",
    { timeout: 180_000 },
    async () => {
      const { rpg, bodyByLeafId, testsByLeafId } = await passingBuild();
      bodyByLeafId.set("cap:beta", "return x;"); // permanent sabotage

      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("alpha then beta", () => {
    expect(beta(alpha(2))).toBe(6);
  });
});
`,
              finishReason: "stop",
            };
          }
          if (sys.includes("diagnosing an integration-test failure")) {
            return {
              content: JSON.stringify({
                culpritLeafId: "cap:beta",
                decision: "fresh_approach",
                reason: "beta",
                approachHint: "fix it",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("producing a vitest test file")) {
            return { content: BETA_TEST, finishReason: "stop" };
          }
          if (sys.includes("producing the body of a single")) {
            // Always return the wrong body — recovery never sticks.
            return { content: "return x;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttemptsPerLeaf: 1,
        // Cap rounds short of MAX_INTEGRATION_ROUNDS=20 so the
        // permanently-failing mock doesn't spin the full budget.
        // Both terminal paths (apply-error + round-exhaustion) reach
        // the same `r.ok = false` outcome we assert below.
        maxIntegrationRounds: 3,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBeDefined();
    },
  );
});

describe("runIntegrationTests — blame validation", () => {
  it(
    "rejects an unknown culpritLeafId and surfaces the error",
    { timeout: 60_000 },
    async () => {
      const { rpg, bodyByLeafId, testsByLeafId } = await passingBuild();
      bodyByLeafId.set("cap:beta", "return x;");

      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("composes", () => { expect(beta(alpha(2))).toBe(6); });
});
`,
              finishReason: "stop",
            };
          }
          if (sys.includes("diagnosing an integration-test failure")) {
            // Unknown leaf id.
            return {
              content: JSON.stringify({
                culpritLeafId: "cap:nonexistent",
                decision: "fresh_approach",
                reason: "x",
                approachHint: "y",
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

      const r = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttemptsPerLeaf: 1,
        // Tighten so we don't burn 20 rounds × 3 blame retries on
        // a test asserting validation behavior.
        maxIntegrationRounds: 2,
      });
      expect(r.ok).toBe(false);
      // Per the integration loop's continue-on-blame-failure
      // semantics: a single bad blame response no longer aborts
      // the whole integration — the loop records the validation
      // error on the recoveries trail and rolls into the next
      // round. So the top-level error is "exhausted N rounds"
      // and the validation detail lands in recoveries[*].applyError.
      expect(r.error).toMatch(/exhausted/i);
      const blameErrors = r.recoveries
        .map((rec) => rec.applyError ?? "")
        .filter((e) => e.length > 0);
      expect(blameErrors.length).toBeGreaterThan(0);
      expect(blameErrors.some((e) => /culpritLeafId/.test(e))).toBe(true);
    },
  );
});

describe("buildImplementations + runIntegrationTests — end-to-end", () => {
  it(
    "Phase 6 → Phase 7b succeeds on a branch whose leaves cooperate",
    { timeout: 180_000 },
    async () => {
      // Use buildImplementations to populate bodies + tests, then run
      // 7b on top. Assert the chain works without manual stitching.
      const { rpg } = buildRpg();
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          if (sys.includes("producing a vitest test file")) {
            if (user.includes("`alpha`")) {
              return { content: ALPHA_TEST, finishReason: "stop" };
            }
            if (user.includes("`beta`")) {
              return { content: BETA_TEST, finishReason: "stop" };
            }
          }
          if (sys.includes("producing the body of a single")) {
            if (user.includes("`alpha`")) {
              return { content: "return x + 1;", finishReason: "stop" };
            }
            if (user.includes("`beta`")) {
              return { content: "return x * 2;", finishReason: "stop" };
            }
          }
          if (sys.includes("integration test for a branch")) {
            return {
              content: `import { describe, it, expect } from "vitest";
import { alpha, beta } from "../../src/lib.js";
describe("Math Pair", () => {
  it("composes", () => { expect(beta(alpha(2))).toBe(6); });
});
`,
              finishReason: "stop",
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const build = await buildImplementations(client, rpg, {
        maxAttemptsPerLeaf: 1,
        hostRepo: process.cwd(),
        preserveHarness: true, // keep workDir for the integration phase
      });
      expect(build.ok, JSON.stringify(build.leafResults)).toBe(true);
      const buildWorkDir = build.workDir!;

      // Reconstruct body/test maps from the build's effects on the RPG
      // — they're captured via the implementor's leaf loop. Easiest:
      // walk leafResults.
      const bodyByLeafId = new Map<string, string>();
      const testsByLeafId = new Map<string, string>();
      for (const lr of build.leafResults) {
        if (lr.ok) {
          bodyByLeafId.set(lr.leafId, lr.body);
          testsByLeafId.set(lr.leafId, lr.testSource);
        }
      }

      const integration = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir: buildWorkDir,
      });
      expect(integration.ok, integration.error).toBe(true);
      expect(integration.testsByBranchId.size).toBe(1);

      // Cleanup the preserved work dir.
      await rm(buildWorkDir, { recursive: true, force: true });
    },
  );
});
