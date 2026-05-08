/**
 * §D.1 localization tools — tests over hand-built RPGs.
 */

import { describe, it, expect } from "vitest";
import {
  viewFileInterfaceFeatureMap,
  getInterfaceContent,
  expandLeafNodeInfo,
  searchInterfaceByFunctionality,
} from "../src/architect/localization-tools.js";
import {
  emptyRPG,
  type CapabilityNode,
  type ClassNode,
  type FileNode,
  type FolderNode,
  type FunctionNode,
  type MethodNode,
  type RPG,
} from "../src/rpg/index.js";

function buildPlannedRpg(): { rpg: RPG; file: FileNode } {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  rpg.nodes["folder:src"] = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src",
  };
  root.children.push("folder:src");

  const file: FileNode = {
    id: "file:src/store.ts",
    kind: "file",
    name: "store.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/store.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [
        {
          name: "TodoStore",
          description: "An in-memory todo store.",
          exported: true,
          extendsName: null,
          extendsFromFile: null,
        },
      ],
      entries: [
        {
          leafCapabilityId: "cap:add",
          kind: "method",
          ownerClassName: "TodoStore",
          name: "addTodo",
          signature: {
            params: [{ name: "text", type: "string" }],
            returnType: "Todo",
            isAsync: false,
          },
          description: "Append a new active todo with a fresh id.",
          exported: false,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:make-id",
          kind: "function",
          ownerClassName: null,
          name: "makeId",
          signature: { params: [], returnType: "string", isAsync: false },
          description: "Mint a new unique id.",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
  return { rpg, file };
}

function buildAstRpg(): { rpg: RPG; file: FileNode } {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  rpg.nodes["folder:src"] = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src",
  };
  root.children.push("folder:src");

  const fileSource = `function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

class Counter {
  inc(): number {
    return 0;
  }
}
`;
  const file: FileNode = {
    id: "file:src/util.ts",
    kind: "file",
    name: "util.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/util.ts",
    content: fileSource,
    language: "typescript",
    rawImports: [],
    exports: ["clamp"],
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);

  const clampStart = fileSource.indexOf("function clamp");
  const clampEnd = fileSource.indexOf("}", clampStart) + 1;
  const fn: FunctionNode = {
    id: "function:file:src/util.ts#clamp@1",
    kind: "function",
    name: "clamp",
    parent: file.id,
    file: file.id,
    children: [],
    features: [],
    byteRange: { start: clampStart, end: clampEnd },
    lineRange: { start: 1, end: 3 },
    exported: true,
  };
  rpg.nodes[fn.id] = fn;
  file.children.push(fn.id);

  const classStart = fileSource.indexOf("class Counter");
  const classEnd = fileSource.indexOf("}\n", classStart) + 1;
  const cls: ClassNode = {
    id: "class:file:src/util.ts#Counter@5",
    kind: "class",
    name: "Counter",
    parent: file.id,
    file: file.id,
    children: [],
    features: [],
    byteRange: { start: classStart, end: classEnd },
    lineRange: { start: 5, end: 9 },
    extendsNames: [],
  };
  rpg.nodes[cls.id] = cls;
  file.children.push(cls.id);

  const methStart = fileSource.indexOf("inc(): number");
  const methEnd = fileSource.indexOf("}", methStart) + 1;
  const meth: MethodNode = {
    id: "method:class:file:src/util.ts#Counter@5#inc@6",
    kind: "method",
    name: "inc",
    parent: cls.id,
    file: file.id,
    children: [],
    features: [],
    byteRange: { start: methStart, end: methEnd },
    lineRange: { start: 6, end: 8 },
    ownerClass: cls.id,
    isStatic: false,
  };
  rpg.nodes[meth.id] = meth;
  cls.children.push(meth.id);

  return { rpg, file };
}

describe("viewFileInterfaceFeatureMap", () => {
  it("lists planned classes + methods + standalone functions with feature tags", () => {
    const { rpg } = buildPlannedRpg();
    const map = viewFileInterfaceFeatureMap(rpg, "src/store.ts");
    expect(map).not.toBeNull();
    expect(map!.filePath).toBe("src/store.ts");
    expect(map!.functions).toHaveLength(1);
    expect(map!.functions[0]!.name).toBe("makeId");
    expect(map!.functions[0]!.features).toContain("Mint a new unique id.");
    expect(map!.classes).toHaveLength(1);
    expect(map!.classes[0]!.name).toBe("TodoStore");
    expect(map!.classes[0]!.methods).toHaveLength(1);
    expect(map!.classes[0]!.methods[0]!.name).toBe("addTodo");
    expect(map!.classes[0]!.methods[0]!.features).toContain(
      "Append a new active todo with a fresh id.",
    );
    expect(map!.functions[0]!.signature).toContain("(): string");
  });

  it("falls back to AST children when there's no interfacePlan", () => {
    const { rpg } = buildAstRpg();
    const map = viewFileInterfaceFeatureMap(rpg, "src/util.ts");
    expect(map).not.toBeNull();
    expect(map!.functions.map((f) => f.name)).toEqual(["clamp"]);
    expect(map!.classes.map((c) => c.name)).toEqual(["Counter"]);
    expect(map!.classes[0]!.methods.map((m) => m.name)).toEqual(["inc"]);
  });

  it("returns null for an unknown file", () => {
    const { rpg } = buildPlannedRpg();
    expect(viewFileInterfaceFeatureMap(rpg, "src/missing.ts")).toBeNull();
  });
});

