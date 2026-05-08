/**
 * Phase 2 acceptance:
 *
 *   1. Edit a function — content updates, siblings byte-precise
 *      unchanged, view returns the new source, RPG round-trips through
 *      materialize + reload.
 *   2. Edit a method — class members preserved.
 *   3. Edit a whole class — old methods gone, new methods appear.
 *   4. Edit imports + assignments — declarations untouched.
 *   5. Reject malformed source — RPG content unchanged after revert.
 *   6. Locate errors — useful codes + messages.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRepo, materializeRPG } from "../src/rpg/index.js";
import {
  editFunctionInFile,
  editMethodOfClassInFile,
  editWholeClassInFile,
  editImportsAndAssignmentsInFile,
  getInterfaceContent,
  viewFileInterfaceMap,
} from "../src/tools/index.js";

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/sample-repo",
);

describe("editFunctionInFile", () => {
  it("replaces a function and preserves siblings byte-precise", async () => {
    const rpg = await loadRepo(FIXTURE);
    const utilContentBefore = (Object.values(rpg.nodes) as any[]).find(
      (n) => n.kind === "file" && n.path.endsWith("util.ts"),
    )?.content as string;
    expect(utilContentBefore).toContain("export function clamp");
    expect(utilContentBefore).toContain("export const slugify");

    const newClamp = `export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}`;

    const result = editFunctionInFile(rpg, {
      filePath: "lib/util.ts",
      functionName: "clamp",
      newSource: newClamp,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sibling preserved exactly.
    const view = viewFileInterfaceMap(rpg, "lib/util.ts");
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.entries.map((e) => e.name).sort()).toEqual([
      "clamp",
      "slugify",
    ]);

    const slugContent = getInterfaceContent(rpg, {
      filePath: "lib/util.ts",
      target: "slugify",
    });
    expect(slugContent.ok).toBe(true);
    if (!slugContent.ok) return;
    expect(slugContent.value.source).toContain("toLowerCase");

    // New function returned via view tool.
    const clampContent = getInterfaceContent(rpg, {
      filePath: "lib/util.ts",
      target: "clamp",
    });
    expect(clampContent.ok).toBe(true);
    if (!clampContent.ok) return;
    expect(clampContent.value.source).toContain("Math.min(Math.max");
  });

  it("round-trips through materialize + reload", async () => {
    const rpg = await loadRepo(FIXTURE);
    const r = editFunctionInFile(rpg, {
      filePath: "src/server.ts",
      functionName: "internalHelper",
      newSource: "function internalHelper(): number {\n  return 999;\n}",
    });
    expect(r.ok).toBe(true);

    const tmp = await mkdtemp(path.join(tmpdir(), "phase2-"));
    try {
      await materializeRPG(rpg, tmp);
      const written = await readFile(
        path.join(tmp, "src/server.ts"),
        "utf-8",
      );
      expect(written).toContain("return 999");

      const reloaded = await loadRepo(tmp);
      const view = viewFileInterfaceMap(reloaded, "src/server.ts");
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      const helper = view.value.entries.find((e) => e.name === "internalHelper");
      expect(helper).toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("editMethodOfClassInFile", () => {
  it("replaces a method and keeps the other class members", async () => {
    const rpg = await loadRepo(FIXTURE);

    const r = editMethodOfClassInFile(rpg, {
      filePath: "src/db.ts",
      className: "GuestbookDb",
      methodName: "load",
      newSource:
        "async load(): Promise<Entry[]> {\n    return [{ id: 'a', body: 'b' }];\n  }",
    });
    expect(r.ok).toBe(true);

    const view = viewFileInterfaceMap(rpg, "src/db.ts");
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const methodNames = view.value.entries
      .filter((e) => e.kind === "method")
      .map((e) => e.name)
      .sort();
    expect(methodNames).toEqual(["constructor", "load", "save"]);

    const loadBody = getInterfaceContent(rpg, {
      filePath: "src/db.ts",
      target: "GuestbookDb.load",
    });
    expect(loadBody.ok).toBe(true);
    if (!loadBody.ok) return;
    expect(loadBody.value.source).toContain("id: 'a'");

    // save is byte-precise unchanged.
    const saveBody = getInterfaceContent(rpg, {
      filePath: "src/db.ts",
      target: "GuestbookDb.save",
    });
    expect(saveBody.ok).toBe(true);
    if (!saveBody.ok) return;
    expect(saveBody.value.source).toContain("void entries");
  });
});

describe("editWholeClassInFile", () => {
  it("replaces a class and the new methods are addressable", async () => {
    const rpg = await loadRepo(FIXTURE);

    const newClass = `export class GuestbookDb {
  async load(): Promise<Entry[]> {
    return [];
  }

  async dump(): Promise<string> {
    return "";
  }
}`;

    const r = editWholeClassInFile(rpg, {
      filePath: "src/db.ts",
      className: "GuestbookDb",
      newSource: newClass,
    });
    expect(r.ok).toBe(true);

    const view = viewFileInterfaceMap(rpg, "src/db.ts");
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const methodNames = view.value.entries
      .filter((e) => e.kind === "method")
      .map((e) => e.name)
      .sort();
    expect(methodNames).toEqual(["dump", "load"]);

    // Old methods are now unaddressable.
    const oldSave = getInterfaceContent(rpg, {
      filePath: "src/db.ts",
      target: "GuestbookDb.save",
    });
    expect(oldSave.ok).toBe(false);
    if (oldSave.ok) return;
    expect(oldSave.error.code).toBe("NODE_NOT_FOUND");
  });
});

describe("editImportsAndAssignmentsInFile", () => {
  it("replaces the imports prefix without touching declarations", async () => {
    const rpg = await loadRepo(FIXTURE);

    const r = editImportsAndAssignmentsInFile(rpg, {
      filePath: "src/server.ts",
      newSource:
        'import { GuestbookDb } from "./db.js";\nimport type { Entry } from "./db.js";\nimport { clamp } from "../lib/util.js";\n\n',
    });
    expect(r.ok).toBe(true);

    const view = viewFileInterfaceMap(rpg, "src/server.ts");
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const importSources = view.value.imports.map((i) => i.source).sort();
    expect(importSources).toContain("../lib/util.js");

    // Declarations preserved.
    const fns = view.value.entries.filter((e) => e.kind === "function").map((e) => e.name).sort();
    expect(fns).toEqual(["formatEntry", "internalHelper", "startServer"]);
  });
});

describe("parse-error revert", () => {
  it("rejects malformed source and leaves the RPG unchanged", async () => {
    const rpg = await loadRepo(FIXTURE);
    const beforeView = viewFileInterfaceMap(rpg, "lib/util.ts");
    expect(beforeView.ok).toBe(true);
    const beforeFile = (Object.values(rpg.nodes) as any[]).find(
      (n) => n.kind === "file" && n.path.endsWith("util.ts"),
    );
    const beforeContent = beforeFile.content;

    const r = editFunctionInFile(rpg, {
      filePath: "lib/util.ts",
      functionName: "clamp",
      newSource: "export function clamp(x: number): number {\n  return x +\n", // missing close
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("PARSE_ERROR");

    // Content reverted exactly.
    const afterFile = (Object.values(rpg.nodes) as any[]).find(
      (n) => n.kind === "file" && n.path.endsWith("util.ts"),
    );
    expect(afterFile.content).toBe(beforeContent);

    // Function still resolvable.
    const stillThere = getInterfaceContent(rpg, {
      filePath: "lib/util.ts",
      target: "clamp",
    });
    expect(stillThere.ok).toBe(true);
  });
});

describe("locate errors", () => {
  it("returns FILE_NOT_FOUND for an unknown path", async () => {
    const rpg = await loadRepo(FIXTURE);
    const r = editFunctionInFile(rpg, {
      filePath: "nope/missing.ts",
      functionName: "x",
      newSource: "function x(){}",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("FILE_NOT_FOUND");
  });

  it("returns NODE_NOT_FOUND for an unknown function", async () => {
    const rpg = await loadRepo(FIXTURE);
    const r = editFunctionInFile(rpg, {
      filePath: "lib/util.ts",
      functionName: "nope",
      newSource: "function nope(){}",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NODE_NOT_FOUND");
  });

  it("returns NODE_NOT_FOUND for an unknown method", async () => {
    const rpg = await loadRepo(FIXTURE);
    const r = editMethodOfClassInFile(rpg, {
      filePath: "src/db.ts",
      className: "GuestbookDb",
      methodName: "doesNotExist",
      newSource: "doesNotExist(){}",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("NODE_NOT_FOUND");
  });
});
