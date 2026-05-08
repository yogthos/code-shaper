/**
 * Sandbox guard acceptance.
 *
 *   - `safeResolve` accepts relative paths inside the root.
 *   - `safeResolve` rejects `..` segments, absolute paths, and
 *     same-prefix sibling directories.
 *   - `materializeRPG` refuses to write a file whose RPG path tries
 *     to escape the supplied outDir, even when the path validators at
 *     architect-time were bypassed.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  emptyRPG,
  materializeRPG,
  PathEscapeError,
  safeResolve,
  type FileNode,
  type FolderNode,
} from "../src/rpg/index.js";

describe("safeResolve", () => {
  it("accepts a relative path inside the root", () => {
    const root = "/abs/project";
    expect(safeResolve(root, "src/foo.ts")).toBe("/abs/project/src/foo.ts");
  });

  it("accepts the root itself (empty rel)", () => {
    expect(safeResolve("/abs/project", ".")).toBe("/abs/project");
  });

  it("rejects ../ traversal", () => {
    expect(() => safeResolve("/abs/project", "../escape.ts")).toThrow(
      PathEscapeError,
    );
  });

  it("rejects an absolute path that escapes", () => {
    expect(() => safeResolve("/abs/project", "/etc/passwd")).toThrow(
      PathEscapeError,
    );
  });

  it("accepts an absolute path that descends from root", () => {
    expect(safeResolve("/abs/project", "/abs/project/src/foo.ts")).toBe(
      "/abs/project/src/foo.ts",
    );
  });

  it("rejects a same-prefix sibling directory", () => {
    // /abs/projectile is NOT inside /abs/project even though its
    // string starts with the root.
    expect(() => safeResolve("/abs/project", "../projectile/x.ts")).toThrow(
      PathEscapeError,
    );
  });

  it("error includes the offending path and resolved root", () => {
    try {
      safeResolve("/abs/project", "../escape.ts");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PathEscapeError);
      const err = e as PathEscapeError;
      expect(err.attemptedPath).toBe("../escape.ts");
      expect(err.projectRoot).toBe("/abs/project");
    }
  });
});

describe("materializeRPG — sandbox guard", () => {
  it("refuses to write a file whose path would escape outDir", async () => {
    const rpg = emptyRPG();
    const root = rpg.nodes[rpg.rootId] as FolderNode;
    // Inject a malicious FileNode with a `..` path that would escape.
    // (Architect-side validators reject such paths, but we want
    // defense in depth in case future code emits one.)
    const malicious: FileNode = {
      id: "file:../escape.ts",
      kind: "file",
      name: "escape.ts",
      parent: rpg.rootId,
      children: [],
      features: [],
      path: "../escape.ts",
      content: "/* malicious */",
      language: "typescript",
      rawImports: [],
      exports: [],
    };
    rpg.nodes[malicious.id] = malicious;
    root.children.push(malicious.id);

    const outDir = await mkdtemp(path.join(tmpdir(), "sandbox-"));
    try {
      await expect(materializeRPG(rpg, outDir)).rejects.toBeInstanceOf(
        PathEscapeError,
      );
      // Confirm nothing was written outside outDir — i.e. the parent
      // of outDir does NOT contain escape.ts.
      const escapePath = path.join(path.dirname(outDir), "escape.ts");
      await expect(stat(escapePath)).rejects.toThrow();
      void readFile;
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
