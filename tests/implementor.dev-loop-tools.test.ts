/**
 * Step 1 of the agentic dev-loop refactor: read-only tools that
 * give the body author cross-file visibility.
 *
 * Tests the pure-function tool primitives (no LLM, no disk).
 * `list_files` walks the RPG; `read_file` renders the requested
 * file using the existing render pipeline.
 *
 * Why this exists: today the body author sees ONE rendered file
 * + a failure message. When the failure references a symbol
 * defined elsewhere (e.g. `TodoValidationError is not defined`),
 * the model has no way to ask "where does that live" and burns
 * its retry budget guessing. With these two tools the model can
 * `list_files` + `read_file` to discover the import — the same
 * shape ampcode's canonical agent uses.
 */

import { describe, it, expect } from "vitest";
import { listFilesTool, readFileTool } from "../src/implementor/dev-loop-tools.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";

function mkFolder(id: string, path: string): FolderNode {
  return {
    id,
    kind: "folder",
    name: path.split("/").pop() ?? "",
    path,
    parent: null,
    children: [],
    features: [],
  };
}

function mkFile(opts: {
  id: string;
  path: string;
  content?: string;
  exports?: string[];
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
    exports: opts.exports ?? [],
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

describe("listFilesTool", () => {
  it("returns every file in the RPG with path + summary derived from content or leaf descriptions", () => {
    const a = mkFile({
      id: "file:a",
      path: "src/add.ts",
      content: "/**\n * Pure addition helper.\n */\nexport function add() {}\n",
    });
    const b = mkFile({
      id: "file:b",
      path: "src/errors.ts",
      content: "// Project-wide error types.\nexport class FooError {}\n",
    });
    const rpg = rpgWithFiles([a, b]);
    const r = listFilesTool({ rpg });
    expect(r.files).toHaveLength(2);
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual(["src/add.ts", "src/errors.ts"]);
    const addF = r.files.find((f) => f.path === "src/add.ts");
    expect(addF!.summary).toContain("Pure addition helper");
    const errs = r.files.find((f) => f.path === "src/errors.ts");
    expect(errs!.summary).toContain("Project-wide error types");
  });

  it("includes planned leaf names + summary derived from leaf descriptions when interfacePlan is set", () => {
    const f = mkFile({
      id: "file:val",
      path: "src/validation.ts",
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:validate",
            kind: "function",
            name: "validateTodoText",
            ownerClassName: null,
            description: "Validate that the todo text is non-empty.",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [],
      },
    });
    const rpg = rpgWithFiles([f]);
    const r = listFilesTool({ rpg });
    expect(r.files[0]!.plannedLeaves).toEqual(["validateTodoText"]);
    expect(r.files[0]!.summary).toContain("Validate that the todo text");
  });

  it("omits non-file nodes (folders, capabilities)", () => {
    const a = mkFile({ id: "file:a", path: "src/a.ts" });
    const rpg = rpgWithFiles([a]);
    // Add a stray folder and capability — must not appear.
    rpg.nodes["folder:nested"] = mkFolder("folder:nested", "src/nested");
    const r = listFilesTool({ rpg });
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("returns an empty list when the RPG has no files", () => {
    const r = listFilesTool({ rpg: emptyRPG() });
    expect(r.files).toEqual([]);
  });
});

describe("readFileTool", () => {
  it("returns the rendered content of a planned file", () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: {
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
      },
    });
    const rpg = rpgWithFiles([f]);
    const r = readFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      path: "src/add.ts",
    });
    expect(r.ok).toBe(true);
    // Stub renders as a throwing function with the planned signature.
    expect(r.content).toContain("function add(a: number, b: number)");
    expect(r.content).toContain("not implemented");
  });

  it("reflects bodies set in bodyByLeafId", () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
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
    });
    const rpg = rpgWithFiles([f]);
    const bodies = new Map([["cap:add", "return a + b;"]]);
    const r = readFileTool({
      rpg,
      bodyByLeafId: bodies,
      testsByLeafId: new Map(),
      path: "src/add.ts",
    });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("return a + b");
    expect(r.content).not.toContain("not implemented");
  });

  it("returns the existing FileNode.content when the file has no interfacePlan (e.g., extend mode)", () => {
    const f = mkFile({
      id: "file:helper",
      path: "src/helper.ts",
      content: "// existing user code\nexport const x = 1;\n",
    });
    const rpg = rpgWithFiles([f]);
    const r = readFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      path: "src/helper.ts",
    });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("// existing user code");
  });

  it("returns ok=false with a clear error for unknown paths", () => {
    const a = mkFile({ id: "file:a", path: "src/a.ts" });
    const rpg = rpgWithFiles([a]);
    const r = readFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      path: "src/does-not-exist.ts",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the project|no such file/i);
    // The error should suggest the available paths so the model
    // doesn't keep guessing.
    expect(r.error).toMatch(/src\/a\.ts/);
  });

  it("rejects path-traversal attempts", () => {
    const a = mkFile({ id: "file:a", path: "src/a.ts" });
    const rpg = rpgWithFiles([a]);
    const r = readFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      path: "../etc/passwd",
    });
    expect(r.ok).toBe(false);
  });
});
