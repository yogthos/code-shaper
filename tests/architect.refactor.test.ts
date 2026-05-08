/**
 * Refactor pass acceptance — deterministic.
 *
 *  - Conservative default: empty operations list passes through.
 *  - Each op kind validates and applies through the shared apply layer.
 *  - Validation rejects: unknown op kind, malformed op shape.
 *  - Retry replays the prior assistant turn on validation failure.
 *  - Apply failure surfaces the underlying apply error in the result.
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isFile,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  parseRefactorResponse,
  runRefactorPass,
} from "../src/architect/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function mockClient(responses: string[]): {
  client: LLMClient;
  calls: Array<{ messages: any[]; options?: any }>;
} {
  const calls: Array<{ messages: any[]; options?: any }> = [];
  let i = 0;
  const client: LLMClient = {
    async chat(messages, options): Promise<LLMResponse> {
      calls.push({ messages, options });
      const content = responses[i++] ?? "";
      return { content, finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
  return { client, calls };
}

function addFile(rpg: RPG, relPath: string): FileNode {
  const id = `file:${relPath}`;
  const parentDir = relPath.includes("/")
    ? relPath.replace(/\/[^/]+$/, "")
    : "";
  const parentId = parentDir ? `folder:${parentDir}` : rpg.rootId;
  ensureFolder(rpg, parentDir);
  const file: FileNode = {
    id,
    kind: "file",
    name: relPath.split("/").pop()!,
    parent: parentId,
    children: [],
    features: [],
    path: relPath,
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
  };
  rpg.nodes[id] = file;
  (rpg.nodes[parentId] as FolderNode).children.push(id);
  return file;
}

function ensureFolder(rpg: RPG, relPath: string): FolderNode {
  if (relPath === "") return rpg.nodes[rpg.rootId] as FolderNode;
  const id = `folder:${relPath}`;
  if (rpg.nodes[id]) return rpg.nodes[id] as FolderNode;
  const parentDir = relPath.includes("/")
    ? relPath.replace(/\/[^/]+$/, "")
    : "";
  const parentId = parentDir ? `folder:${parentDir}` : rpg.rootId;
  ensureFolder(rpg, parentDir);
  const folder: FolderNode = {
    id,
    kind: "folder",
    name: relPath.split("/").pop()!,
    parent: parentId,
    children: [],
    features: [],
    path: relPath,
  };
  rpg.nodes[id] = folder;
  (rpg.nodes[parentId] as FolderNode).children.push(id);
  return folder;
}

describe("runRefactorPass (mocked)", () => {
  it("empty operations is the conservative happy path", async () => {
    const rpg = emptyRPG();
    const { client, calls } = mockClient([JSON.stringify({ operations: [] })]);
    const r = await runRefactorPass(client, rpg, { description: "x" });
    expect(r.ok).toBe(true);
    expect(r.operations).toEqual([]);
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("applies a move_file op through the shared apply layer", async () => {
    const rpg = emptyRPG();
    addFile(rpg, "src/lib.ts");
    addFile(rpg, "src/main.ts");
    const ops = JSON.stringify({
      operations: [
        {
          kind: "move_file",
          fromPath: "src/lib.ts",
          toPath: "src/lib/index.ts",
        },
      ],
    });
    const { client } = mockClient([ops]);
    const r = await runRefactorPass(client, rpg, { description: "x" });
    expect(r.ok, r.error).toBe(true);
    expect(r.operations).toHaveLength(1);
    expect(rpg.nodes["file:src/lib.ts"]).toBeUndefined();
    expect(rpg.nodes["file:src/lib/index.ts"]).toBeDefined();
  });

  it("rejects unknown op kinds with a clear validation error", async () => {
    const rpg = emptyRPG();
    const ops = JSON.stringify({
      operations: [{ kind: "delete_universe" }],
    });
    const corrected = JSON.stringify({ operations: [] });
    const { client, calls } = mockClient([ops, corrected]);
    const r = await runRefactorPass(client, rpg, {
      description: "x",
      maxAttempts: 2,
    });
    expect(r.ok).toBe(true);
    // Retry shape preserved.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.map((m: any) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(calls[1]!.messages[3]!.content).toMatch(/unknown kind/);
  });

  it("surfaces apply failures in the result", async () => {
    const rpg = emptyRPG();
    // No file at the source — move will fail.
    const ops = JSON.stringify({
      operations: [
        {
          kind: "move_file",
          fromPath: "src/missing.ts",
          toPath: "src/elsewhere.ts",
        },
      ],
    });
    const { client } = mockClient([ops]);
    const r = await runRefactorPass(client, rpg, { description: "x" });
    expect(r.ok).toBe(false);
    expect(r.applyReport).toBeDefined();
    expect(r.applyReport!.results[0]!.errorCode).toBe("FILE_NOT_FOUND");
  });
});

describe("parseRefactorResponse — validation matrix", () => {
  it("rename_file canonicalizes to move_file", () => {
    const r = parseRefactorResponse(
      JSON.stringify({
        operations: [
          { kind: "rename_file", fromPath: "a.ts", toPath: "b.ts" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations[0]!.kind).toBe("move_file");
  });

  it("split_file requires non-empty into[].leafCapabilityIds", () => {
    const r = parseRefactorResponse(
      JSON.stringify({
        operations: [
          {
            kind: "split_file",
            fromPath: "src/x.ts",
            into: [{ path: "src/a.ts", leafCapabilityIds: [] }],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/leafCapabilityIds/);
  });

  it("extract_base_class rejects malformed methods", () => {
    const r = parseRefactorResponse(
      JSON.stringify({
        operations: [
          {
            kind: "extract_base_class",
            toFile: "src/base.ts",
            baseClassName: "Base",
            baseDescription: "x",
            methods: [{ name: "m" }], // missing description, signature, isStatic
            rewriteExtenders: [
              { filePath: "src/a.ts", className: "Alpha" },
            ],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/methods/);
  });

  it("extract_utility members must include all three fields", () => {
    const r = parseRefactorResponse(
      JSON.stringify({
        operations: [
          {
            kind: "extract_utility",
            toFile: "src/util.ts",
            members: [{ fromFile: "src/a.ts", functionName: "x" }],
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/leafCapabilityId/);
  });

  it("merge_files needs non-empty fromPaths", () => {
    const r = parseRefactorResponse(
      JSON.stringify({
        operations: [
          { kind: "merge_files", fromPaths: [], toPath: "src/c.ts" },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fromPaths/);
  });
});

describe("renderRefactorPromptBody", () => {
  it("renders files with their plans, sorted", async () => {
    const rpg = emptyRPG();
    const a = addFile(rpg, "src/b.ts");
    a.interfacePlan = {
      classes: [
        {
          name: "BetaClass",
          containerKind: "class",
          description: "demo",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [],
    };
    const b = addFile(rpg, "src/a.ts");
    b.interfacePlan = {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:1",
          kind: "function",
          name: "alphaFn",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "do alpha",
          exported: true,
          isStatic: false,
        },
      ],
    };
    const { renderRefactorPromptBody } = await import(
      "../src/architect/refactor-prompts.js"
    );
    const body = renderRefactorPromptBody(rpg);
    expect(body.indexOf("src/a.ts")).toBeLessThan(body.indexOf("src/b.ts"));
    expect(body).toMatch(/alphaFn/);
    expect(body).toMatch(/BetaClass/);
    void isFile; // silence unused-import in this file
  });
});
