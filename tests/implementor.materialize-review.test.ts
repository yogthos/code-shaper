/**
 * Per-leaf incremental-materialize review fix.
 *
 *   #1 When two leaves in DIFFERENT files land sequentially, both
 *      files retain their rendered content on disk after the second
 *      leaf's materialize. The previous bug clobbered the first file
 *      with an empty string because we dropped its `.content` after
 *      materializing.
 *
 *   #4 `runTests` work-dir paths inside `tests/leaves` and
 *      `tests/integration` go through the safeResolve guard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  emptyRPG,
  type FileNode,
  type FolderNode,
} from "../src/rpg/index.js";
import {
  buildImplementations,
  createHarnessDir,
  linkHostNodeModules,
} from "../src/implementor/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

let workDir: string;

beforeAll(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
}, 30_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("review fix #1 — incremental materialize keeps every file's content", () => {
  it(
    "two leaves in different files both retain their bodies on disk",
    { timeout: 60_000 },
    async () => {
      // Build an RPG with two leaves, each in its own file. The
      // orchestrator's per-leaf materialize previously alternated
      // empty content between A and B. The fix: render every plan-
      // bearing file before each materialize.
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

      const fileC: FileNode = {
        id: "file:src/c.ts",
        kind: "file",
        name: "c.ts",
        parent: "folder:src",
        children: [],
        features: [],
        path: "src/c.ts",
        content: "",
        language: "typescript",
        rawImports: [],
        exports: [],
        interfacePlan: {
          classes: [],
          entries: [
            {
              leafCapabilityId: "cap:c",
              kind: "function",
              ownerClassName: null,
              name: "c",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "Returns 3.",
              exported: true,
              isStatic: false,
            },
          ],
        },
      };
      const fileA: FileNode = {
        id: "file:src/a.ts",
        kind: "file",
        name: "a.ts",
        parent: "folder:src",
        children: [],
        features: [],
        path: "src/a.ts",
        content: "",
        language: "typescript",
        rawImports: [],
        exports: [],
        interfacePlan: {
          classes: [],
          entries: [
            {
              leafCapabilityId: "cap:a",
              kind: "function",
              ownerClassName: null,
              name: "a",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "Returns 1.",
              exported: true,
              isStatic: false,
            },
          ],
        },
      };
      const fileB: FileNode = {
        id: "file:src/b.ts",
        kind: "file",
        name: "b.ts",
        parent: "folder:src",
        children: [],
        features: [],
        path: "src/b.ts",
        content: "",
        language: "typescript",
        rawImports: [],
        exports: [],
        interfacePlan: {
          classes: [],
          entries: [
            {
              leafCapabilityId: "cap:b",
              kind: "function",
              ownerClassName: null,
              name: "b",
              signature: { params: [], returnType: "number", isAsync: false },
              description: "Returns 2.",
              exported: true,
              isStatic: false,
            },
          ],
        },
      };
      rpg.nodes[fileA.id] = fileA;
      rpg.nodes[fileB.id] = fileB;
      rpg.nodes[fileC.id] = fileC;
      (rpg.nodes["folder:src"] as FolderNode).children.push(
        fileA.id,
        fileB.id,
        fileC.id,
      );

      // Snapshot disk state of A and B at the moment leaf C's body
      // author runs. Both earlier leaves have already materialized
      // by then; without the fix, the second one's materialize would
      // have clobbered the first one's source with empty content.
      let aDuringC: string | null = null;
      let bDuringC: string | null = null;
      let outDirRef = "";
      const expectedFor = (leaf: string): number =>
        leaf === "a" ? 1 : leaf === "b" ? 2 : 3;
      const bodyFor = (leaf: string): string =>
        `return ${expectedFor(leaf)};`;

      const client: LLMClient = {
        async chat(messages): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          const user = messages[messages.length - 1]!.content;
          if (sys.includes("producing a vitest test file")) {
            const m = user.match(/Function `([^`]+)`/);
            const leaf = m ? m[1]! : "?";
            return {
              content: `import { describe, it, expect } from "vitest";
import { ${leaf} } from "../../src/${leaf}.js";
describe("${leaf}", () => { it("returns ${expectedFor(leaf)}", () => { expect(${leaf}()).toBe(${expectedFor(leaf)}); }); });
`,
              finishReason: "stop",
            };
          }
          if (sys.includes("producing the body of a single")) {
            const m = user.match(/Function `([^`]+)`/);
            const leaf = m ? m[1]! : "?";
            if (leaf === "c" && outDirRef && aDuringC === null) {
              // Snapshot A and B before leaf C lands. With the bug,
              // B (last-materialized file) has good content but A
              // (first leaf, then dropped to empty) has been
              // clobbered to empty by leaf B's materialize. With
              // the fix, both are still good.
              aDuringC = await readFile(
                path.join(outDirRef, "src/a.ts"),
                "utf-8",
              );
              bDuringC = await readFile(
                path.join(outDirRef, "src/b.ts"),
                "utf-8",
              );
            }
            return { content: bodyFor(leaf), finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const outDir = await mkdtemp(path.join(tmpdir(), "incremental-"));
      outDirRef = outDir;
      try {
        const result = await buildImplementations(client, rpg, {
          maxAttemptsPerLeaf: 1,
          outDir,
        });
        expect(result.ok, JSON.stringify(result.leafResults)).toBe(true);

        // Mid-flight snapshots taken DURING leaf C's body authoring
        // — i.e., after both A's AND B's per-leaf materializes have
        // run. With the bug, A would be empty (clobbered by B's
        // materialize after we dropped its content). With the fix,
        // both retain their rendered bodies.
        expect(aDuringC, "snapshot of A not captured").not.toBeNull();
        expect(bDuringC, "snapshot of B not captured").not.toBeNull();
        expect(aDuringC!).toContain("return 1;");
        expect(aDuringC!).not.toContain("not implemented");
        expect(bDuringC!).toContain("return 2;");
        expect(bDuringC!).not.toContain("not implemented");

        // Final on-disk state: all three files have their bodies.
        const aSource = await readFile(path.join(outDir, "src/a.ts"), "utf-8");
        const bSource = await readFile(path.join(outDir, "src/b.ts"), "utf-8");
        const cSource = await readFile(path.join(outDir, "src/c.ts"), "utf-8");
        expect(aSource).toContain("return 1;");
        expect(bSource).toContain("return 2;");
        expect(cSource).toContain("return 3;");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
  );
});
