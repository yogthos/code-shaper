/**
 * Vitest harness acceptance.
 *
 * Spins up a real vitest run on a synthetic 2-file RPG with a single
 * leaf and a generated test, validates pass/fail attribution.
 *
 * Slow (~3-6s per case because vitest spawns a real worker) so we keep
 * the tests count tight: success path + failure path.
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
  leafToTestFilename,
  linkHostNodeModules,
  runTests,
} from "../src/implementor/test-harness.js";

let workDir: string;

beforeAll(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
}, 30_000);

afterAll(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
  }
});

function buildSampleRpg(): RPG {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  const folderId = "folder:src";
  rpg.nodes[folderId] = {
    id: folderId,
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src",
  };
  root.children.push(folderId);
  const file: FileNode = {
    id: "file:src/util.ts",
    kind: "file",
    name: "util.ts",
    parent: folderId,
    children: [],
    features: [],
    path: "src/util.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:add",
          kind: "function",
          ownerClassName: null,
          name: "addNumbers",
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
  (rpg.nodes[folderId] as FolderNode).children.push(file.id);
  return rpg;
}

describe("vitest harness", () => {
  it(
    "reports per-leaf pass when the generated body satisfies the test",
    { timeout: 60_000 },
    async () => {
      const rpg = buildSampleRpg();
      const result = await runTests(rpg, {
        bodyByLeafId: new Map([["cap:add", "return a + b;"]]),
        testsByLeafId: new Map([
          [
            "cap:add",
            `import { describe, it, expect } from "vitest";
import { addNumbers } from "../../src/util.js";

describe("addNumbers", () => {
  it("adds positives", () => {
    expect(addNumbers(1, 2)).toBe(3);
  });
});
`,
          ],
        ]),
        workDir,
      });
      expect(result.ok, result.fatal ?? "").toBe(true);
      const slug = leafToTestFilename("cap:add").replace(".test.ts", "");
      const outcome = result.byLeaf.get(slug);
      expect(outcome).toBeDefined();
      expect(outcome!.ok).toBe(true);
      expect(outcome!.testCount).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "reports per-leaf failure with the assertion message attached",
    { timeout: 60_000 },
    async () => {
      const rpg = buildSampleRpg();
      const result = await runTests(rpg, {
        // Wrong body: returns the difference instead of the sum.
        bodyByLeafId: new Map([["cap:add", "return a - b;"]]),
        testsByLeafId: new Map([
          [
            "cap:add",
            `import { describe, it, expect } from "vitest";
import { addNumbers } from "../../src/util.js";

describe("addNumbers", () => {
  it("adds positives", () => {
    expect(addNumbers(1, 2)).toBe(3);
  });
});
`,
          ],
        ]),
        workDir,
      });
      expect(result.ok).toBe(false);
      const slug = leafToTestFilename("cap:add").replace(".test.ts", "");
      const outcome = result.byLeaf.get(slug);
      expect(outcome).toBeDefined();
      expect(outcome!.ok).toBe(false);
      expect(outcome!.failureMessage).toMatch(/3|expected/i);
    },
  );
});
