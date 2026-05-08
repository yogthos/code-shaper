/**
 * Test-author parse-validation acceptance.
 *
 * When the test author returns prose-laced source that can't parse as
 * TypeScript, the leaf loop:
 *   - validates via tree-sitter,
 *   - replays the prior assistant turn + a corrective user message,
 *   - succeeds on the next attempt when the model fixes the syntax.
 *
 * The body-author retry budget is unaffected; only the test-author
 * loop reruns.
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
import { validateTypeScriptSource } from "../src/implementor/validate-ts.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

let workDir: string;

beforeAll(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
}, 30_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("validateTypeScriptSource", () => {
  it("accepts valid TS", () => {
    const r = validateTypeScriptSource(
      'import { describe, it, expect } from "vitest"; describe("x", () => {});',
    );
    expect(r.ok).toBe(true);
  });

  it("rejects prose interleaved with code", () => {
    const r = validateTypeScriptSource(
      'import x from "y"; That sentence has no semicolons or strings.',
    );
    expect(r.ok).toBe(false);
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("rejects unterminated strings", () => {
    const r = validateTypeScriptSource('const a = "unterminated;');
    expect(r.ok).toBe(false);
  });
});

describe("implementLeaf — test-author parse-error retry", () => {
  function buildRpg(): { rpg: RPG; hostFile: FileNode } {
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
      id: "file:src/u.ts",
      kind: "file",
      name: "u.ts",
      parent: "folder:src",
      children: [],
      features: [],
      path: "src/u.ts",
      content: "",
      language: "typescript",
      rawImports: [],
      exports: [],
      interfacePlan: {
        classes: [],
        entries: [
          {
            leafCapabilityId: "cap:u",
            kind: "function",
            ownerClassName: null,
            name: "u",
            signature: { params: [], returnType: "number", isAsync: false },
            description: "Returns 1.",
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

  it(
    "retries the test author when the first response includes prose, then succeeds",
    { timeout: 30_000 },
    async () => {
      const { rpg, hostFile } = buildRpg();
      const calls: Array<{ role: string; content: string }[]> = [];
      let testAuthorAttempts = 0;
      const goodTest = `import { describe, it, expect } from "vitest";
import { u } from "../../src/u.js";
describe("u", () => {
  it("returns 1", () => {
    expect(u()).toBe(1);
  });
});
`;
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
          const sys = messages[0]!.content;
          if (sys.includes("producing a vitest test file")) {
            testAuthorAttempts++;
            if (testAuthorAttempts === 1) {
              // Prose-laced output.
              return {
                content: `import { describe, it, expect } from "vitest";
import { u } from "../../src/u.js";
That should handle the basic case.
describe("u", () => {});
`,
                finishReason: "stop",
              };
            }
            return { content: goodTest, finishReason: "stop" };
          }
          if (sys.includes("producing the body of a single")) {
            return { content: "return 1;", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok, r.fatal ?? r.lastFailure?.failureMessage ?? "").toBe(true);
      expect(testAuthorAttempts).toBe(2);
      // Retry call must include the prior assistant turn + a
      // corrective user message naming the parse error.
      const retryRoles = calls[1]!.map((m) => m.role);
      expect(retryRoles).toEqual(["system", "user", "assistant", "user"]);
      expect(calls[1]![3]!.content).toMatch(/parse|TypeScript|syntax/i);
    },
  );

  it(
    "fails fast when the test author can't produce parseable output across all attempts",
    { timeout: 30_000 },
    async () => {
      const { rpg, hostFile } = buildRpg();
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (sys.includes("producing a vitest test file")) {
            return {
              content: "That is not TypeScript at all 😅",
              finishReason: "stop",
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };
      const r = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxTestAuthorAttempts: 2,
      });
      expect(r.ok).toBe(false);
      expect(r.fatal ?? "").toMatch(/unparseable/i);
    },
  );
});
