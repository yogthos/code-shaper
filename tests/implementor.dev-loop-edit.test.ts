/**
 * Step 2 of the agentic dev-loop refactor: editFileTool.
 *
 * String-replace edit tool — the shape ampcode's canonical agent
 * uses, which Claude / GLM are demonstrably best at. The model
 * supplies (path, old_str, new_str); we apply the replace to the
 * CURRENT rendered source, validate, and write the new body back
 * to bodyByLeafId.
 *
 * Scope safety: the model can only edit the file containing the
 * leaf currently being implemented. Other files (errors,
 * helpers, etc.) are read-only via `readFileTool` — same scoping
 * discipline as the existing §D.2 tools, which keeps multi-leaf
 * builds reproducible.
 */

import { describe, it, expect } from "vitest";
import { editFileTool } from "../src/implementor/dev-loop-tools.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";

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
};

describe("editFileTool — happy paths", () => {
  it("string-replaces inside the active leaf's host file and writes the new body to bodyByLeafId", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const bodies = new Map<string, string>();
    const r = await editFileTool({
      rpg,
      bodyByLeafId: bodies,
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: 'throw new Error("add: not implemented");',
      new_str: "return a + b;",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Body extracted back into the map so subsequent renders +
    // tests run against the new code.
    expect(bodies.get("cap:add")).toContain("return a + b");
  });

  it("supports multi-line old_str / new_str", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const bodies = new Map<string, string>();
    const r = await editFileTool({
      rpg,
      bodyByLeafId: bodies,
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: 'throw new Error("add: not implemented");',
      new_str: "if (a < 0 || b < 0) throw new Error('negative');\n  return a + b;",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bodies.get("cap:add")).toContain("if (a < 0 || b < 0)");
    expect(bodies.get("cap:add")).toContain("return a + b");
  });
});

describe("editFileTool — rejections", () => {
  it("rejects when old_str does not appear in the file", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: "this string is not in the file",
      new_str: "anything",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|no match/i);
  });

  it("rejects when old_str matches more than once (ambiguous)", async () => {
    const f = mkFile({
      id: "file:dup",
      path: "src/dup.ts",
      content: "export function a() {}\nexport function b() {}\n// repeat\n// repeat\n",
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/dup.ts",
      activeLeafId: "leaf:dup",
      path: "src/dup.ts",
      old_str: "// repeat",
      new_str: "// fixed",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/match.*\b2\b|appears 2 times/i);
    // Tell the model to add more context to disambiguate — that's
    // the canonical recovery for string-replace ambiguity.
    expect(r.error).toMatch(/more context|disambiguate/i);
  });

  it("rejects when old_str equals new_str (no-op)", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: 'throw new Error("add: not implemented");',
      new_str: 'throw new Error("add: not implemented");',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/identical|no-op|differ/i);
  });

  it("rejects edits to files other than the active leaf's host file", async () => {
    const a = mkFile({
      id: "file:a",
      path: "src/a.ts",
      interfacePlan: ADD_PLAN,
    });
    const b = mkFile({ id: "file:b", path: "src/b.ts", content: "export const x = 1;\n" });
    const rpg = rpgWithFiles([a, b]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/a.ts",
      activeLeafId: "cap:add",
      path: "src/b.ts",
      old_str: "x = 1",
      new_str: "x = 2",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/active leaf|out of scope|src\/a\.ts/);
  });

  it("rejects when the resulting source doesn't parse as TypeScript", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: 'throw new Error("add: not implemented");',
      // Deliberate broken syntax.
      new_str: "return a +;",
    });
    expect(r.ok).toBe(false);
    // Same positional format the audit-fix #3 added on parseTs.
    expect(r.error).toMatch(/parse error/i);
  });

  it("rejects when the new content no longer contains the active leaf's body extractable", async () => {
    // Replacing the whole function declaration breaks the
    // body-extractor invariant — `extractFunctionBody("add")`
    // returns null when the function is renamed/removed.
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: "function add",
      new_str: "function notAdd",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/leaf|extract|named/i);
  });

  // Step U2: edits to NON-leaf scopes must persist across
  // re-renders. Previously the renderer regenerated from
  // interfacePlan + bodyByLeafId, wiping any edit to a class
  // declaration whose constructor wasn't a leaf. The overlay
  // makes the post-edit source authoritative.
  it("an edit to a non-leaf class persists across re-render (U2)", async () => {
    // File has TWO things: leaf `add` (function) AND a non-leaf
    // class `Helper`. Model edits Helper to add a constructor +
    // field. The next render must include those.
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
        // Helper class declared but with NO planned methods —
        // the renderer would emit `class Helper {}`.
        classes: [
          {
            name: "Helper",
            description: "",
            extendsName: null,
            extendsFromFile: null,
            exported: true,
          },
        ],
      },
    });
    const rpg = rpgWithFiles([f]);
    // Step 1: the model edits add's body. Setting userEditedSource
    // captures the full source at that point.
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/add.ts",
      old_str: 'throw new Error("add: not implemented");',
      new_str: "return a + b;",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // Re-render: the overlay must be returned verbatim.
    const rendered2 = await import("../src/implementor/render.js").then(
      (m) =>
        m.renderTypeScriptFile({ file: f, bodyByLeafId: new Map(), rpg }),
    );
    expect(rendered2).toContain("return a + b");
    // The overlay was set.
    expect(f.userEditedSource).toBeDefined();
    expect(f.userEditedSource).toContain("return a + b");
  });

  it("rejects unknown path with a helpful message", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "src/missing.ts",
      old_str: "x",
      new_str: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the project|no such file/i);
  });
});

