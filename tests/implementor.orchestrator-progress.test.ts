/**
 * Step Q2 — orchestrator progress reporting.
 *
 * When the dev loop fails to produce a body for a leaf, the
 * onLeafProgress callback should surface what the loop tried —
 * not "(no failure detail)". The fix: fall through to
 * result.fatal (where the dev-loop trail tail lands) when
 * lastFailure is undefined.
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
  RPG,
} from "../src/rpg/types.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";
import type { LeafProgressEvent } from "../src/implementor/orchestrator.js";

function rpgWithOneLeaf(): { rpg: RPG } {
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
    description: "Add two numbers.",
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
  return { rpg };
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "orch-progress-"));
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

// Audit fix (HIGH): outDir must propagate as projectDir to
// implementLeaf even when enableEnvFix is off. Otherwise the dev
// loop's typecheck / read_file disk fallback / edit_file infra
// branch / npm tools all silently no-op because input.outDir is
// undefined inside runLeafDevLoop.
describe("buildImplementations — outDir propagation", () => {
  it("forwards outDir as projectDir to implementLeaf even when enableEnvFix is off", async () => {
    const fs = await import("node:fs/promises");
    const path = (await import("node:path")).default;
    const { tmpdir } = await import("node:os");
    const outDir = await fs.mkdtemp(path.join(tmpdir(), "outdir-prop-"));
    try {
      // Pre-seed package.json + tsconfig so the dev loop's
      // outDir-dependent tools have something to work with.
      await fs.writeFile(
        path.join(outDir, "package.json"),
        JSON.stringify(
          {
            name: "p",
            version: "0.1.0",
            type: "module",
            scripts: { test: "vitest run" },
            dependencies: {},
            devDependencies: { vitest: "^2.0.0" },
          },
          null,
          2,
        ),
      );
      const { rpg } = rpgWithOneLeaf();

      // Mock that emits a single typecheck call then Terminate.
      // Without the fix, typecheck would receive outDir undefined
      // and report "skipped (no outDir)".
      let typecheckSummary = "";
      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
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
          if (sys.includes("Implementor agent") && opts?.tools) {
            const toolMsgs = messages.filter((m) => m.role === "tool");
            if (toolMsgs.length === 0) {
              return {
                content: "",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc1",
                    type: "function",
                    function: { name: "typecheck", arguments: "{}" },
                  },
                ],
              };
            }
            // Capture the typecheck result the model received.
            const lastTool = toolMsgs[toolMsgs.length - 1]!;
            typecheckSummary = lastTool.content;
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc2",
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
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };
      const result = await buildImplementations(client, rpg, {
        useDevLoop: true,
        devLoopMaxIterations: 5,
        maxAttemptsPerLeaf: 1,
        outDir,
        // enableEnvFix INTENTIONALLY OFF — pre-fix this would
        // disable typecheck visibility for the dev loop.
        enableEnvFix: false,
      });
      void result;
      // The typecheck tool result must NOT say "outDir not
      // configured" — that would mean projectDir didn't reach
      // the dev loop. With the fix, ran:true (or at minimum
      // ran was attempted with outDir set).
      expect(typecheckSummary).not.toMatch(/outDir not configured/);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe("buildImplementations — onLeafProgress failureSummary", () => {
  it(
    "surfaces the dev-loop trail tail when the loop never produced a body (Q2)",
    { timeout: 60_000 },
    async () => {
      const { rpg } = rpgWithOneLeaf();

      // Mock LLM:
      //  - Test author: returns a vitest test source
      //  - Dev loop: keeps calling list_files, never edits, never
      //    terminates → loop exhausts. NO body produced. Test
      //    never runs.
      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            return {
              content:
                'import { describe, it, expect } from "vitest";\nimport { add } from "../../src/add.js";\ndescribe("add", () => { it("sums", () => { expect(add(2,3)).toBe(5); }); });\n',
              finishReason: "stop",
            };
          }
          if (sys.includes("Implementor agent") && opts?.tools) {
            // Always list_files. Never terminate.
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "list_files", arguments: "{}" },
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

      const events: LeafProgressEvent[] = [];
      const result = await buildImplementations(client, rpg, {
        useDevLoop: true,
        devLoopMaxIterations: 3,
        maxAttemptsPerLeaf: 1,
        onLeafProgress: (e) => events.push(e),
      });

      // Leaf failed.
      expect(result.ok).toBe(false);
      // Progress callback received both a start and a done.
      const done = events.find((e) => e.phase === "done");
      expect(done).toBeDefined();
      expect(done!.ok).toBe(false);
      // The failure summary must NOT be the placeholder; it
      // should surface the dev-loop trail tail / exhausted
      // signal.
      expect(done!.failureSummary).toBeDefined();
      expect(done!.failureSummary).not.toMatch(/^\(no failure detail/);
      expect(done!.failureSummary).toMatch(/dev loop|exhausted|trail/i);
    },
  );
});
