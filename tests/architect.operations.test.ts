/**
 * RPG operation vocabulary acceptance.
 *
 * Each op tested in isolation against an in-memory fixture, with no
 * LLM. Covers the full apply layer: validation, mutation, side-effect
 * reporting, and cross-file edge bookkeeping.
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
  applyOperations,
  type RPGOperation,
} from "../src/architect/operations.js";

function makeRpg(): RPG {
  return emptyRPG();
}

function addFile(
  rpg: RPG,
  relPath: string,
  init: Partial<FileNode> = {},
): FileNode {
  const id = `file:${relPath}`;
  const parentDir =
    relPath.includes("/") ? relPath.replace(/\/[^/]+$/, "") : "";
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
    language: null,
    rawImports: [],
    exports: [],
    ...init,
  };
  rpg.nodes[id] = file;
  const parent = rpg.nodes[parentId] as FolderNode;
  parent.children.push(id);
  return file;
}

function ensureFolder(rpg: RPG, relPath: string): FolderNode {
  if (relPath === "") return rpg.nodes[rpg.rootId] as FolderNode;
  const id = `folder:${relPath}`;
  if (rpg.nodes[id]) return rpg.nodes[id] as FolderNode;
  const parentDir = relPath.includes("/")
    ? relPath.replace(/\/[^/]+$/, "")
    : "";
  ensureFolder(rpg, parentDir);
  const parentId = parentDir ? `folder:${parentDir}` : rpg.rootId;
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

describe("create_folder / create_file", () => {
  it("create_folder is idempotent and backfills parents", () => {
    const rpg = makeRpg();
    const r1 = applyOperation(rpg, {
      kind: "create_folder",
      path: "src/http",
    });
    expect(r1.ok).toBe(true);
    expect(rpg.nodes["folder:src"]).toBeDefined();
    expect(rpg.nodes["folder:src/http"]).toBeDefined();

    const r2 = applyOperation(rpg, {
      kind: "create_folder",
      path: "src/http",
    });
    expect(r2.ok).toBe(true);
    expect(r2.filesAdded).toEqual([]);
  });

  it("create_file links a capability when capabilityId is provided", () => {
    const rpg = makeRpg();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    rpg.nodes["cap:foo"] = {
      id: "cap:foo",
      kind: "capability",
      name: "Foo",
      parent: rpg.rootId,
      children: [],
      features: [],
      description: "x",
      isLeaf: true,
      status: "planned",
      mappedToId: null,
      decompositionDepth: 0,
    };
    root.children.push("cap:foo");

    const r = applyOperation(rpg, {
      kind: "create_file",
      path: "src/foo.ts",
      capabilityId: "cap:foo",
    });
    expect(r.ok).toBe(true);
    expect(r.filesAdded).toEqual(["src/foo.ts"]);
    const cap = rpg.nodes["cap:foo"];
    if (!cap || !isCapability(cap)) throw new Error("kind drift");
    expect(cap.status).toBe("mapped");
    expect(cap.mappedToId).toBe("file:src/foo.ts");
  });

  it("rejects malformed paths", () => {
    const rpg = makeRpg();
    for (const bad of ["/abs/x.ts", "../escape.ts", "src/foo"]) {
      const r = applyOperation(rpg, { kind: "create_file", path: bad });
      expect(r.ok, `should reject ${bad}`).toBe(false);
      if (r.ok) continue;
      expect(r.errorCode).toBe("PATH_INVALID");
    }
  });
});

describe("delete_file", () => {
  it("removes a file with no importers", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/lonely.ts");
    const r = applyOperation(rpg, {
      kind: "delete_file",
      path: "src/lonely.ts",
    });
    expect(r.ok).toBe(true);
    expect(rpg.nodes["file:src/lonely.ts"]).toBeUndefined();
    expect(r.filesRemoved).toEqual(["src/lonely.ts"]);
  });

  it("refuses to delete a file that is still imported", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/lib.ts");
    addFile(rpg, "src/main.ts", {
      rawImports: [{ name: "x", source: "./lib.js", isDefault: false }],
    });
    const r = applyOperation(rpg, {
      kind: "delete_file",
      path: "src/lib.ts",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("BROKEN_IMPORT");
    expect(r.error).toMatch(/main\.ts/);
  });
});

describe("move_file", () => {
  it("moves a file and rewrites importers' specifiers", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/lib.ts");
    addFile(rpg, "src/main.ts", {
      rawImports: [{ name: "x", source: "./lib.js", isDefault: false }],
    });
    const r = applyOperation(rpg, {
      kind: "move_file",
      fromPath: "src/lib.ts",
      toPath: "src/lib/index.ts",
    });
    expect(r.ok, r.error).toBe(true);
    expect(rpg.nodes["file:src/lib.ts"]).toBeUndefined();
    expect(rpg.nodes["file:src/lib/index.ts"]).toBeDefined();
    const main = rpg.nodes["file:src/main.ts"] as FileNode;
    // The specifier collapses to the directory form (`./lib`) when the
    // target is an `index` file — see `relativeImportSpecifier`.
    expect(main.rawImports[0]!.source).toBe("./lib");
  });

  it("idempotent when the destination equals the source", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/x.ts");
    const r = applyOperation(rpg, {
      kind: "move_file",
      fromPath: "src/x.ts",
      toPath: "src/x.ts",
    });
    expect(r.ok).toBe(true);
    expect(rpg.nodes["file:src/x.ts"]).toBeDefined();
  });

  it("refuses to overwrite an existing file", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/a.ts");
    addFile(rpg, "src/b.ts");
    const r = applyOperation(rpg, {
      kind: "move_file",
      fromPath: "src/a.ts",
      toPath: "src/b.ts",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("FILE_EXISTS");
  });
});

describe("split_file", () => {
  it("partitions plan entries across destinations and remaps capabilities", () => {
    const rpg = makeRpg();
    const f = addFile(rpg, "src/big.ts");
    f.interfacePlan = {
      entries: [
        {
          leafCapabilityId: "cap:a",
          kind: "function",
          name: "alpha",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
        {
          leafCapabilityId: "cap:b",
          kind: "function",
          name: "beta",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
      ],
      classes: [],
    };
    rpg.nodes["cap:a"] = capability("cap:a", "Alpha", "file:src/big.ts");
    rpg.nodes["cap:b"] = capability("cap:b", "Beta", "file:src/big.ts");

    const r = applyOperation(rpg, {
      kind: "split_file",
      fromPath: "src/big.ts",
      into: [
        { path: "src/alpha.ts", leafCapabilityIds: ["cap:a"] },
        { path: "src/beta.ts", leafCapabilityIds: ["cap:b"] },
      ],
    });
    expect(r.ok, r.error).toBe(true);

    const alpha = rpg.nodes["file:src/alpha.ts"] as FileNode;
    expect(alpha.interfacePlan!.entries[0]!.name).toBe("alpha");
    const beta = rpg.nodes["file:src/beta.ts"] as FileNode;
    expect(beta.interfacePlan!.entries[0]!.name).toBe("beta");
    const big = rpg.nodes["file:src/big.ts"] as FileNode;
    expect(big.interfacePlan!.entries).toHaveLength(0);

    const capA = rpg.nodes["cap:a"];
    if (!capA || !isCapability(capA)) throw new Error("kind drift");
    expect(capA.mappedToId).toBe("file:src/alpha.ts");
  });

  it("rejects overlapping partitions", () => {
    const rpg = makeRpg();
    const f = addFile(rpg, "src/big.ts");
    f.interfacePlan = { entries: [], classes: [] };
    const r = applyOperation(rpg, {
      kind: "split_file",
      fromPath: "src/big.ts",
      into: [
        { path: "src/a.ts", leafCapabilityIds: ["cap:x"] },
        { path: "src/b.ts", leafCapabilityIds: ["cap:x"] },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("OVERLAPPING_PARTITION");
  });
});

describe("merge_files", () => {
  it("concatenates plans, removes sources, redirects imports", () => {
    const rpg = makeRpg();
    const a = addFile(rpg, "src/a.ts");
    a.interfacePlan = {
      entries: [
        {
          leafCapabilityId: "cap:a",
          kind: "function",
          name: "alpha",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
      ],
      classes: [],
    };
    const b = addFile(rpg, "src/b.ts");
    b.interfacePlan = {
      entries: [
        {
          leafCapabilityId: "cap:b",
          kind: "function",
          name: "beta",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
      ],
      classes: [],
    };
    rpg.nodes["cap:a"] = capability("cap:a", "A", "file:src/a.ts");
    rpg.nodes["cap:b"] = capability("cap:b", "B", "file:src/b.ts");
    addFile(rpg, "src/main.ts", {
      rawImports: [{ name: "alpha", source: "./a.js", isDefault: false }],
    });

    const r = applyOperation(rpg, {
      kind: "merge_files",
      fromPaths: ["src/a.ts", "src/b.ts"],
      toPath: "src/lib.ts",
    });
    expect(r.ok, r.error).toBe(true);

    expect(rpg.nodes["file:src/a.ts"]).toBeUndefined();
    expect(rpg.nodes["file:src/b.ts"]).toBeUndefined();
    const lib = rpg.nodes["file:src/lib.ts"] as FileNode;
    expect(lib.interfacePlan!.entries.map((e) => e.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    const main = rpg.nodes["file:src/main.ts"] as FileNode;
    expect(main.rawImports[0]!.source).toBe("./lib");
  });
});

describe("extract_base_class", () => {
  it("creates a base file, links extenders, adds imports", () => {
    const rpg = makeRpg();
    const a = addFile(rpg, "src/a.ts");
    a.interfacePlan = {
      entries: [],
      classes: [
        {
          name: "Alpha",
          description: "x",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
    };
    const b = addFile(rpg, "src/b.ts");
    b.interfacePlan = {
      entries: [],
      classes: [
        {
          name: "Beta",
          description: "x",
          extendsName: null,
          extendsFromFile: null,
          exported: true,
        },
      ],
    };

    const r = applyOperation(rpg, {
      kind: "extract_base_class",
      toFile: "src/base.ts",
      baseClassName: "Base",
      baseDescription: "shared base",
      methods: [],
      rewriteExtenders: [
        { filePath: "src/a.ts", className: "Alpha" },
        { filePath: "src/b.ts", className: "Beta" },
      ],
    });
    expect(r.ok, r.error).toBe(true);

    const base = rpg.nodes["file:src/base.ts"] as FileNode;
    expect(base.interfacePlan!.classes[0]!.name).toBe("Base");

    const aFile = rpg.nodes["file:src/a.ts"] as FileNode;
    const alphaPlan = aFile.interfacePlan!.classes[0]!;
    expect(alphaPlan.extendsName).toBe("Base");
    expect(alphaPlan.extendsFromFile).toBe("src/base.ts");
    expect(aFile.rawImports.some((i) => i.name === "Base")).toBe(true);
  });

  it("refuses to rewrite a class that doesn't exist", () => {
    const rpg = makeRpg();
    const r = applyOperation(rpg, {
      kind: "extract_base_class",
      toFile: "src/base.ts",
      baseClassName: "Base",
      baseDescription: "x",
      methods: [],
      rewriteExtenders: [{ filePath: "src/missing.ts", className: "Ghost" }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("FILE_NOT_FOUND");
  });
});

describe("extract_utility", () => {
  it("moves a function and redirects sibling imports", () => {
    const rpg = makeRpg();
    const a = addFile(rpg, "src/a.ts");
    a.interfacePlan = {
      entries: [
        {
          leafCapabilityId: "cap:helper",
          kind: "function",
          name: "helper",
          ownerClassName: null,
          signature: { params: [], returnType: "void", isAsync: false },
          description: "",
          exported: true,
          isStatic: false,
        },
      ],
      classes: [],
    };
    rpg.nodes["cap:helper"] = capability(
      "cap:helper",
      "Helper",
      "file:src/a.ts",
    );
    addFile(rpg, "src/b.ts", {
      rawImports: [{ name: "helper", source: "./a.js", isDefault: false }],
    });
    addFile(rpg, "src/c.ts", {
      rawImports: [{ name: "helper", source: "./a.js", isDefault: false }],
    });

    const r = applyOperation(rpg, {
      kind: "extract_utility",
      toFile: "src/util.ts",
      members: [
        {
          fromFile: "src/a.ts",
          functionName: "helper",
          leafCapabilityId: "cap:helper",
        },
      ],
    });
    expect(r.ok, r.error).toBe(true);

    const util = rpg.nodes["file:src/util.ts"] as FileNode;
    expect(util.interfacePlan!.entries[0]!.name).toBe("helper");
    const aFile = rpg.nodes["file:src/a.ts"] as FileNode;
    expect(aFile.interfacePlan!.entries).toHaveLength(0);

    const bFile = rpg.nodes["file:src/b.ts"] as FileNode;
    expect(bFile.rawImports[0]!.source).toBe("./util");
    const cFile = rpg.nodes["file:src/c.ts"] as FileNode;
    expect(cFile.rawImports[0]!.source).toBe("./util");

    const cap = rpg.nodes["cap:helper"];
    if (!cap || !isCapability(cap)) throw new Error("kind drift");
    expect(cap.mappedToId).toBe("file:src/util.ts");
  });
});

describe("set_interface_plan / set_data_flow", () => {
  it("set_interface_plan replaces the file's plan", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/x.ts");
    const r = applyOperation(rpg, {
      kind: "set_interface_plan",
      filePath: "src/x.ts",
      plan: { entries: [], classes: [] },
    });
    expect(r.ok).toBe(true);
    const f = rpg.nodes["file:src/x.ts"] as FileNode;
    expect(f.interfacePlan).toEqual({ entries: [], classes: [] });
  });

  it("set_data_flow replaces an edge for the same (from, to) pair", () => {
    const rpg = makeRpg();
    rpg.dataFlow.push({ fromNode: "a", toNode: "b", payload: "old" });
    rpg.dataFlow.push({ fromNode: "c", toNode: "d", payload: "untouched" });
    const r = applyOperation(rpg, {
      kind: "set_data_flow",
      edge: { fromNode: "a", toNode: "b", payload: "new" },
    });
    expect(r.ok).toBe(true);
    expect(rpg.dataFlow).toHaveLength(2);
    const ab = rpg.dataFlow.find((e) => e.fromNode === "a")!;
    expect(ab.payload).toBe("new");
  });
});

describe("applyOperations (batch)", () => {
  it("aggregates side-effects when every op succeeds", () => {
    const rpg = makeRpg();
    const ops: RPGOperation[] = [
      { kind: "create_folder", path: "src" },
      { kind: "create_file", path: "src/a.ts" },
      { kind: "create_file", path: "src/b.ts" },
    ];
    const r = applyOperations(rpg, ops);
    expect(r.ok).toBe(true);
    expect(r.filesAdded).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stops at the first failure and returns the report", () => {
    const rpg = makeRpg();
    addFile(rpg, "src/used.ts");
    addFile(rpg, "src/main.ts", {
      rawImports: [{ name: "x", source: "./used.js", isDefault: false }],
    });
    const ops: RPGOperation[] = [
      { kind: "create_file", path: "src/new.ts" },
      { kind: "delete_file", path: "src/used.ts" },
      { kind: "create_file", path: "src/never.ts" },
    ];
    const r = applyOperations(rpg, ops);
    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.results[0]!.ok).toBe(true);
    expect(r.results[1]!.ok).toBe(false);
    expect(rpg.nodes["file:src/never.ts"]).toBeUndefined();
  });
});

function capability(id: string, name: string, mappedToId: string | null): any {
  return {
    id,
    kind: "capability",
    name,
    parent: null,
    children: [],
    features: [],
    description: "",
    isLeaf: true,
    status: "mapped",
    mappedToId,
  };
}
