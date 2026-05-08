/**
 * Phase 1 acceptance: load → materialize → load yields a structurally
 * identical RPG.
 *
 * "Structurally identical" means: same set of folder/file paths, same
 * named functions/classes/methods per file, same import edges
 * (resolved or unresolved), same inheritance edges. Node ids and
 * raw byte ranges are not compared because they're keyed by path,
 * which round-trips unchanged.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRepo, materializeRPG, isFile } from "../src/rpg/index.js";
import type { RPG, RPGNode } from "../src/rpg/index.js";

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/sample-repo",
);

interface Snapshot {
  folders: string[];
  files: Array<{
    path: string;
    contentHash: string;
    classes: string[];
    functions: string[];
    methodsByClass: Record<string, string[]>;
    rawImports: string[];
    exports: string[];
  }>;
  importEdges: string[];
  inheritEdges: string[];
}

function hash(s: string): string {
  // Cheap stable hash — content equality between runs is what matters,
  // not cryptographic strength.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

function snapshot(rpg: RPG): Snapshot {
  const folders: string[] = [];
  const files: Snapshot["files"] = [];

  const classNamesById = new Map<string, string>();

  for (const node of Object.values(rpg.nodes) as RPGNode[]) {
    if (node.kind === "folder" && node.path !== "") {
      folders.push(node.path);
    }
    if (node.kind === "class") {
      classNamesById.set(node.id, node.name);
    }
  }
  folders.sort();

  for (const node of Object.values(rpg.nodes) as RPGNode[]) {
    if (!isFile(node)) continue;
    const classes: string[] = [];
    const functions: string[] = [];
    const methodsByClass: Record<string, string[]> = {};
    for (const childId of node.children) {
      const child = rpg.nodes[childId];
      if (!child) continue;
      if (child.kind === "class") {
        classes.push(child.name);
        methodsByClass[child.name] = [];
        for (const methodId of child.children) {
          const method = rpg.nodes[methodId];
          if (method?.kind === "method") {
            methodsByClass[child.name]!.push(method.name);
          }
        }
        methodsByClass[child.name]!.sort();
      } else if (child.kind === "function") {
        functions.push(child.name);
      }
    }
    classes.sort();
    functions.sort();
    files.push({
      path: node.path,
      contentHash: hash(node.content),
      classes,
      functions,
      methodsByClass,
      rawImports: node.rawImports
        .map((i) => `${i.source}:${i.name}:${i.isDefault}`)
        .sort(),
      exports: [...node.exports].sort(),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const importEdges = rpg.imports
    .map(
      (e) =>
        `${e.fromFile} -> ${e.toFile ?? "<external>"}; ${e.source}; ${e.name}`,
    )
    .sort();
  const inheritEdges = rpg.inherits
    .map((e) => `${e.fromClass} -> ${e.toClass ?? "<unresolved>"}; ${e.baseName}`)
    .sort();

  return { folders, files, importEdges, inheritEdges };
}

describe("RPG round-trip", () => {
  it("load → materialize → load yields structurally identical RPG", async () => {
    const original = await loadRepo(FIXTURE);
    const tmp = await mkdtemp(path.join(tmpdir(), "rpg-roundtrip-"));
    try {
      await materializeRPG(original, tmp);
      const reloaded = await loadRepo(tmp);
      expect(snapshot(reloaded)).toEqual(snapshot(original));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("captures class methods, exported functions, and import edges", async () => {
    const rpg = await loadRepo(FIXTURE);
    const snap = snapshot(rpg);

    const dbFile = snap.files.find((f) => f.path.endsWith("db.ts"));
    expect(dbFile).toBeDefined();
    expect(dbFile!.classes).toContain("GuestbookDb");
    expect(dbFile!.methodsByClass["GuestbookDb"]).toEqual([
      "constructor",
      "load",
      "save",
    ]);

    const serverFile = snap.files.find((f) => f.path.endsWith("server.ts"));
    expect(serverFile).toBeDefined();
    expect(serverFile!.functions.sort()).toEqual([
      "formatEntry",
      "internalHelper",
      "startServer",
    ]);
    expect(serverFile!.exports.sort()).toEqual(["formatEntry", "startServer"]);

    const utilFile = snap.files.find((f) => f.path.endsWith("util.ts"));
    expect(utilFile).toBeDefined();
    expect(utilFile!.functions.sort()).toEqual(["clamp", "slugify"]);

    // server.ts imports from ./db.js — should resolve to db.ts in-repo.
    const serverImports = snap.importEdges.filter((s) =>
      s.includes("server.ts"),
    );
    expect(serverImports.some((s) => s.includes("db.ts"))).toBe(true);
    // node:path is external — appears as <external>.
    const dbImports = snap.importEdges.filter((s) => s.includes("db.ts ->"));
    expect(dbImports.some((s) => s.includes("<external>"))).toBe(true);
  });
});