// Step S4: edit_file accepts infra paths (package.json,
// tsconfig.json, vitest.config.ts, .env) regardless of the
// active leaf — these are project-wide config the model needs
// to own to fix env-shaped failures. Edits go to disk under
// outDir, serialized via the infra mutex.
describe("editFileTool — infra paths (S4)", () => {
  it("edits package.json on disk under outDir", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = (await import("node:path")).default;
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "s4-"));
    try {
      await fs.writeFile(
        path.join(outDir, "package.json"),
        JSON.stringify(
          { name: "test", version: "0.1.0", scripts: { test: "vitest run" } },
          null,
          2,
        ),
      );
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const r = await editFileTool({
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        activeFilePath: "src/add.ts", // editing infra is allowed even though active is src/add.ts
        activeLeafId: "cap:add",
        path: "package.json",
        old_str: '"version": "0.1.0"',
        new_str: '"version": "0.2.0"',
        outDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.kind).toBe("infra");
      const updated = JSON.parse(
        await fs.readFile(path.join(outDir, "package.json"), "utf-8"),
      );
      expect(updated.version).toBe("0.2.0");
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("edits vitest.config.ts on disk and validates TS syntax", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = (await import("node:path")).default;
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "s4-"));
    try {
      await fs.writeFile(
        path.join(outDir, "vitest.config.ts"),
        'import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n',
      );
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const r = await editFileTool({
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        activeFilePath: "src/add.ts",
        activeLeafId: "cap:add",
        path: "vitest.config.ts",
        old_str: "defineConfig({})",
        new_str: 'defineConfig({ test: { environment: "jsdom" } })',
        outDir,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const after = await fs.readFile(
        path.join(outDir, "vitest.config.ts"),
        "utf-8",
      );
      expect(after).toContain("jsdom");
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects an infra edit that produces invalid JSON", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = (await import("node:path")).default;
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "s4-"));
    try {
      await fs.writeFile(
        path.join(outDir, "package.json"),
        '{ "name": "test", "version": "0.1.0" }',
      );
      const f = mkFile({
        id: "file:add",
        path: "src/add.ts",
        interfacePlan: ADD_PLAN,
      });
      const rpg = rpgWithFiles([f]);
      const r = await editFileTool({
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        activeFilePath: "src/add.ts",
        activeLeafId: "cap:add",
        path: "package.json",
        old_str: '"version": "0.1.0"',
        new_str: '"version": 0.1.0,', // trailing comma → invalid JSON
        outDir,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/JSON/i);
      // Disk content unchanged.
      const after = await fs.readFile(
        path.join(outDir, "package.json"),
        "utf-8",
      );
      expect(after).toContain('"version": "0.1.0"');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("rejects infra edits when outDir is not configured", async () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: ADD_PLAN,
    });
    const rpg = rpgWithFiles([f]);
    const r = await editFileTool({
      rpg,
      bodyByLeafId: new Map(),
      testsByLeafId: new Map(),
      activeFilePath: "src/add.ts",
      activeLeafId: "cap:add",
      path: "package.json",
      old_str: "x",
      new_str: "y",
      // outDir intentionally omitted.
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outDir/i);
  });
});
