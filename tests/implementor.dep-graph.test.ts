/**
 * Step Q4-B: dependency graph from test imports.
 *
 * Parses each leaf's test source for cross-file imports and
 * resolves them to other leaves. The scheduler in Q4-C uses this
 * to gate dispatch on dependencies — a leaf doesn't run until
 * the leaves whose symbols it imports have all landed.
 *
 * Without this, integration-style leaves (whose tests pull in
 * many sibling-leaf surfaces) get scheduled before their deps
 * land, hit stubs, and fail.
 */

import { describe, it, expect } from "vitest";
import { buildLeafDependencyGraph } from "../src/implementor/dep-graph.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";

function mkFile(opts: {
  id: string;
  path: string;
  interfacePlan?: FileNode["interfacePlan"];
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

function leafEntry(name: string, capId: string): FileNode["interfacePlan"] {
  return {
    entries: [
      {
        leafCapabilityId: capId,
        kind: "function",
        name,
        ownerClassName: null,
        description: "",
        signature: { params: [], returnType: "void", isAsync: false },
        exported: true,
        isStatic: false,
      },
    ],
    classes: [],
  };
}

describe("buildLeafDependencyGraph", () => {
  it("returns an empty deps set for a leaf whose test imports nothing project-internal", () => {
    const f = mkFile({
      id: "file:add",
      path: "src/add.ts",
      interfacePlan: leafEntry("add", "cap:add"),
    });
    const rpg = rpgWithFiles([f]);
    const tests = new Map([
      [
        "cap:add",
        `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";
describe("add", () => { it("ok", () => { expect(add(2,3)).toBe(5); }); });
`,
      ],
    ]);
    const graph = buildLeafDependencyGraph(rpg, tests);
    expect(graph.get("cap:add")).toEqual(new Set()); // self-import is not a dep
  });

  it("captures cross-file leaf dependencies via test imports", () => {
    // Leaf A's test imports from leaf B's file → A depends on B.
    const a = mkFile({
      id: "file:a",
      path: "src/a.ts",
      interfacePlan: leafEntry("a", "cap:a"),
    });
    const b = mkFile({
      id: "file:b",
      path: "src/b.ts",
      interfacePlan: leafEntry("b", "cap:b"),
    });
    const rpg = rpgWithFiles([a, b]);
    const tests = new Map([
      [
        "cap:a",
        `import { describe, it, expect } from "vitest";
import { a } from "../../src/a.js";
import { b } from "../../src/b.js";
describe("a", () => { it("uses b", () => { a(); b(); }); });
`,
      ],
      [
        "cap:b",
        `import { describe, it, expect } from "vitest";
import { b } from "../../src/b.js";
describe("b", () => { it("ok", () => { b(); }); });
`,
      ],
    ]);
    const graph = buildLeafDependencyGraph(rpg, tests);
    expect(graph.get("cap:a")).toEqual(new Set(["cap:b"]));
    expect(graph.get("cap:b")).toEqual(new Set());
  });

  it("ignores imports of symbols that aren't planned leaves", () => {
    const a = mkFile({
      id: "file:a",
      path: "src/a.ts",
      interfacePlan: leafEntry("a", "cap:a"),
    });
    const rpg = rpgWithFiles([a]);
    const tests = new Map([
      [
        "cap:a",
        `import { describe, it, expect } from "vitest";
import { a } from "../../src/a.js";
import { somethingNotPlanned } from "../../src/missing.js";
describe("a", () => { it("ok", () => { a(); }); });
`,
      ],
    ]);
    const graph = buildLeafDependencyGraph(rpg, tests);
    expect(graph.get("cap:a")).toEqual(new Set());
  });

  it("captures multiple deps from a single test (integration-style leaf)", () => {
    // The "integration leaf" pattern: leaf X's test exercises
    // leaves A, B, C — X depends on all three.
    const a = mkFile({ id: "file:a", path: "src/a.ts", interfacePlan: leafEntry("a", "cap:a") });
    const b = mkFile({ id: "file:b", path: "src/b.ts", interfacePlan: leafEntry("b", "cap:b") });
    const c = mkFile({ id: "file:c", path: "src/c.ts", interfacePlan: leafEntry("c", "cap:c") });
    const x = mkFile({ id: "file:x", path: "src/x.ts", interfacePlan: leafEntry("runIntegration", "cap:x") });
    const rpg = rpgWithFiles([a, b, c, x]);
    const tests = new Map([
      [
        "cap:x",
        `import { describe, it, expect } from "vitest";
import { runIntegration } from "../../src/x.js";
import { a } from "../../src/a.js";
import { b } from "../../src/b.js";
import { c } from "../../src/c.js";
describe("runIntegration", () => { it("orchestrates", () => { runIntegration(); a(); b(); c(); }); });
`,
      ],
    ]);
    const graph = buildLeafDependencyGraph(rpg, tests);
    expect(graph.get("cap:x")).toEqual(new Set(["cap:a", "cap:b", "cap:c"]));
  });

  it("captures method-leaf dependencies (imports of class names)", () => {
    // A class with a planned method. Another leaf's test imports
    // the class and calls the method.
    const errors = mkFile({
      id: "file:errors",
      path: "src/errors.ts",
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:err.constructor",
            kind: "method",
            name: "constructor",
            ownerClassName: "TodoError",
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: false,
            isStatic: false,
          },
        ],
        classes: [
          {
            name: "TodoError",
            description: "",
            extendsName: null,
            extendsFromFile: null,
            exported: true,
          },
        ],
      },
    });
    const v = mkFile({
      id: "file:val",
      path: "src/val.ts",
      interfacePlan: leafEntry("validate", "cap:validate"),
    });
    const rpg = rpgWithFiles([errors, v]);
    const tests = new Map([
      [
        "cap:validate",
        `import { describe, it, expect } from "vitest";
import { validate } from "../../src/val.js";
import { TodoError } from "../../src/errors.js";
describe("validate", () => { it("throws", () => { expect(() => validate("")).toThrow(TodoError); }); });
`,
      ],
    ]);
    const graph = buildLeafDependencyGraph(rpg, tests);
    // The class's constructor leaf should be a dep, since
    // import {TodoError} resolves to the class symbol.
    expect(graph.get("cap:validate")).toEqual(new Set(["cap:err.constructor"]));
  });

  it("returns an empty map when no tests are provided", () => {
    const rpg = rpgWithFiles([
      mkFile({ id: "file:a", path: "src/a.ts", interfacePlan: leafEntry("a", "cap:a") }),
    ]);
    const graph = buildLeafDependencyGraph(rpg, new Map());
    // Every planned leaf gets an entry, but with an empty set —
    // makes the scheduler's any-dep check trivial when there are
    // no tests yet.
    expect(graph.get("cap:a")).toEqual(new Set());
  });
});
