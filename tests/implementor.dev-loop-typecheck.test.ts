/**
 * Step 3 of the dev-loop refactor: typecheckTool.
 *
 * Spawns `tsc --noEmit` against the model's outDir and returns
 * diagnostics filtered to the active file path. Sibling files in
 * a multi-leaf build will have unresolved-symbol errors until
 * their leaves implement; surfacing those would mislead the
 * model into "fixing" code it isn't responsible for.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { typecheckTool } from "../src/implementor/dev-loop-tools.js";

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "tc-"));
  await writeFile(path.join(outDir, "tsconfig.json"), TSCONFIG);
  await mkdir(path.join(outDir, "src"));
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("typecheckTool", () => {
  it(
    "returns ok=true with empty diagnostics when the project type-checks",
    { timeout: 60_000 },
    async () => {
      await writeFile(
        path.join(outDir, "src", "good.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      const r = await typecheckTool({
        outDir,
        activeFilePath: "src/good.ts",
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.diagnostics).toEqual([]);
    },
  );

  it(
    "returns ok=false with diagnostics scoped to the active file",
    { timeout: 60_000 },
    async () => {
      await writeFile(
        path.join(outDir, "src", "broken.ts"),
        "export const x: number = \"not a number\";\n",
      );
      const r = await typecheckTool({
        outDir,
        activeFilePath: "src/broken.ts",
      });
      expect(r.ok).toBe(false);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      const text = r.diagnostics.join("\n");
      expect(text).toMatch(/broken\.ts/);
      expect(text).toMatch(/Type 'string'/);
    },
  );

  it(
    "filters out diagnostics from files OTHER than the active file",
    { timeout: 60_000 },
    async () => {
      // sibling.ts has a stub-style error; active.ts is clean.
      await writeFile(
        path.join(outDir, "src", "sibling.ts"),
        "export function notImpl(): number { throw new Error(\"stub\"); }\nconst broken: number = \"oops\";\n",
      );
      await writeFile(
        path.join(outDir, "src", "active.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      const r = await typecheckTool({
        outDir,
        activeFilePath: "src/active.ts",
      });
      // From the active file's perspective, the project is fine.
      expect(r.ok).toBe(true);
      expect(r.diagnostics).toEqual([]);
    },
  );

  it(
    "returns ran=false when there's no tsconfig.json (non-TS project)",
    { timeout: 60_000 },
    async () => {
      await rm(path.join(outDir, "tsconfig.json"));
      const r = await typecheckTool({
        outDir,
        activeFilePath: "src/anything.ts",
      });
      expect(r.ran).toBe(false);
      // ran=false implies "skipped"; ok stays true so we don't
      // gate the loop on a missing config.
      expect(r.ok).toBe(true);
    },
  );

  it(
    "honors the timeout parameter and returns a clear timeout error",
    { timeout: 10_000 },
    async () => {
      // Force a timeout by setting timeout to 1ms.
      await writeFile(
        path.join(outDir, "src", "ok.ts"),
        "export const x: number = 1;\n",
      );
      const r = await typecheckTool({
        outDir,
        activeFilePath: "src/ok.ts",
        timeoutMs: 1,
      });
      expect(r.ok).toBe(false);
      expect(r.diagnostics.join("\n")).toMatch(/timed out|timeout/i);
    },
  );
});
