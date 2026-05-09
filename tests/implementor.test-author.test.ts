/**
 * Step Q4-A: standalone test authoring.
 *
 * The test-author block was inlined in implementLeaf, which meant
 * tests for a leaf didn't exist until the orchestrator dispatched
 * it. Step Q4-B (dep graph from test imports) needs all tests
 * authored upfront, so we extract authoring into a reusable
 * function + a phase that runs it for every leaf in parallel.
 */

import { describe, it, expect } from "vitest";
import { authorLeafTest, authorAllLeafTests } from "../src/implementor/test-author.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

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
      description: "Sums two numbers.",
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
describe("add", () => { it("sums", () => { expect(add(2, 3)).toBe(5); }); });
`;

describe("authorLeafTest", () => {
  it("authors a vitest test for a leaf and returns it", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        return { content: ADD_TEST, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await authorLeafTest(client, {
      leaf: f.interfacePlan!.entries[0]!,
      hostFile: f,
      rpg,
      bodyByLeafId: new Map(),
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.testSource).toContain("describe(");
    expect(r.testSource).toContain("expect(add(2, 3))");
  });

  it("retries on parse error with the prior bad source as feedback", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    let calls = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        calls++;
        if (calls === 1) {
          // Deliberate prose (won't parse).
          return {
            content: "Here is the test:\n" + ADD_TEST,
            finishReason: "stop",
          };
        }
        return { content: ADD_TEST, finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await authorLeafTest(client, {
      leaf: f.interfacePlan!.entries[0]!,
      hostFile: f,
      rpg,
      bodyByLeafId: new Map(),
    });
    expect(r.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("returns ok=false with a clear error when budget is exhausted", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        // Always unparseable.
        return { content: "this is just prose, no code", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await authorLeafTest(client, {
      leaf: f.interfacePlan!.entries[0]!,
      hostFile: f,
      rpg,
      bodyByLeafId: new Map(),
      maxAttempts: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/parse|across .* attempts/i);
  });
});

describe("authorAllLeafTests", () => {
  it("authors tests for every leaf in the RPG and writes them into testsByLeafId", async () => {
    const f1 = mkFile({
      id: "file:a",
      path: "src/a.ts",
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:a",
            kind: "function",
            name: "a",
            ownerClassName: null,
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [],
      },
    });
    const f2 = mkFile({
      id: "file:b",
      path: "src/b.ts",
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:b",
            kind: "function",
            name: "b",
            ownerClassName: null,
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [],
      },
    });
    const rpg = rpgWithFiles([f1, f2]);
    const client: LLMClient = {
      async chat(messages): Promise<LLMResponse> {
        const userPrompt = messages[1]?.content ?? "";
        const isA = userPrompt.includes("`a`") || userPrompt.includes('`a`');
        const name = isA ? "a" : "b";
        return {
          content: `import { describe, it, expect } from "vitest";\nimport { ${name} } from "../../src/${name}.js";\ndescribe("${name}", () => { it("ok", () => { expect(true).toBe(true); }); });\n`,
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const testsByLeafId = new Map<string, string>();
    const r = await authorAllLeafTests(client, rpg, {
      bodyByLeafId: new Map(),
      testsByLeafId,
      maxConcurrent: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.authored).toBe(2);
    expect(testsByLeafId.has("cap:a")).toBe(true);
    expect(testsByLeafId.has("cap:b")).toBe(true);
  });

  it("does not re-author tests that already exist in testsByLeafId", async () => {
    const f1 = mkFile({
      id: "file:a",
      path: "src/a.ts",
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:a",
            kind: "function",
            name: "a",
            ownerClassName: null,
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [],
      },
    });
    const rpg = rpgWithFiles([f1]);
    let calls = 0;
    const client: LLMClient = {
      async chat(): Promise<LLMResponse> {
        calls++;
        return { content: "test", finishReason: "stop" };
      },
      async listModels() {
        return ["mock"];
      },
    };
    const r = await authorAllLeafTests(client, rpg, {
      bodyByLeafId: new Map(),
      testsByLeafId: new Map([["cap:a", "// pre-authored\n"]]),
    });
    expect(r.ok).toBe(true);
    expect(r.authored).toBe(0);
    expect(calls).toBe(0);
  });
});
