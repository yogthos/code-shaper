/**
 * Project-context digest: stack/scripts/deps from package.json,
 * layout from RPG folders, planned exports per file, and
 * accumulated learnedFacts. Each leaf gets this prepended to its
 * dev-loop user prompt so it doesn't have to re-discover the
 * project shape via list_files / read_file round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildProjectContext,
  extractLessonFromTrail,
} from "../src/implementor/project-context.js";
import { emptyRPG } from "../src/rpg/index.js";
import type { FileNode, FolderNode } from "../src/rpg/types.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "proj-ctx-"));
});
afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("buildProjectContext", () => {
  it("renders stack, layout, and planned exports from package.json + RPG", async () => {
    await writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify({
        name: "p",
        type: "module",
        scripts: { test: "vitest run", build: "tsc" },
        dependencies: { express: "^4.19.0", "sql.js": "^1.11.0" },
        devDependencies: { vitest: "^2.0.0", typescript: "^5.4.0" },
      }),
    );
    const rpg = emptyRPG();
    const src: FolderNode = {
      id: "folder:src",
      kind: "folder",
      name: "src",
      path: "src",
      parent: null,
      children: ["file:errors", "file:routes"],
      features: [],
    };
    const errors: FileNode = {
      id: "file:errors",
      kind: "file",
      name: "errors.ts",
      path: "src/errors.ts",
      content: "",
      language: "typescript",
      rawImports: [],
      exports: [],
      parent: "folder:src",
      children: [],
      features: [],
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:mapError",
            kind: "function",
            name: "mapError",
            ownerClassName: null,
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [],
      },
    };
    const routes: FileNode = {
      id: "file:routes",
      kind: "file",
      name: "routes.ts",
      path: "src/routes.ts",
      content: "",
      language: "typescript",
      rawImports: [],
      exports: [],
      parent: "folder:src",
      children: [],
      features: [],
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:registerTodoRoutes",
            kind: "function",
            name: "registerTodoRoutes",
            ownerClassName: null,
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [],
      },
    };
    rpg.nodes[src.id] = src;
    rpg.nodes[errors.id] = errors;
    rpg.nodes[routes.id] = routes;

    const out = buildProjectContext({ rpg, outDir });
    expect(out).toMatch(/^# Project context/);
    expect(out).toContain("Test command");
    expect(out).toContain("vitest run");
    expect(out).toContain("Build command");
    expect(out).toContain("Runtime deps:");
    expect(out).toContain("express@^4.19.0");
    expect(out).toContain("sql.js@^1.11.0");
    expect(out).toContain("Dev deps:");
    expect(out).toContain("vitest@^2.0.0");
    expect(out).toContain("Layout");
    expect(out).toContain("src/ — 2 file(s)");
    expect(out).toContain("Files (planned exports)");
    expect(out).toContain("src/errors.ts: mapError()");
    expect(out).toContain("src/routes.ts: registerTodoRoutes()");
    // No constraints section when learnedFacts is empty.
    expect(out).not.toMatch(/Known constraints/);
  });

  it("renders learnedFacts under 'Known constraints'", () => {
    const rpg = emptyRPG();
    const out = buildProjectContext({
      rpg,
      learnedFacts: [
        'Package "better-sqlite3" fails to install — use sql.js.',
      ],
    });
    expect(out).toContain("Known constraints");
    expect(out).toContain("better-sqlite3");
    expect(out).toContain("sql.js");
  });

  it("collapses class methods under the class entry to keep the digest compact", () => {
    const rpg = emptyRPG();
    const repo: FileNode = {
      id: "file:repo",
      kind: "file",
      name: "repo.ts",
      path: "src/repo.ts",
      content: "",
      language: "typescript",
      rawImports: [],
      exports: [],
      parent: null,
      children: [],
      features: [],
      interfacePlan: {
        entries: [
          {
            leafCapabilityId: "cap:c",
            kind: "method",
            name: "create",
            ownerClassName: "Repo",
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
          {
            leafCapabilityId: "cap:u",
            kind: "method",
            name: "update",
            ownerClassName: "Repo",
            description: "",
            signature: { params: [], returnType: "void", isAsync: false },
            exported: true,
            isStatic: false,
          },
        ],
        classes: [
          {
            name: "Repo",
            description: "",
            exported: true,
            extendsFromFile: null,
            extendsName: null,
          },
        ],
      },
    };
    rpg.nodes[repo.id] = repo;
    const out = buildProjectContext({ rpg });
    expect(out).toContain("class Repo");
    // Methods are NOT individually listed — they roll up under the class.
    expect(out).not.toContain("Repo.create()");
    expect(out).not.toContain("Repo.update()");
  });
});

describe("extractLessonFromTrail", () => {
  it("turns an npm-install gyp failure on add_dependency into a lesson", () => {
    const lesson = extractLessonFromTrail([
      {
        tool: "add_dependency",
        args: { name: "better-sqlite3", version: "^11", which: "runtime" },
        ok: false,
        error:
          "npm install exited with code 1; stderr: gyp ERR! build error\nnode-gyp failed",
      },
    ]);
    expect(lesson).not.toBeNull();
    expect(lesson).toContain("better-sqlite3");
    expect(lesson).toMatch(/avoid|alternative/i);
  });

  it("returns null for unrecognized failure modes", () => {
    const lesson = extractLessonFromTrail([
      { tool: "edit_file", args: {}, ok: false, error: "old_str not found" },
    ]);
    expect(lesson).toBeNull();
  });

  it("returns null when the trail is empty", () => {
    expect(extractLessonFromTrail([])).toBeNull();
  });
});
