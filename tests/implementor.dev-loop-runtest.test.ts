/**
 * V3: runTestTool runs `vitest run` in outDir directly. The
 * implementor's TDD model means the model writes its OWN tests
 * to outDir via edit_file; we just spawn vitest there.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTestTool } from "../src/implementor/dev-loop-tools.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "rt-"));
  // Symlink the host repo's node_modules so vitest is reachable
  // from the project under test.
  await symlink(
    path.join(process.cwd(), "node_modules"),
    path.join(outDir, "node_modules"),
  );
  // Minimal package.json + tsconfig + vitest config so vitest
  // picks up tests under tests/.
  await writeFile(
    path.join(outDir, "package.json"),
    JSON.stringify(
      {
        name: "rt-fixture",
        type: "module",
        scripts: { test: "vitest run" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(outDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
        },
        include: ["**/*.ts"],
      },
      null,
      2,
    ),
  );
  await mkdir(path.join(outDir, "src"));
  await mkdir(path.join(outDir, "tests"));
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("runTestTool", () => {
  it(
    "returns ok=true when all tests in the project pass",
    { timeout: 60_000 },
    async () => {
      await writeFile(
        path.join(outDir, "src", "add.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
      );
      await writeFile(
        path.join(outDir, "tests", "add.test.ts"),
        `import { describe, it, expect } from "vitest";\nimport { add } from "../src/add.js";\ndescribe("add", () => { it("sums", () => { expect(add(2, 3)).toBe(5); }); });\n`,
      );
      const r = await runTestTool({ outDir });
      expect(r.ok, r.output).toBe(true);
    },
  );

  it(
    "returns ok=false with the failing assertion when a test fails",
    { timeout: 60_000 },
    async () => {
      await writeFile(
        path.join(outDir, "src", "add.ts"),
        "export function add(a: number, b: number): number { return a - b; }\n",
      );
      await writeFile(
        path.join(outDir, "tests", "add.test.ts"),
        `import { describe, it, expect } from "vitest";\nimport { add } from "../src/add.js";\ndescribe("add", () => { it("sums", () => { expect(add(2, 3)).toBe(5); }); });\n`,
      );
      const r = await runTestTool({ outDir });
      expect(r.ok).toBe(false);
      // The output should reference the failed assertion.
      expect(r.output).toMatch(/expected.*to be 5/i);
    },
  );

  it(
    "returns a clear error when there are no tests in the project",
    { timeout: 30_000 },
    async () => {
      // No test files at all.
      const r = await runTestTool({ outDir });
      // vitest exits non-zero when no tests are found.
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/no test files found/i);
    },
  );
});
