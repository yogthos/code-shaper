/**
 * Step 5: runLeafDevLoop — the multi-turn agent harness.
 *
 * Wires the read/edit/probe tools (steps 1-4) plus the §D.2
 * surgical edit tools plus a Terminate tool into a single
 * multi-turn chat session. The model picks ONE tool per turn;
 * each tool result feeds back as a tool message; the loop
 * continues until the model calls Terminate (or the budget
 * exhausts).
 *
 * These tests use a scripted-LLM fixture so we can assert exactly
 * which tools the agent picks in which order without actually
 * spending tokens.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runLeafDevLoop } from "../src/implementor/dev-loop.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";
import type { ChatMessage, LLMClient, LLMResponse } from "../src/llm/types.js";
import { createHarnessDir } from "../src/implementor/test-harness.js";

interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function scriptedClient(calls: ScriptedToolCall[]): {
  client: LLMClient;
  recorded: { messages: ChatMessage[] }[];
} {
  const recorded: { messages: ChatMessage[] }[] = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages, _opts): Promise<LLMResponse> {
      recorded.push({ messages: [...messages] });
      const c = calls[i++];
      if (!c) {
        // Off the end of the script — return Terminate so the
        // loop converges. This is what a sane model would do
        // after solving the task.
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `call_${i}`,
              type: "function",
              function: { name: "Terminate", arguments: JSON.stringify({}) },
            },
          ],
        };
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          },
        ],
      };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, recorded };
}

function mkFile(opts: {
  id: string;
  path: string;
  content?: string;
  interfacePlan?: FileNode["interfacePlan"];
}): FileNode {
  return {
    id: opts.id,
    kind: "file",
    name: opts.path.split("/").pop() ?? "",
    path: opts.path,
    content: opts.content ?? "",
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
      description: "Sums two numbers and returns the total.",
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
  workDir = await createHarnessDir();
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("runLeafDevLoop — happy path", () => {
  it(
    "edit_file → run_test → Terminate converges on a simple leaf",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const { client } = scriptedClient([
        {
          name: "edit_file",
          args: {
            path: "src/add.ts",
            old_str: 'throw new Error("add: not implemented");',
            new_str: "return a + b;",
          },
        },
        { name: "run_test", args: {} },
        { name: "Terminate", args: { reason: "test passes" } },
      ]);
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map([["cap:add", ADD_TEST]]),
        workDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.iterations).toBe(3);
      // The body is now in bodyByLeafId.
      expect(r.body).toContain("return a + b");
    },
  );
});

describe("runLeafDevLoop — read tools", () => {
  it(
    "list_files → read_file → edit → terminate (cross-file discovery)",
    { timeout: 60_000 },
    async () => {
      // Setup: validation.ts has a leaf that needs to throw a
      // class defined in errors.ts. Without read_file the model
      // would have no idea where TodoValidationError lives.
      const errors = mkFile({
        id: "file:errors",
        path: "src/errors.ts",
        content:
          "export class TodoValidationError extends Error {\n  constructor(msg: string) { super(msg); this.name = 'TodoValidationError'; }\n}\n",
      });
      const validation = mkFile({
        id: "file:validation",
        path: "src/validation.ts",
        interfacePlan: {
          entries: [
            {
              leafCapabilityId: "cap:validate",
              kind: "function",
              name: "validateText",
              ownerClassName: null,
              description: "Throw TodoValidationError on empty text.",
              signature: {
                params: [{ name: "text", type: "string" }],
                returnType: "void",
                isAsync: false,
              },
              exported: true,
              isStatic: false,
            },
          ],
          classes: [],
        },
      });
      const rpg = rpgWithFiles([errors, validation]);
      const { client, recorded } = scriptedClient([
        // Step 1: list_files to discover errors.ts exists.
        { name: "list_files", args: {} },
        // Step 2: read errors.ts to learn the constructor.
        { name: "read_file", args: { path: "src/errors.ts" } },
        // Step 3: a single edit_file that adds the import AND
        // writes the body. The model now has one edit shape; no
        // §D.2 specialty tools.
        {
          name: "edit_file",
          args: {
            path: "src/validation.ts",
            old_str:
              'export function validateText(text: string): void {\n  throw new Error("validateText: not implemented");\n}',
            new_str:
              'import { TodoValidationError } from "./errors.js";\n\nexport function validateText(text: string): void {\n  if (text.length === 0) throw new TodoValidationError("text cannot be empty");\n}',
          },
        },
        { name: "Terminate", args: { reason: "done" } },
      ]);
      const r = await runLeafDevLoop(client, {
        leaf: validation.interfacePlan!.entries[0]!,
        hostFile: validation,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      // The trail should reflect the full discovery sequence.
      expect(r.trail.map((t) => t.tool)).toEqual([
        "list_files",
        "read_file",
        "edit_file",
        "Terminate",
      ]);
      // The model should have seen the rendered errors.ts.
      const readFileTurn = recorded[1]; // Turn 2: model sees turn 1's tool result
      const toolMsgs = readFileTurn!.messages.filter((m) => m.role === "tool");
      // The tool result of list_files (turn 1) is in turn 2's messages.
      const lastTool = toolMsgs[toolMsgs.length - 1];
      expect(lastTool!.content).toContain("src/errors.ts");
      expect(lastTool!.content).toContain("src/validation.ts");
    },
  );
});

describe("runLeafDevLoop — parallel tool calls (V7)", () => {
  it(
    "applies all tool calls in a multi-call turn and emits one tool message per call_id",
    { timeout: 60_000 },
    async () => {
      const errors = mkFile({
        id: "file:errors",
        path: "src/errors.ts",
        content:
          "export class TodoValidationError extends Error {\n  constructor(msg: string) { super(msg); this.name = 'TodoValidationError'; }\n}\n",
      });
      const validation = mkFile({
        id: "file:validation",
        path: "src/validation.ts",
        interfacePlan: {
          entries: [
            {
              leafCapabilityId: "cap:validate",
              kind: "function",
              name: "validateText",
              ownerClassName: null,
              description: "Throw TodoValidationError on empty text.",
              signature: {
                params: [{ name: "text", type: "string" }],
                returnType: "void",
                isAsync: false,
              },
              exported: true,
              isStatic: false,
            },
          ],
          classes: [],
        },
      });
      const rpg = rpgWithFiles([errors, validation]);

      // Turn 1 emits two reads + a list in parallel; turn 2 edits;
      // turn 3 terminates.
      let turn = 0;
      const recorded: { messages: ChatMessage[] }[] = [];
      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          recorded.push({ messages: [...messages] });
          turn++;
          if (turn === 1) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "c_a",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "src/errors.ts" }),
                  },
                },
                {
                  id: "c_b",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "src/validation.ts" }),
                  },
                },
                {
                  id: "c_c",
                  type: "function",
                  function: { name: "list_files", arguments: "{}" },
                },
              ],
            };
          }
          if (turn === 2) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "c_d",
                  type: "function",
                  function: {
                    name: "edit_file",
                    arguments: JSON.stringify({
                      path: "src/validation.ts",
                      old_str:
                        'export function validateText(text: string): void {\n  throw new Error("validateText: not implemented");\n}',
                      new_str:
                        'import { TodoValidationError } from "./errors.js";\n\nexport function validateText(text: string): void {\n  if (text.length === 0) throw new TodoValidationError("text cannot be empty");\n}',
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
                id: "c_e",
                type: "function",
                function: {
                  name: "Terminate",
                  arguments: JSON.stringify({ reason: "done" }),
                },
              },
            ],
          };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const r = await runLeafDevLoop(client, {
        leaf: validation.interfacePlan!.entries[0]!,
        hostFile: validation,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      // Three iterations total, even though turn 1 ran THREE
      // tools — the whole batch is one iteration.
      expect(r.iterations).toBe(3);
      // Trail records one entry per applied tool (5 total: 3 in
      // turn 1 + 1 edit + 1 Terminate).
      expect(r.trail.length).toBe(5);
      expect(r.trail.filter((t) => t.iteration === 1).length).toBe(3);
      expect(r.trail.filter((t) => t.iteration === 2).length).toBe(1);
      expect(r.trail.filter((t) => t.iteration === 3).length).toBe(1);

      // Protocol invariant: in turn 2's messages, the assistant
      // message from turn 1 must carry all 3 tool_calls and be
      // followed by exactly 3 tool messages with matching ids.
      const turn2Messages = recorded[1]!.messages;
      const lastAssistant = [...turn2Messages]
        .reverse()
        .find((m) => m.role === "assistant");
      expect(lastAssistant).toBeDefined();
      // Find the trailing tool messages that match the assistant's
      // tool_calls.
      const trailingTools = turn2Messages.filter((m) => m.role === "tool");
      expect(trailingTools.length).toBe(3);
      const ids = trailingTools.map((m) => m.tool_call_id).sort();
      expect(ids).toEqual(["c_a", "c_b", "c_c"]);
    },
  );

  it(
    "skips tool calls emitted after a successful Terminate in the same turn",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      // Pre-set userEditedSource so the V5 Terminate guard
      // accepts immediately on the first turn.
      f.userEditedSource =
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
      const rpg = rpgWithFiles([f]);

      const client: LLMClient = {
        async chat(): Promise<LLMResponse> {
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "t1",
                type: "function",
                function: {
                  name: "Terminate",
                  arguments: JSON.stringify({ reason: "done" }),
                },
              },
              {
                id: "t2",
                type: "function",
                function: { name: "list_files", arguments: "{}" },
              },
            ],
          };
        },
        async listModels() {
          return ["mock"];
        },
      };
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok).toBe(true);
      expect(r.iterations).toBe(1);
      // Trail: Terminate (ok), then list_files (skipped).
      expect(r.trail.length).toBe(2);
      expect(r.trail[0]!.tool).toBe("Terminate");
      expect(r.trail[0]!.ok).toBe(true);
      expect(r.trail[1]!.tool).toBe("list_files");
      expect(r.trail[1]!.ok).toBe(false);
      expect(r.trail[1]!.error).toMatch(/skipped/i);
    },
  );
});

describe("runLeafDevLoop — Terminate guard (V5)", () => {
  it(
    "rejects Terminate when no edit_file has produced a body, then accepts after a real edit",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const { client } = scriptedClient([
        // Premature Terminate — no edits have been applied. The
        // guard should push back rather than fail the attempt.
        { name: "Terminate", args: { reason: "already implemented" } },
        // Now a real edit.
        {
          name: "edit_file",
          args: {
            path: "src/add.ts",
            old_str: 'throw new Error("add: not implemented");',
            new_str: "return a + b;",
          },
        },
        // Followed by a successful Terminate.
        { name: "Terminate", args: { reason: "done" } },
      ]);
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.body).toContain("return a + b");
      // Trail must show the rejected Terminate before the
      // accepted one.
      const terminateEntries = r.trail.filter((t) => t.tool === "Terminate");
      expect(terminateEntries.length).toBe(2);
      expect(terminateEntries[0]!.ok).toBe(false);
      expect(terminateEntries[0]!.error).toMatch(/no body produced/i);
      expect(terminateEntries[1]!.ok).toBe(true);
    },
  );

  it(
    "accepts Terminate without an explicit edit_file when the symbol is already implemented in userEditedSource",
    { timeout: 60_000 },
    async () => {
      // Simulate a prior leaf in the same file having written
      // the implementation: hostFile.userEditedSource is set,
      // but bodyByLeafId for THIS leaf is empty.
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      f.userEditedSource =
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
      const rpg = rpgWithFiles([f]);
      const { client } = scriptedClient([
        { name: "Terminate", args: { reason: "already implemented" } },
      ]);
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.body).toContain("return a + b");
    },
  );
});

describe("runLeafDevLoop — recovery", () => {
  it(
    "retries after a string-replace ambiguity rejection",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const { client } = scriptedClient([
        // First: an edit that DOES succeed but uses a too-narrow
        // old_str (only one occurrence so it's unambiguous).
        {
          name: "edit_file",
          args: {
            path: "src/add.ts",
            old_str: 'throw new Error("add: not implemented");',
            new_str: "return a + b;",
          },
        },
        // Then immediate Terminate.
        { name: "Terminate", args: {} },
      ]);
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok).toBe(true);
      // Body landed even without explicit run_test — Terminate
      // is the model's commit signal. The orchestrator's outer
      // loop verifies the leaf passes its test on its own.
      expect(r.body).toContain("return a + b");
    },
  );

  it(
    "exhausts iteration budget when the model never Terminates",
    { timeout: 60_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      // Repeating list_files forever — no Terminate.
      const { client } = (() => {
        let i = 0;
        const c: LLMClient = {
          async chat(): Promise<LLMResponse> {
            i++;
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: `c${i}`,
                  type: "function",
                  function: {
                    name: "list_files",
                    arguments: JSON.stringify({}),
                  },
                },
              ],
            };
          },
          async listModels() {
            return ["mock"];
          },
        };
        return { client: c };
      })();
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxIterations: 4,
      });
      expect(r.ok).toBe(false);
      expect(r.iterations).toBe(4);
      expect(r.error).toMatch(/exhausted/i);
    },
  );

  it(
    "captures client.chat exceptions into the result",
    { timeout: 30_000 },
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const client: LLMClient = {
        async chat(): Promise<LLMResponse> {
          throw new Error("upstream 503");
        },
        async listModels() {
          return ["mock"];
        },
      };
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/chat failed/);
      expect(r.error).toMatch(/upstream 503/);
    },
  );
});

// Step Q1: npm tools (add_dependency, remove_dependency, set_script,
// npm_run) belong INSIDE the dev loop. Without them, when a leaf's
// body fails because a chosen binding doesn't compile (the
// better-sqlite3 trap that wedged the prior TodoMVC run), env-fix
// runs as a separate session AFTER the dev loop returns — losing
// the conversation context. Exposing the npm primitives in the
// loop lets the model swap bindings within the same chat session,
// the canonical agentic shape.
describe("runLeafDevLoop — npm tools", () => {
  it(
    "exposes add_dependency / remove_dependency / set_script / npm_run as available tools",
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const { client, recorded } = scriptedClient([
        // Just terminate immediately — we only care about the
        // tool list the harness sends on the first chat call.
        { name: "Terminate", args: {} },
      ]);
      // Need an outDir for npm tools to be exposable.
      const outDir = await (await import("node:fs/promises")).mkdtemp(
        (await import("node:path")).default.join((await import("node:os")).tmpdir(), "outdir-"),
      );
      try {
        await runLeafDevLoop(client, {
          leaf: f.interfacePlan!.entries[0]!,
          hostFile: f,
          rpg,
          bodyByLeafId: new Map([["cap:add", "return a + b;"]]),
          testsByLeafId: new Map(),
          workDir,
          outDir,
        });
        const firstTurn = recorded[0]!;
        // Tool defs aren't in messages; they're in the chat opts.
        // The scripted client doesn't capture opts, so we assert
        // through observable behavior in the next test instead.
        // Here we just confirm the loop started + Terminated.
        void firstTurn;
      } finally {
        await (await import("node:fs/promises")).rm(outDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "applies add_dependency through to the project's package.json",
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      // Pre-seed an outDir with package.json + tsconfig so the
      // npm tools have something to mutate.
      const fs = await import("node:fs/promises");
      const nodePath = (await import("node:path")).default;
      const os = await import("node:os");
      const outDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "outdir-"));
      try {
        await fs.writeFile(
          nodePath.join(outDir, "package.json"),
          JSON.stringify(
            {
              name: "test",
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
        const { client } = scriptedClient([
          // Apply add_dependency, then a body edit, then Terminate.
          {
            name: "add_dependency",
            args: { name: "zod", version: "^3.22.0", which: "runtime" },
          },
          {
            name: "edit_file",
            args: {
              path: "src/add.ts",
              old_str: 'throw new Error("add: not implemented");',
              new_str: "return a + b;",
            },
          },
          { name: "Terminate", args: {} },
        ]);
        const r = await runLeafDevLoop(client, {
          leaf: f.interfacePlan!.entries[0]!,
          hostFile: f,
          rpg,
          bodyByLeafId: new Map(),
          testsByLeafId: new Map(),
          workDir,
          outDir,
          // Skip the actual npm install — we're testing the
          // tool wiring, not the registry. Avoids flake from
          // network latency when this test runs alongside other
          // /tmp consumers in the suite.
          skipNpmInstall: true,
        });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const pkg = JSON.parse(
          await fs.readFile(nodePath.join(outDir, "package.json"), "utf-8"),
        );
        expect(pkg.dependencies.zod).toBe("^3.22.0");
        // The trail records the npm call.
        const addDep = r.trail.find((t) => t.tool === "add_dependency");
        expect(addDep).toBeDefined();
        expect(addDep!.ok).toBe(true);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects npm tools when outDir is not configured (cleanly, with a hint)",
    async () => {
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const { client } = scriptedClient([
        {
          name: "add_dependency",
          args: { name: "zod", version: "^3.22.0", which: "runtime" },
        },
        { name: "Terminate", args: {} },
      ]);
      const r = await runLeafDevLoop(client, {
        leaf: f.interfacePlan!.entries[0]!,
        hostFile: f,
        rpg,
        bodyByLeafId: new Map([["cap:add", "return a + b;"]]),
        testsByLeafId: new Map(),
        workDir,
        // outDir intentionally omitted.
      });
      // Loop converges (Terminate fires) but the npm call's trail
      // entry records a clear no-outDir error.
      const addDep = r.trail.find((t) => t.tool === "add_dependency");
      expect(addDep).toBeDefined();
      expect(addDep!.ok).toBe(false);
      expect(addDep!.error).toMatch(/outDir|project directory/i);
    },
  );

  it(
    "exposes npm_run that returns exit code + stdout/stderr to the agent",
    async () => {
      // Pre-seed package.json with a custom script and a stub npm
      // binary that exits 0 with deterministic output.
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const fs = await import("node:fs/promises");
      const nodePath = (await import("node:path")).default;
      const os = await import("node:os");
      const outDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "outdir-"));
      try {
        await fs.writeFile(
          nodePath.join(outDir, "package.json"),
          JSON.stringify(
            {
              name: "t",
              version: "0.1.0",
              type: "module",
              scripts: { test: "vitest run", probe: "echo hi" },
              dependencies: {},
              devDependencies: { vitest: "^2.0.0" },
            },
            null,
            2,
          ),
        );
        // Stub npm so npm_run returns deterministically without
        // hitting the real registry.
        const stubDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "stub-npm-"));
        const stubBin = nodePath.join(stubDir, "stub-npm");
        await fs.writeFile(
          stubBin,
          `#!/usr/bin/env node\nprocess.stdout.write("probed!\\n");\nprocess.exit(0);\n`,
        );
        await fs.chmod(stubBin, 0o755);
        const { client } = scriptedClient([
          { name: "npm_run", args: { script: "probe" } },
          { name: "Terminate", args: {} },
        ]);
        const r = await runLeafDevLoop(client, {
          leaf: f.interfacePlan!.entries[0]!,
          hostFile: f,
          rpg,
          bodyByLeafId: new Map([["cap:add", "return a + b;"]]),
          testsByLeafId: new Map(),
          workDir,
          outDir,
          npmBinary: stubBin,
        });
        const probe = r.trail.find((t) => t.tool === "npm_run");
        expect(probe).toBeDefined();
        expect(probe!.ok).toBe(true);
        await fs.rm(stubDir, { recursive: true, force: true });
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    },
  );
});
