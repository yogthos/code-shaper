/**
 * Acceptance tests for the operations / refactor review fixes:
 *
 *   #1 Move resolves index-file imports: when a file is moved into a
 *      directory and was imported as the directory's index, importers'
 *      sources rewrite correctly.
 *   #2 split_file rejects partitions that cleave a class's methods
 *      across destinations.
 *   #3 extract_base_class populates the base file's plan with method
 *      entries from `op.methods`.
 *   #4 alreadyImplemented uses word-boundary matching against the
 *      leaf's name (not loose substring on description).
 */

import { describe, it, expect } from "vitest";

import {
  emptyRPG,
  isCapability,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  applyOperation,
  designInterfaces,
} from "../src/architect/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

function addFile(
  rpg: RPG,
  relPath: string,
  init: Partial<FileNode> = {},
): FileNode {
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
    language: null,
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

function mockClient(responses: string[]): LLMClient {
  let i = 0;
  return {
    async chat(): Promise<LLMResponse> {
      return { content: responses[i++] ?? "", finishReason: "stop" };
    },
    async listModels() {
      return ["mock"];
    },
  };
}

describe("review fix #1 — index-file import resolution on move", () => {
  it("a move that creates an index file rewrites importers using directory imports", () => {
    const rpg = emptyRPG();
    addFile(rpg, "src/lib.ts");
    // main imports from "./lib" with no extension — convention for an
    // index-style barrel. After moving lib.ts to src/lib/index.ts the
    // specifier should still resolve.
    addFile(rpg, "src/main.ts", {
      rawImports: [{ name: "x", source: "./lib", isDefault: false }],
    });
    const r = applyOperation(rpg, {
      kind: "move_file",
      fromPath: "src/lib.ts",
      toPath: "src/lib/index.ts",
    });
    expect(r.ok, r.error).toBe(true);
    const main = rpg.nodes["file:src/main.ts"] as FileNode;
    // The import source should still resolve. Either of the two
    // conventional forms is acceptable: the directory itself ("./lib")
    // or the explicit index form ("./lib/index").
    const newSource = main.rawImports[0]!.source;
    expect(["./lib", "./lib/index"]).toContain(newSource);
  });
});

describe("review fix #2 — split_file rejects class-spanning partitions", () => {
  it("refuses when methods of the same class are partitioned across destinations", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/big.ts");
    f.interfacePlan = {
      classes: [
        {
          name: "Service",
          description: "x",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [
        {
          leafCapabilityId: "cap:m1",
          kind: "method",
          ownerClassName: "Service",
          name: "m1",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:m2",
          kind: "method",
          ownerClassName: "Service",
          name: "m2",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
      ],
    };

    const r = applyOperation(rpg, {
      kind: "split_file",
      fromPath: "src/big.ts",
      into: [
        { path: "src/a.ts", leafCapabilityIds: ["cap:m1"] },
        { path: "src/b.ts", leafCapabilityIds: ["cap:m2"] },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("OVERLAPPING_PARTITION");
    expect(r.error).toMatch(/Service|class/);
  });

  it("permits a split where every method of a class lands in the same destination", () => {
    const rpg = emptyRPG();
    const f = addFile(rpg, "src/big.ts");
    f.interfacePlan = {
      classes: [
        {
          name: "Service",
          description: "x",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [
        {
          leafCapabilityId: "cap:m1",
          kind: "method",
          ownerClassName: "Service",
          name: "m1",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:m2",
          kind: "method",
          ownerClassName: "Service",
          name: "m2",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:fn",
          kind: "function",
          ownerClassName: null,
          name: "alone",
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
      ],
    };

    const r = applyOperation(rpg, {
      kind: "split_file",
      fromPath: "src/big.ts",
      into: [
        {
          path: "src/service.ts",
          leafCapabilityIds: ["cap:m1", "cap:m2"],
        },
        { path: "src/alone.ts", leafCapabilityIds: ["cap:fn"] },
      ],
    });
    expect(r.ok, r.error).toBe(true);
    const svc = rpg.nodes["file:src/service.ts"] as FileNode;
    expect(svc.interfacePlan!.classes.map((c) => c.name)).toEqual(["Service"]);
    expect(svc.interfacePlan!.entries.map((e) => e.name).sort()).toEqual([
      "m1",
      "m2",
    ]);
  });
});

describe("review fix #3 — extract_base_class populates base methods", () => {
  it("inserts method entries into the base file's interface plan", () => {
    const rpg = emptyRPG();
    const a = addFile(rpg, "src/a.ts");
    a.interfacePlan = {
      classes: [
        {
          name: "Alpha",
          description: "",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [],
    };
    const b = addFile(rpg, "src/b.ts");
    b.interfacePlan = {
      classes: [
        {
          name: "Beta",
          description: "",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
      entries: [],
    };

    const r = applyOperation(rpg, {
      kind: "extract_base_class",
      toFile: "src/base.ts",
      baseClassName: "Base",
      baseDescription: "shared base",
      methods: [
        {
          name: "doIt",
          description: "shared method",
          signature: {
            params: [{ name: "ctx", type: "string" }],
            returnType: "void",
            isAsync: false,
          },
          isStatic: false,
        },
      ],
      rewriteExtenders: [
        { filePath: "src/a.ts", className: "Alpha" },
        { filePath: "src/b.ts", className: "Beta" },
      ],
    });
    expect(r.ok, r.error).toBe(true);

    const base = rpg.nodes["file:src/base.ts"] as FileNode;
    expect(base.interfacePlan!.entries).toHaveLength(1);
    const entry = base.interfacePlan!.entries[0]!;
    expect(entry.kind).toBe("method");
    expect(entry.name).toBe("doIt");
    expect(entry.ownerClassName).toBe("Base");
    expect(entry.signature.params[0]!.name).toBe("ctx");
    expect(entry.leafCapabilityId).toMatch(/^iface:src\/base\.ts/);
  });
});

describe("review fix #4 — alreadyImplemented uses word-boundary matching", () => {
  it("does not skip a leaf whose name only loosely overlaps an existing export", async () => {
    // Existing file exports `get`. New leaf description includes the
    // substring "get" coincidentally ("get the entries"). Old loose-
    // substring heuristic would falsely mark it implemented; the new
    // logic should keep it in the unplanned set.
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    const file: FileNode = {
      id: "file:src/db.ts",
      kind: "file",
      name: "db.ts",
      parent: rpg.rootId,
      children: ["function:file:src/db.ts#get@1"],
      features: [],
      path: "src/db.ts",
      content: "export function get() {}",
      language: "typescript",
      rawImports: [],
      exports: ["get"],
    };
    rpg.nodes[file.id] = file;
    rpg.nodes["function:file:src/db.ts#get@1"] = {
      id: "function:file:src/db.ts#get@1",
      kind: "function",
      name: "get",
      parent: file.id,
      children: [],
      features: [],
      file: file.id,
      byteRange: { start: 0, end: 24 },
      lineRange: { start: 1, end: 1 },
      exported: true,
    };
    root.children.push(file.id);

    const leaf = {
      id: "cap:export-csv",
      kind: "capability" as const,
      name: "Export entries to CSV",
      parent: rpg.rootId,
      children: [],
      features: [],
      // description contains "get" as a loose substring — the old code
      // would skip this leaf incorrectly.
      description: "Get all entries from the database and serialize as CSV.",
      isLeaf: true,
      status: "mapped" as const,
      mappedToId: file.id,
      decompositionDepth: 0,
    };
    rpg.nodes[leaf.id] = leaf;
    root.children.push(leaf.id);

    const planResponse = JSON.stringify({
      interfaces: [
        {
          leafCapabilityId: leaf.id,
          filePath: "src/db.ts",
          kind: "function",
          name: "exportEntriesToCsv",
          ownerClassName: null,
          signature: { params: [], returnType: "string", isAsync: false },
          description: "Render entries as CSV.",
          exported: true,
          isStatic: false,
        },
      ],
      classes: [],
      dataFlow: [],
    });
    const client = mockClient([planResponse]);
    const result = await designInterfaces(client, rpg, {
      description: "Add CSV export to the existing guestbook.",
      mode: "extend",
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.unplannedLeaves).toEqual([]);
    // The cap was treated as needing a plan; it now has an entry.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe("exportEntriesToCsv");

    // Sanity: the cap is now mapped + has the entry routed to it.
    const cap = rpg.nodes[leaf.id];
    if (!cap || !isCapability(cap)) throw new Error("kind drift");
    expect(cap.mappedToId).toBe(file.id);
  });

  it("does still skip when an export name appears as a whole word in the leaf name", async () => {
    // Existing function `exportEntriesToCsv`. New leaf with the same
    // *exact* concept — heuristic should mark it implemented.
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    const file: FileNode = {
      id: "file:src/db.ts",
      kind: "file",
      name: "db.ts",
      parent: rpg.rootId,
      children: ["function:file:src/db.ts#exportEntriesToCsv@1"],
      features: [],
      path: "src/db.ts",
      content: "export function exportEntriesToCsv() {}",
      language: "typescript",
      rawImports: [],
      exports: ["exportEntriesToCsv"],
    };
    rpg.nodes[file.id] = file;
    rpg.nodes["function:file:src/db.ts#exportEntriesToCsv@1"] = {
      id: "function:file:src/db.ts#exportEntriesToCsv@1",
      kind: "function",
      name: "exportEntriesToCsv",
      parent: file.id,
      children: [],
      features: [],
      file: file.id,
      byteRange: { start: 0, end: 39 },
      lineRange: { start: 1, end: 1 },
      exported: true,
    };
    root.children.push(file.id);

    const leaf = {
      id: "cap:dup",
      kind: "capability" as const,
      name: "exportEntriesToCsv",
      parent: rpg.rootId,
      children: [],
      features: [],
      description: "Render entries as CSV.",
      isLeaf: true,
      status: "mapped" as const,
      mappedToId: file.id,
      decompositionDepth: 0,
    };
    rpg.nodes[leaf.id] = leaf;
    root.children.push(leaf.id);

    // Empty plan response — nothing to plan because the leaf is skipped.
    const client = mockClient([JSON.stringify({
      interfaces: [],
      classes: [],
      dataFlow: [],
    })]);
    const result = await designInterfaces(client, rpg, {
      description: "Add CSV export.",
      mode: "extend",
    });
    expect(result.ok, result.error).toBe(true);
    // Skipped leaves don't appear in unplannedLeaves either — they're
    // outside the architect's required set entirely.
    expect(result.unplannedLeaves).toEqual([]);
    expect(result.entries).toHaveLength(0);
  });
});
