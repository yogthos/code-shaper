/**
 * Acceptance tests for the Phase 0+1 review fixes:
 *
 *   #1 source order preserved: file children come back in declaration
 *      order, not classes-then-functions.
 *   #2 ignore is segment-based, not substring-based: a folder named
 *      "test-build" is NOT skipped just because it contains "build".
 *   #5 parse errors emit a structured warning: a syntactically broken
 *      file triggers an `onWarning` callback identifying the file.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRepo, isFile } from "../src/rpg/index.js";

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/sample-repo",
);

describe("review fix #1 — source order", () => {
  it("FileNode.children reflects declaration order", async () => {
    const rpg = await loadRepo(FIXTURE);
    const mixed = (Object.values(rpg.nodes) as any[]).find(
      (n) => isFile(n) && n.path.endsWith("mixed.ts"),
    );
    expect(mixed).toBeDefined();

    const childNames = mixed.children.map((id: string) => rpg.nodes[id]?.name);
    // Source order in mixed.ts:
    //   alpha, Beta, gamma, delta, Epsilon
    expect(childNames).toEqual(["alpha", "Beta", "gamma", "delta", "Epsilon"]);
  });
});

describe("review fix #2 — segment-based ignore", () => {
  it("'test-build/' (substring 'build') is NOT skipped", async () => {
    const rpg = await loadRepo(FIXTURE);
    const paths: string[] = [];
    for (const node of Object.values(rpg.nodes)) {
      if (isFile(node)) paths.push(node.path);
    }
    expect(paths.some((p) => p.includes("test-build"))).toBe(true);
  });

  it("'build/' (exact segment) IS skipped", async () => {
    // Create a temp repo with a real `build/` directory; assert it's
    // excluded by default. A separate temp tree avoids polluting the
    // shared fixture.
    const tmp = await mkdtemp(path.join(tmpdir(), "rpg-ignore-"));
    try {
      await mkdir(path.join(tmp, "build"), { recursive: true });
      await writeFile(
        path.join(tmp, "build", "should-skip.ts"),
        "export const skipped = 1;\n",
      );
      await writeFile(path.join(tmp, "kept.ts"), "export const kept = 1;\n");
      const rpg = await loadRepo(tmp);
      const paths: string[] = [];
      for (const node of Object.values(rpg.nodes)) {
        if (isFile(node)) paths.push(node.path);
      }
      expect(paths).toEqual(["kept.ts"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("review fix #5 — parse error warnings", () => {
  it("a syntax error fires onWarning with the file path", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "rpg-parseerr-"));
    try {
      await writeFile(
        path.join(tmp, "broken.ts"),
        "export function broken(x: number): number {\n  return x +\n}\n",
      );
      await writeFile(
        path.join(tmp, "good.ts"),
        "export function good(): number {\n  return 1;\n}\n",
      );
      const warnings: string[] = [];
      await loadRepo(tmp, {
        onWarning: (w) => warnings.push(`${w.kind}:${w.path}`),
      });
      expect(warnings).toEqual(["parse-error:broken.ts"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