describe("getInterfaceContent", () => {
  it("returns the AST source slice for a top-level function", () => {
    const { rpg } = buildAstRpg();
    const r = getInterfaceContent(rpg, "src/util.ts:clamp");
    expect(r.kind).toBe("function");
    expect(r.source).toContain("Math.max(lo, Math.min(hi, n))");
    expect(r.filePath).toBe("src/util.ts");
  });

  it("returns the AST source slice for a method on a class", () => {
    const { rpg } = buildAstRpg();
    const r = getInterfaceContent(rpg, "src/util.ts:Counter.inc");
    expect(r.kind).toBe("method");
    expect(r.source).toContain("return 0;");
  });

  it("returns the AST source slice for a class declaration", () => {
    const { rpg } = buildAstRpg();
    const r = getInterfaceContent(rpg, "src/util.ts:Counter");
    expect(r.kind).toBe("class");
    expect(r.source).toContain("class Counter");
  });

  it("returns kind=not_found on unknown spec", () => {
    const { rpg } = buildAstRpg();
    expect(
      getInterfaceContent(rpg, "src/util.ts:Missing").kind,
    ).toBe("not_found");
    expect(
      getInterfaceContent(rpg, "src/missing.ts:foo").kind,
    ).toBe("not_found");
    expect(getInterfaceContent(rpg, "no-colon").kind).toBe("not_found");
  });
});

describe("expandLeafNodeInfo", () => {
  it("returns the interface mapped to a leaf capability path", () => {
    const { rpg, file } = buildPlannedRpg();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    const cap: CapabilityNode = {
      id: "cap:add",
      kind: "capability",
      name: "addTodo",
      description: "Append a new active todo with a fresh id.",
      parent: rpg.rootId,
      children: [],
      features: [],
      isLeaf: true,
      status: "mapped",
      mappedToId: file.id,
      decompositionDepth: 0,
    };
    rpg.nodes[cap.id] = cap;
    root.children.push(cap.id);
    const r = expandLeafNodeInfo(rpg, "addTodo");
    expect(r.capabilityId).toBe("cap:add");
    expect(r.interfaces).toHaveLength(1);
    expect(r.interfaces[0]!.name).toBe("TodoStore.addTodo");
    expect(r.interfaces[0]!.kind).toBe("method");
  });

  it("walks descendants for a non-leaf capability", () => {
    const { rpg, file } = buildPlannedRpg();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    const parent: CapabilityNode = {
      id: "cap:store",
      kind: "capability",
      name: "TodoStore",
      description: "Storage layer.",
      parent: rpg.rootId,
      children: [],
      features: [],
      isLeaf: false,
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    const leaf: CapabilityNode = {
      id: "cap:add",
      kind: "capability",
      name: "addTodo",
      description: "Append.",
      parent: "cap:store",
      children: [],
      features: [],
      isLeaf: true,
      status: "mapped",
      mappedToId: file.id,
      decompositionDepth: 1,
    };
    rpg.nodes[parent.id] = parent;
    rpg.nodes[leaf.id] = leaf;
    parent.children.push(leaf.id);
    root.children.push(parent.id);
    const r = expandLeafNodeInfo(rpg, "TodoStore/addTodo");
    expect(r.interfaces).toHaveLength(1);
    expect(r.interfaces[0]!.name).toBe("TodoStore.addTodo");
  });

  it("returns capabilityId=null when the path doesn't resolve", () => {
    const { rpg } = buildPlannedRpg();
    const r = expandLeafNodeInfo(rpg, "Nope/Not/Here");
    expect(r.capabilityId).toBeNull();
    expect(r.interfaces).toEqual([]);
  });
});

describe("searchInterfaceByFunctionality", () => {
  it("ranks interfaces by keyword overlap and returns the top-K", () => {
    const { rpg } = buildPlannedRpg();
    const r = searchInterfaceByFunctionality(rpg, ["unique", "id"]);
    expect(r.hits.length).toBeGreaterThan(0);
    // makeId's description "Mint a new unique id." matches both
    // "unique" and "id" (camelCase tokenization on `makeId` adds
    // "make"/"id" to the haystack tokens too).
    expect(r.hits[0]!.name).toBe("makeId");
    // Score is now length-normalized (review fix #5): hits / sqrt(tokens).
    // We just need it positive and beating the lower-ranked entries.
    expect(r.hits[0]!.score).toBeGreaterThan(0);
  });

  it("returns at most topK results", () => {
    const { rpg } = buildPlannedRpg();
    const r = searchInterfaceByFunctionality(rpg, ["todo"], 1);
    expect(r.hits.length).toBeLessThanOrEqual(1);
  });

  it("returns empty hits when nothing overlaps", () => {
    const { rpg } = buildPlannedRpg();
    const r = searchInterfaceByFunctionality(rpg, [
      "totallyirrelevantkeyword",
    ]);
    expect(r.hits).toEqual([]);
  });

  it("searches AST-extracted interfaces too (extend mode)", () => {
    const { rpg } = buildAstRpg();
    const r = searchInterfaceByFunctionality(rpg, ["clamp"]);
    expect(r.hits.some((h) => h.name === "clamp")).toBe(true);
  });
});
