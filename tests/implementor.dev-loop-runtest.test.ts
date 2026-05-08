/**
 * Step 4: runTestTool — runs the active leaf's test against the
 * current bodyByLeafId state via the existing test harness.
 * Returns a tool-shaped {ok, output} result so the agent can
 * verify a code change before terminating.
 */

import { describe, it, expect } from "vitest";
import { runTestTool } from "../src/implementor/dev-loop-tools.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";

function mkFile(opts: {
  id: string;
  path: string;
  interfacePlan?: FileNode["interfacePlan"];
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
    parent: null,
    children: [],
    features: [],
    ...(opts.interfacePlan ? { interfacePlan: opts.interfacePlan } : {}),
  };
}

function rpgWithFiles(files: FileNode[]): RPG {
  const rpg = emptyRPG();
  const root: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    path: "src",
    parent: null,
    children: [],
    features: [],
  };
  rpg.nodes[root.id] = root;
  for (const f of files) {
    rpg.nodes[f.id] = f;
    f.parent = root.id;
    root.children.push(f.id);
  }
  return rpg;
}

const ADD_PLAN: FileNode["interfacePlan"] = {
  entries: [
    {
      leafCapabilityId: "cap:add",
      kind: "function",
      name: "add",
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
    },
  ],
  classes: [],
};

const ADD_TEST = `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";
describe("add", () => {
  it("sums", () => { expect(add(2, 3)).toBe(5); });
});
`;

describe("runTestTool", () => {
  it(
    "returns ok=true when the active leaf's body satisfies its test",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const r = await runTestTool({
        rpg,
        bodyByLeafId: new Map([["cap:add", "return a + b;"]]),
        testsByLeafId: new Map([["cap:add", ADD_TEST]]),
        activeLeafId: "cap:add",
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    },
  );

  it(
    "returns ok=false with the assertion message when the test fails",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const r = await runTestTool({
        rpg,
        bodyByLeafId: new Map([["cap:add", "return a - b;"]]),
        testsByLeafId: new Map([["cap:add", ADD_TEST]]),
        activeLeafId: "cap:add",
      });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/expected.*to be 5/i);
    },
  );

  it(
    "returns a clear error when the active leaf has no test source",
    { timeout: 30_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const r = await runTestTool({
        rpg,
        bodyByLeafId: new Map([["cap:add", "return a + b;"]]),
        testsByLeafId: new Map(), // no test for cap:add
        activeLeafId: "cap:add",
      });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/no test|test source/i);
    },
  );
});
