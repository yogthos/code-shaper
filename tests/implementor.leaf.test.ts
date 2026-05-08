/**
 * Per-leaf TDD loop acceptance with a mocked LLM.
 *
 *   - Happy path: test author + body author both produce content
 *     that passes vitest in one attempt.
 *   - Retry path: first body fails the test; retry body passes.
 *   - Exhaustion: all attempts fail; result.ok=false, lastFailure
 *     populated.
 *   - Topological order: orchestrator builds files with cross-file
 *     dependencies in dependency order.
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
  leafToTestFilename,
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

function mockClient(responses: string[]): {
  client: LLMClient;
  calls: Array<{ messages: any[] }>;
} {
  const calls: Array<{ messages: any[] }> = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages): Promise<LLMResponse> {
      calls.push({ messages });
      const content = responses[i++] ?? "";
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, calls };
}

function buildAddFnRpg(): {
  rpg: RPG;
  hostFile: FileNode;
  leafId: string;
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

const TEST_FOR_ADD = `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";

describe("add", () => {
  it("sums two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
`;

describe("implementLeaf — happy path", () => {
  it(
    "passes on the first body attempt when the body is correct",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile, leafId } = buildAddFnRpg();
      const { client, calls } = mockClient([TEST_FOR_ADD, "return a + b;"]);
      const bodyByLeafId = new Map<string, string>();
      const testsByLeafId = new Map<string, string>();
      const r = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId,
        testsByLeafId,
        workDir,
      });
      expect(r.ok, r.fatal ?? r.lastFailure?.failureMessage ?? "").toBe(true);
      expect(r.attempts).toBe(1);
      expect(bodyByLeafId.get(leafId)).toBe("return a + b;");
      // The test author's response is normalized via stripCodeFences;
      // trailing whitespace is trimmed.
      expect(testsByLeafId.get(leafId)).toBe(TEST_FOR_ADD.trim());
      // Test author (1 call) + body author (1 call) = 2.
      expect(calls).toHaveLength(2);
    },
  );
});

describe("implementLeaf — retry path", () => {
  it(
    "retries with prior failure attached, succeeds on the second body",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile, leafId } = buildAddFnRpg();
      const { client, calls } = mockClient([
        TEST_FOR_ADD,
        // First body: wrong (returns 0).
        "return 0;",
        // Second body: correct.
        "return a + b;",
      ]);
      const bodyByLeafId = new Map<string, string>();
      const testsByLeafId = new Map<string, string>();
      const r = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId,
        testsByLeafId,
        workDir,
        maxAttempts: 3,
      });
      expect(r.ok, r.fatal ?? "").toBe(true);
      expect(r.attempts).toBe(2);
      expect(bodyByLeafId.get(leafId)).toBe("return a + b;");
      // 1 test author + 2 body author calls = 3.
      expect(calls).toHaveLength(3);

      // The retry body-author prompt includes the failing assertion
      // and the previous body.
      const retryPrompt = calls[2]!.messages.at(-1)?.content ?? "";
      expect(retryPrompt).toMatch(/Previous attempt failed/);
      expect(retryPrompt).toMatch(/return 0;/);
    },
  );
});

describe("implementLeaf — exhaustion", () => {
  it(
    "returns ok=false with lastFailure when every attempt fails",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddFnRpg();
      const { client } = mockClient([
        TEST_FOR_ADD,
        "return 0;",
        "return 1;",
        "return 99;",
      ]);
      const r = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 3,
      });
      expect(r.ok).toBe(false);
      expect(r.attempts).toBe(3);
      expect(r.lastFailure).toBeDefined();
      expect(r.lastFailure!.failureMessage).toMatch(/expected/i);
    },
  );
});

describe("buildImplementations — topological order", () => {
  it("processes files with cross-file extends after the base", { timeout: 60_000 }, async () => {
    // Two files: src/base.ts declares Base; src/child.ts declares
    // Child extends Base. The orchestrator must process the base
    // file's leaf before the child file's.
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

    const baseFile: FileNode = {
      id: "file:src/base.ts",
      kind: "file",
      name: "base.ts",
      parent: "folder:src",
      children: [],
      features: [],
      path: "src/base.ts",
      content: "",
      language: "typescript",
      rawImports: [],
      exports: [],
      interfacePlan: {
        classes: [
          {
            name: "Base",
            description: "base",
            extendsName: null,
            extendsFromFile: null,
            exported: true,
          },
        ],
        entries: [
          {
            leafCapabilityId: "cap:base.tag",
            kind: "method",
            ownerClassName: "Base",
            name: "tag",
            signature: { params: [], returnType: "string", isAsync: false },
            description: "tag",
            exported: false,
            isStatic: false,
          },
        ],
      },
    };
    const childFile: FileNode = {
      id: "file:src/child.ts",
      kind: "file",
      name: "child.ts",
      parent: "folder:src",
      children: [],
      features: [],
      path: "src/child.ts",
      content: "",
      language: "typescript",
      rawImports: [
        { name: "Base", source: "./base.js", isDefault: false },
      ],
      exports: [],
      interfacePlan: {
        classes: [
          {
            name: "Child",
            description: "child",
            extendsName: "Base",
            extendsFromFile: "src/base.ts",
            exported: true,
          },
        ],
        entries: [
          {
            leafCapabilityId: "cap:child.kind",
            kind: "method",
            ownerClassName: "Child",
            name: "kind",
            signature: { params: [], returnType: "string", isAsync: false },
            description: "kind",
            exported: false,
            isStatic: false,
          },
        ],
      },
    };
    rpg.nodes[baseFile.id] = baseFile;
    rpg.nodes[childFile.id] = childFile;
    (rpg.nodes["folder:src"] as FolderNode).children.push(
      baseFile.id,
      childFile.id,
    );

    // Don't actually run the orchestrator with a real LLM here — just
    // assert the order via the exposed leaf collector. The collector
    // is internal but observable through the build's leafResults
    // sequence; we test it indirectly via the leaf id ordering when
    // we run the orchestrator with a mock that records sequence.
    const seenOrder: string[] = [];
    const client: LLMClient = {
      async chat(messages): Promise<LLMResponse> {
        // Identify which leaf the call is for by sniffing the user
        // message for a leaf name.
        const last = messages[messages.length - 1]!.content;
        if (typeof last === "string") {
          if (last.includes("Base.tag")) seenOrder.push("base");
          else if (last.includes("Child.kind")) seenOrder.push("child");
        }
        return {
          content:
            // Whatever the first call asks for, return a passing test +
            // body. We don't care if real vitest agrees here — this test
            // is about ordering, so we run with stub bodies that throw,
            // accept the failure, and just look at the call sequence.
            messages[0]!.role === "system" &&
            messages[0]!.content.includes("test file")
              ? "/* placeholder */"
              : "throw new Error('stub');",
          finishReason: "stop",
        };
      },
      async listModels() {
        return ["mock"];
      },
    };

    const { buildImplementations } = await import(
      "../src/implementor/orchestrator.js"
    );
    const result = await buildImplementations(client, rpg, {
      maxAttemptsPerLeaf: 1,
      hostRepo: process.cwd(),
    });
    void result;
    // First "base" call must precede the first "child" call.
    const firstBase = seenOrder.indexOf("base");
    const firstChild = seenOrder.indexOf("child");
    expect(firstBase).toBeGreaterThanOrEqual(0);
    expect(firstChild).toBeGreaterThan(firstBase);
    void leafToTestFilename; // silences unused-import warning
  });
});
