/**
 * TS source renderer acceptance.
 *
 *   - Empty file (no plan) renders as a single newline.
 *   - Standalone function renders with signature + body or stub.
 *   - Class renders with methods grouped, in plan order.
 *   - Multiple imports group by source; defaults vs named handled.
 *   - Cross-file extends pulls in an import for the base class even
 *     when rawImports doesn't already carry it (safety net).
 *   - Output round-trips through tree-sitter (loadRepo of a temp
 *     directory containing the rendered file extracts the same
 *     functions/classes the plan declared).
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  emptyRPG,
  loadRepo,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import { renderTypeScriptFile } from "../src/implementor/render.js";

function addFile(rpg: RPG, relPath: string, init: Partial<FileNode> = {}): FileNode {
  const id = `file:${relPath}`;
  const parentDir = relPath.includes("/")
    ? relPath.replace(/\/[^/]+$/, "")
    : "";
  ensureFolder(rpg, parentDir);
  const parentId = parentDir ? `folder:${parentDir}` : rpg.rootId;
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
    ...init,
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

describe("renderTypeScriptFile", () => {
  it("renders an empty plan as a single newline", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/empty.ts");
    const out = renderTypeScriptFile({ file: f, bodyByLeafId: new Map(), rpg });
    expect(out).toBe("\n");
  });

  it("renders an exported async function with body", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/util.ts");
    f.interfacePlan = {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:fetch",
          kind: "function",
          ownerClassName: null,
          name: "fetchEntries",
          signature: {
            params: [{ name: "url", type: "string" }],
            returnType: "Promise<string[]>",
            isAsync: true,
          },
          description: "Fetch entries from the given URL.",
          exported: true,
          isStatic: false,
        },
      ],
    };
    const bodies = new Map([
      ["cap:fetch", "const res = await fetch(url);\nreturn await res.json();"],
    ]);
    const out = renderTypeScriptFile({ file: f, bodyByLeafId: bodies, rpg });
    expect(out).toContain("export async function fetchEntries(url: string): Promise<string[]>");
    expect(out).toContain("const res = await fetch(url);");
    expect(out).toContain("return await res.json();");
    expect(out).toContain("/** Fetch entries from the given URL. */");
  });

  it("stubs an unimplemented leaf with a throwing body", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/x.ts");
    f.interfacePlan = {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:todo",
          kind: "function",
          ownerClassName: null,
          name: "todo",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "TBD.",
          exported: false,
          isStatic: false,
        },
      ],
    };
    const out = renderTypeScriptFile({
      file: f,
      bodyByLeafId: new Map(),
      rpg,
    });
    expect(out).toContain('throw new Error("todo: not implemented");');
  });

  it("renders a class with two methods grouped in plan order", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/svc.ts");
    f.interfacePlan = {
      classes: [
        {
          name: "Service",
          description: "demo",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [
        {
          leafCapabilityId: "cap:open",
          kind: "method",
          ownerClassName: "Service",
          name: "open",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "open it",
          exported: true,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:close",
          kind: "method",
          ownerClassName: "Service",
          name: "close",
          signature: { params: [], returnType: "void", isAsync: true },
          description: "close it",
          exported: true,
          isStatic: false,
        },
      ],
    };
    const out = renderTypeScriptFile({
      file: f,
      bodyByLeafId: new Map([
        ["cap:open", "this.x = 1;"],
        ["cap:close", "await Promise.resolve();"],
      ]),
      rpg,
    });
    expect(out).toContain("export class Service {");
    expect(out).toContain("  open(): void {");
    expect(out).toContain("    this.x = 1;");
    expect(out).toContain("  async close(): void {");
    expect(out).toContain("    await Promise.resolve();");
    // Plan order: open before close.
    expect(out.indexOf("open(): void")).toBeLessThan(out.indexOf("close(): void"));
  });

  it("groups imports by source (named + default + side effect)", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/main.ts", {
      rawImports: [
        { name: "", source: "./polyfill.js", isDefault: false },
        { name: "DefaultClient", source: "./client.js", isDefault: true },
        { name: "helper", source: "./client.js", isDefault: false },
        { name: "other", source: "./client.js", isDefault: false },
      ],
    });
    f.interfacePlan = { classes: [], entries: [] };
    const out = renderTypeScriptFile({ file: f, bodyByLeafId: new Map(), rpg });
    expect(out).toContain('import "./polyfill.js";');
    expect(out).toContain(
      'import DefaultClient, { helper, other } from "./client.js";',
    );
  });

  it("backstops cross-file extends with a base-class import", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/sub/child.ts");
    f.interfacePlan = {
      classes: [
        {
          name: "Child",
          description: "x",
          extendsName: "Base",
          extendsFromFile: "src/base.ts",
          exported: true,
        },
      ],
      entries: [],
    };
    const out = renderTypeScriptFile({
      file: f,
      bodyByLeafId: new Map(),
      rpg,
    });
    expect(out).toContain("class Child extends Base");
    // Even though rawImports is empty, the renderer ensures the base
    // is reachable via an import line.
    expect(out).toMatch(/import \{ Base \} from "\.\.\/base"/);
  });

  it("docblock single-line vs multi-line at the 73-char body boundary", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/d.ts");
    const exactlyAtLimit = "x".repeat(73);
    const overLimit = "x".repeat(74);
    f.interfacePlan = {
      classes: [],
      entries: [
        {
          leafCapabilityId: "cap:tight",
          kind: "function",
          ownerClassName: null,
          name: "tight",
          signature: { params: [], returnType: "void", isAsync: false },
          description: exactlyAtLimit,
          exported: false,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:over",
          kind: "function",
          ownerClassName: null,
          name: "over",
          signature: { params: [], returnType: "void", isAsync: false },
          description: overLimit,
          exported: false,
          isStatic: false,
        },
      ],
    };
    const out = renderTypeScriptFile({
      file: f,
      bodyByLeafId: new Map(),
      rpg,
    });
    // 73 chars → single-line: exactly fits in `/** ... */` at 80 cols.
    expect(out).toContain(`/** ${exactlyAtLimit} */`);
    // 74 chars → multi-line.
    expect(out).toContain(`/**\n * ${overLimit}\n */`);
  });

  it("rendered output round-trips through tree-sitter", async () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/lib.ts");
    f.interfacePlan = {
      classes: [
        {
          name: "Box",
          description: "container",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [
        {
          leafCapabilityId: "cap:cls",
          kind: "method",
          ownerClassName: "Box",
          name: "size",
          signature: { params: [], returnType: "number", isAsync: false },
          description: "size",
          exported: false,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:fn",
          kind: "function",
          ownerClassName: null,
          name: "boxify",
          signature: {
            params: [{ name: "value", type: "number" }],
            returnType: "Box",
            isAsync: false,
          },
          description: "boxify",
          exported: true,
          isStatic: false,
        },
      ],
    };
    const source = renderTypeScriptFile({
      file: f,
      bodyByLeafId: new Map([
        ["cap:cls", "return 0;"],
        ["cap:fn", "void value; return new Box();"],
      ]),
      rpg,
    });

    const tmp = await mkdtemp(path.join(tmpdir(), "render-"));
    try {
      await mkdir(path.join(tmp, "src"), { recursive: true });
      await writeFile(path.join(tmp, "src/lib.ts"), source, "utf-8");
      const reloaded = await loadRepo(tmp);
      const reloadedFile = (Object.values(reloaded.nodes) as any[]).find(
        (n) => n.kind === "file" && n.path === "src/lib.ts",
      );
      expect(reloadedFile).toBeDefined();
      const childKinds = reloadedFile.children.map(
        (id: string) => reloaded.nodes[id]?.kind,
      );
      expect(childKinds).toContain("class");
      expect(childKinds).toContain("function");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
