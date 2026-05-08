/**
 * Phase 2 review-fix acceptance:
 *
 *   #1  AMBIGUOUS_NAME propagates through getInterfaceContent rather
 *       than being silently swallowed by the function→class fall-through.
 *   #10 EditApplied.added / removed list the node ids that actually
 *       moved, so callers can drive cache invalidation.
 *   #11 rpg.imports re-resolves at the cross-file edge level after
 *       editImportsAndAssignmentsInFile, not just FileNode.rawImports.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRepo } from "../src/rpg/index.js";
import {
  editFunctionInFile,
  editImportsAndAssignmentsInFile,
  getInterfaceContent,
} from "../src/tools/index.js";

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/sample-repo",
);

describe("review fix #1 — AMBIGUOUS_NAME propagation", () => {
  it("getInterfaceContent surfaces ambiguity instead of NODE_NOT_FOUND", async () => {
    // Build a repo where the same function name appears twice in one file.
    // This is unusual but possible — a malformed edit can produce it, and
    // the user should be told which lines collide rather than be told the
    // function doesn't exist.
    const tmp = await mkdtemp(path.join(tmpdir(), "ambig-"));
    try {
      await writeFile(
        path.join(tmp, "dup.ts"),
        "export function twice(): number { return 1; }\n" +
          "export function twice(): number { return 2; }\n",
      );
      const rpg = await loadRepo(tmp);
      const result = getInterfaceContent(rpg, {
        filePath: "dup.ts",
        target: "twice",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("AMBIGUOUS_NAME");
      expect(result.error.message).toMatch(/lines? \d+/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("review fix #10 — EditApplied node ids", () => {
  it("reports added and removed node ids on a function edit", async () => {
    const rpg = await loadRepo(FIXTURE);
    const result = editFunctionInFile(rpg, {
      filePath: "lib/util.ts",
      functionName: "clamp",
      newSource: `export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Set-difference contract: ids that survive the edit unchanged
    // (same name, same kind, same start line) appear in neither list.
    // Here `clamp` keeps its line and id; `slugify` shifts because the
    // shorter new clamp moves it up — so we expect the slugify id to
    // appear once in `removed` and once (different line) in `added`.
    const removed = new Set(result.value.removed);
    const added = new Set(result.value.added);

    // Disjoint: no id can be both removed and added.
    for (const id of removed) {
      expect(added.has(id), `id ${id} in both lists`).toBe(false);
    }

    // Every added id resolves to a live node in the RPG.
    for (const id of added) {
      expect(rpg.nodes[id], `added id ${id} not in node map`).toBeDefined();
    }
    // Every removed id is gone from the RPG.
    for (const id of removed) {
      expect(rpg.nodes[id], `removed id ${id} still in node map`).toBeUndefined();
    }

    // Something must have moved (line numbers shifted), so neither list
    // can be empty for this particular edit.
    expect(removed.size).toBeGreaterThan(0);
    expect(added.size).toBeGreaterThan(0);

    // The slugify id moved between line-tagged buckets; both ids should
    // mention slugify by name in the encoded id.
    expect([...removed].some((id) => id.includes("#slugify@"))).toBe(true);
    expect([...added].some((id) => id.includes("#slugify@"))).toBe(true);
  });
});

describe("review fix #11 — global imports re-resolve after edit", () => {
  it("editImportsAndAssignmentsInFile updates rpg.imports edges", async () => {
    const rpg = await loadRepo(FIXTURE);

    // Pre-edit: server.ts imports from "./db.js" and that resolves.
    const before = rpg.imports
      .filter((e) => e.fromFile.endsWith("server.ts"))
      .map((e) => `${e.source}:${e.toFile ?? "<ext>"}`);
    expect(before.some((s) => s.startsWith("./db.js:"))).toBe(true);
    // No edge for util.js yet.
    expect(before.some((s) => s.startsWith("../lib/util.js:"))).toBe(false);

    const r = editImportsAndAssignmentsInFile(rpg, {
      filePath: "src/server.ts",
      newSource:
        'import { GuestbookDb } from "./db.js";\nimport type { Entry } from "./db.js";\nimport { clamp } from "../lib/util.js";\n\n',
    });
    expect(r.ok).toBe(true);

    const after = rpg.imports
      .filter((e) => e.fromFile.endsWith("server.ts"))
      .map((e) => `${e.source}:${e.toFile ?? "<ext>"}`);
    // New edge appears, resolved to the actual util.ts file id.
    const utilEdge = after.find((s) => s.startsWith("../lib/util.js:"));
    expect(utilEdge).toBeDefined();
    expect(utilEdge!.endsWith(":<ext>")).toBe(false); // was resolved to in-repo file
    // Existing edges still present.
    expect(after.some((s) => s.startsWith("./db.js:"))).toBe(true);
  });
});
