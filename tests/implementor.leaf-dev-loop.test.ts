/**
 * Step 6: integration test that implementLeaf can run via the
 * new dev loop. The model picks read/edit tools through the
 * loop; the leaf's outer retry budget is bypassed because the
 * dev loop converges in a single chat session.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { implementLeaf } from "../src/implementor/leaf.js";
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
describe("add", () => {
  it("sums", () => { expect(add(2, 3)).toBe(5); });
});
`;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "leaf-dev-loop-"));
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("implementLeaf — useDevLoop", () => {
  it(
    "uses runLeafDevLoop when useDevLoop is true and converges on the active leaf",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);

      // Mock that drives:
      //   - test author returns a vitest test
      //   - dev loop calls edit_file → Terminate
      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          // Test author: no tools and "vitest test file" prompt.
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            return { content: ADD_TEST, finishReason: "stop" };
          }
          // Dev loop: tool calls. Drive a 2-step script:
          // edit_file → Terminate.
          if (opts?.tools && opts?.tools) {
            // Look at how many tool messages have already come
            // back to determine which step we're on. tool messages
            // = number of completed tool calls so far.
            const toolMsgCount = messages.filter((m) => m.role === "tool").length;
            if (toolMsgCount === 0) {
              return {
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "c1",
                    type: "function",
                    function: {
                      name: "edit_file",
                      arguments: JSON.stringify({
                        path: "src/add.ts",
                        old_str: 'throw new Error("add: not implemented");',
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
                  id: "c2",
                  type: "function",
                  function: {
                    name: "Terminate",
                    arguments: JSON.stringify({ reason: "done" }),
                  },
                },
              ],
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await implementLeaf(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 2,
        useDevLoop: true,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.body).toContain("return a + b");
    },
  );
});
