/**
 * Step Q3 — parallel worker pool with file-level locks.
 *
 * Two assertions:
 *   1. With maxConcurrentLeaves > 1, leaves on DIFFERENT files
 *      run in parallel — concurrency observed at the LLM call
 *      site. We use a deliberately-slow mock to make the
 *      overlap measurable.
 *   2. Two leaves on the SAME file are serialized by the
 *      file-level lock, even with workers > 1.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildImplementations } from "../src/implementor/orchestrator.js";
import { emptyRPG } from "../src/rpg/index.js";
import type {
  CapabilityNode,
  FileNode,
  FolderNode,
  PlannedInterface,
  RPG,
} from "../src/rpg/types.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function plannedFn(name: string, capId: string): PlannedInterface {
  return {
    leafCapabilityId: capId,
    kind: "function",
    name,
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
  };
}

function mkFileNode(opts: {
  id: string;
  path: string;
  entries: PlannedInterface[];
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
    parent: "folder:src",
    children: [],
    features: [],
    interfacePlan: { entries: opts.entries, classes: [] },
  };
}

function rpgWithLeaves(
  files: FileNode[],
  leafCapIds: string[],
): RPG {
  const rpg = emptyRPG();
  const folder: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    path: "src",
    parent: null,
    children: [...files.map((f) => f.id), ...leafCapIds],
    features: [],
  };
  rpg.nodes[folder.id] = folder;
  for (const f of files) rpg.nodes[f.id] = f;
  for (const capId of leafCapIds) {
    // Find which file has the leaf with this capId.
    const owner = files.find((f) =>
      (f.interfacePlan?.entries ?? []).some((e) => e.leafCapabilityId === capId),
    );
    const cap: CapabilityNode = {
      id: capId,
      kind: "capability",
      name: capId.replace("cap:", ""),
      description: "",
      parent: "folder:src",
      children: [],
      features: [],
      isLeaf: true,
      status: "planned",
      mappedToId: owner?.id ?? null,
      decompositionDepth: 0,
    };
    rpg.nodes[capId] = cap;
  }
  return rpg;
}

const ADD_TEST = (capName: string) => `import { describe, it, expect } from "vitest";
import { ${capName} } from "../../src/${capName}.js";
describe("${capName}", () => {
  it("sums", () => { expect(${capName}(2, 3)).toBe(5); });
});
`;

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "parallel-"));
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("buildImplementations — maxConcurrentLeaves", () => {
  it(
    "runs leaves on different files concurrently (Q3)",
    { timeout: 60_000 },
    async () => {
      // Three files, one leaf each — fully independent. With
      // workers >= 3 they should run in parallel.
      const f1 = mkFileNode({
        id: "file:a",
        path: "src/a.ts",
        entries: [plannedFn("a", "cap:a")],
      });
      const f2 = mkFileNode({
        id: "file:b",
        path: "src/b.ts",
        entries: [plannedFn("b", "cap:b")],
      });
      const f3 = mkFileNode({
        id: "file:c",
        path: "src/c.ts",
        entries: [plannedFn("c", "cap:c")],
      });
      const rpg = rpgWithLeaves([f1, f2, f3], ["cap:a", "cap:b", "cap:c"]);

      // Track concurrency: how many test-author / dev-loop chat
      // calls are simultaneously in flight at peak. SLOW_MS is
      // generous enough that even under heavy CI load (where
      // setTimeout fires get serialized by event-loop pressure)
      // the overlap window is observable.
      let inflight = 0;
      let peakInflight = 0;
      const SLOW_MS = 500;

      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          inflight++;
          peakInflight = Math.max(peakInflight, inflight);
          await new Promise((r) => setTimeout(r, SLOW_MS));
          inflight--;
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            // Determine which leaf based on the user prompt.
            const userPrompt = messages[1]!.content;
            const m = /(\w+)\s*\(/.exec(userPrompt);
            const name = m?.[1] ?? "fn";
            return { content: ADD_TEST(name), finishReason: "stop" };
          }
          if (opts?.tools && opts?.tools) {
            // Dev loop: figure out the active leaf from the user
            // prompt header "Implement function `<name>`".
            const userPrompt = messages[1]!.content;
            const nameMatch = /Implement function `(\w+)`/.exec(userPrompt);
            const name = nameMatch?.[1] ?? "fn";
            const toolMsgCount = messages.filter((m) => m.role === "tool").length;
            if (toolMsgCount === 0) {
              return {
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: `c1-${name}`,
                    type: "function",
                    function: {
                      name: "edit_file",
                      arguments: JSON.stringify({
                        path: `src/${name}.ts`,
                        old_str: `throw new Error("${name}: not implemented");`,
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
                  id: `c2-${name}`,
                  type: "function",
                  function: {
                    name: "Terminate",
                    arguments: JSON.stringify({}),
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

      const result = await buildImplementations(client, rpg, {
        useDevLoop: true,
        devLoopMaxIterations: 3,
        maxAttemptsPerLeaf: 1,
        maxConcurrentLeaves: 3,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      // With true parallelism, peak inflight should be > 1.
      // (Sequential mode would only ever have 1.)
      expect(peakInflight).toBeGreaterThan(1);
    },
  );

  it(
    "serializes leaves on the SAME file via the file-level lock",
    { timeout: 60_000 },
    async () => {
      // Two leaves in the same file. Even with workers=2, they
      // must run sequentially because of the lock.
      const f = mkFileNode({
        id: "file:both",
        path: "src/both.ts",
        entries: [plannedFn("a", "cap:a"), plannedFn("b", "cap:b")],
      });
      const rpg = rpgWithLeaves([f], ["cap:a", "cap:b"]);

      let inflight = 0;
      let peakInflight = 0;
      const SLOW_MS = 200;

      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          inflight++;
          peakInflight = Math.max(peakInflight, inflight);
          await new Promise((r) => setTimeout(r, SLOW_MS));
          inflight--;
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            const userPrompt = messages[1]!.content;
            const m = /(\w+)\s*\(/.exec(userPrompt);
            const name = m?.[1] ?? "fn";
            return {
              content: `import { describe, it, expect } from "vitest";\nimport { ${name} } from "../../src/both.js";\ndescribe("${name}", () => { it("sums", () => { expect(${name}(2,3)).toBe(5); }); });\n`,
              finishReason: "stop",
            };
          }
          if (opts?.tools && opts?.tools) {
            const userPrompt = messages[1]!.content;
            const nameMatch = /Implement function `(\w+)`/.exec(userPrompt);
            const name = nameMatch?.[1] ?? "fn";
            const toolMsgCount = messages.filter((m) => m.role === "tool").length;
            if (toolMsgCount === 0) {
              return {
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: `c1-${name}`,
                    type: "function",
                    function: {
                      name: "edit_file",
                      arguments: JSON.stringify({
                        path: "src/both.ts",
                        old_str: `throw new Error("${name}: not implemented");`,
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
                  id: `c2-${name}`,
                  type: "function",
                  function: {
                    name: "Terminate",
                    arguments: JSON.stringify({}),
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

      const result = await buildImplementations(client, rpg, {
        useDevLoop: true,
        devLoopMaxIterations: 3,
        maxAttemptsPerLeaf: 1,
        maxConcurrentLeaves: 2,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      // Even with workers=2, file-level lock keeps inflight <= 1
      // ON THE SAME FILE. Both leaves share file:both, so they
      // must serialize. Peak inflight stays at 1 (or there could
      // be a transient 2 if the test author for one runs while
      // dev loop for another runs — but those still go through
      // the SAME implementLeaf path on the same file, gated by
      // the file lock).
      expect(peakInflight).toBeLessThanOrEqual(1);
    },
  );
});
