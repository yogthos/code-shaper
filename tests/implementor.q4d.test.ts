/**
 * Step Q4-D: wall-clock cap + adaptive retry on dev-loop
 * exhaustion.
 *
 * Two protections against pathological leaves:
 *   1. maxLeafWallMs caps the per-leaf wall-clock budget so a
 *      stuck dev loop can't hold a worker forever.
 *   2. When the dev loop exhausts its iteration budget without
 *      calling Terminate, the leaf bails after 2 such failures
 *      instead of burning all 8 attempts (= 8 × 15 = 120 LLM
 *      calls per stuck leaf).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildImplementations } from "../src/implementor/orchestrator.js";
import { implementLeaf } from "../src/implementor/leaf.js";
import { emptyRPG } from "../src/rpg/index.js";
import type {
  CapabilityNode,
  FileNode,
  FolderNode,
  RPG,
} from "../src/rpg/types.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function rpgWithOneLeaf(): { rpg: RPG; file: FileNode } {
  const rpg = emptyRPG();
  const folder: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    path: "src",
    parent: null,
    children: ["file:add", "cap:add"],
    features: [],
  };
  const cap: CapabilityNode = {
    id: "cap:add",
    kind: "capability",
    name: "add",
    description: "",
    parent: "folder:src",
    children: [],
    features: [],
    isLeaf: true,
    status: "planned",
    mappedToId: "file:add",
    decompositionDepth: 0,
  };
  const file: FileNode = {
    id: "file:add",
    kind: "file",
    name: "add.ts",
    path: "src/add.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    parent: "folder:src",
    children: [],
    features: [],
    interfacePlan: {
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
    },
  };
  rpg.nodes[folder.id] = folder;
  rpg.nodes[cap.id] = cap;
  rpg.nodes[file.id] = file;
  return { rpg, file };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "q4d-"));
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("Q4-D — wall-clock cap on stuck leaves", () => {
  it(
    "fails the leaf with a wall-cap fatal when implementLeaf exceeds maxLeafWallMs",
    { timeout: 10_000 },
    async () => {
      const { rpg } = rpgWithOneLeaf();
      // Mock that takes much longer per call than the wall cap
      // — simulates a stalled / very slow LLM. Returns prose
      // that won't author a valid test, so the leaf's first
      // step (test author) loops on parse retries until the
      // wall cap fires.
      const client: LLMClient = {
        async chat(): Promise<LLMResponse> {
          await new Promise((r) => setTimeout(r, 2_000));
          return { content: "(prose, not a test)", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };
      const result = await buildImplementations(client, rpg, {
        useDevLoop: true,
        devLoopMaxIterations: 3,
        maxAttemptsPerLeaf: 2,
        maxLeafWallMs: 500, // cap at 0.5s for the test
      });
      expect(result.ok).toBe(false);
      const r = result.leafResults[0];
      expect(r).toBeDefined();
      expect(r!.ok).toBe(false);
      expect(r!.fatal).toMatch(/wall-clock cap/);
    },
  );
});

describe("Q4-D — adaptive bail on dev-loop exhaustion", () => {
  it(
    "bails the leaf after 2 consecutive dev-loop exhaustions instead of burning all attempts",
    { timeout: 30_000 },
    async () => {
      const { rpg, file } = rpgWithOneLeaf();
      let chatCalls = 0;
      // Mock that never Terminates inside the dev loop. Each
      // dev-loop session calls list_files repeatedly until
      // budget exhausted (3 iterations here).
      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          chatCalls++;
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            return {
              content: `import { describe, it, expect } from "vitest";\nimport { add } from "../../src/add.js";\ndescribe("add", () => { it("ok", () => { expect(add(2,3)).toBe(5); }); });\n`,
              finishReason: "stop",
            };
          }
          if (opts?.tools && opts?.tools) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `c${chatCalls}`,
                  type: "function",
                  function: {
                    name: "list_files",
                    arguments: "{}",
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
        leaf: file.interfacePlan!.entries[0]!,
        hostFile: file,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        useDevLoop: true,
        devLoopMaxIterations: 3,
        // The leaf would normally retry up to 8 times; Q4-D's
        // exhaustion bail should cap it at 2.
        maxAttempts: 8,
      });
      expect(r.ok).toBe(false);
      expect(r.attempts).toBe(2);
      expect(r.fatal).toMatch(/exhaustions|exhausted/);
    },
  );
});
