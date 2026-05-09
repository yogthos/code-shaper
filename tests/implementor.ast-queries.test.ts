/**
 * Step U6: AST query toolkit.
 *
 * Four cheap, definitive queries the model would otherwise grep
 * for:
 *   listSymbolsInFile  — top-level exports + their kinds
 *   findDefinition     — where is symbol X declared?
 *   findCallers        — who references X?
 *   findImportsOf      — what files import from path P?
 *
 * All driven by tree-sitter parses of files under outDir.
 * Cached per-file via mtime to keep repeat queries fast.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listSymbolsInFile,
  findDefinition,
  findCallers,
  findImportsOf,
} from "../src/implementor/ast-queries.js";

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "ast-q-"));
  await mkdir(path.join(outDir, "src"), { recursive: true });
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("listSymbolsInFile", () => {
  it("lists top-level exported function/class declarations", async () => {
    await writeFile(
      path.join(outDir, "src", "thing.ts"),
      `export function add(a: number, b: number): number { return a + b; }
export class Counter {
  count = 0;
  inc() { this.count++; }
}
function helper(): void {} // not exported
export const PI = 3.14;
`,
    );
    const r = await listSymbolsInFile({ outDir, path: "src/thing.ts" });
    expect(r.ok).toBe(true);
    const names = r.symbols!.map((s) => s.name).sort();
    expect(names).toContain("add");
    expect(names).toContain("Counter");
    expect(names).toContain("PI");
    // Internal helpers don't show up as symbols.
    expect(names).not.toContain("helper");
    const add = r.symbols!.find((s) => s.name === "add");
    expect(add!.kind).toBe("function");
    expect(add!.exported).toBe(true);
    const cls = r.symbols!.find((s) => s.name === "Counter");
    expect(cls!.kind).toBe("class");
  });

  it("returns ok=false when the file doesn't exist", async () => {
    const r = await listSymbolsInFile({ outDir, path: "src/missing.ts" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|does not exist|no such file/i);
  });
});

describe("findDefinition", () => {
  it("locates the file + line where a function is declared", async () => {
    await writeFile(
      path.join(outDir, "src", "math.ts"),
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    await writeFile(
      path.join(outDir, "src", "use.ts"),
      `import { add } from "./math.js";\nadd(1, 2);\n`,
    );
    const r = await findDefinition({ outDir, name: "add" });
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches![0]!.file).toBe("src/math.ts");
    expect(r.matches![0]!.kind).toBe("function");
    expect(r.matches![0]!.line).toBeGreaterThan(0);
  });

  it("returns multiple matches for ambiguous symbol names", async () => {
    await writeFile(
      path.join(outDir, "src", "a.ts"),
      `export function fmt(s: string): string { return s; }\n`,
    );
    await writeFile(
      path.join(outDir, "src", "b.ts"),
      `export class fmt {}\n`,
    );
    const r = await findDefinition({ outDir, name: "fmt" });
    expect(r.ok).toBe(true);
    expect(r.matches!.length).toBe(2);
  });

  it("returns no matches when symbol is not declared anywhere", async () => {
    await writeFile(
      path.join(outDir, "src", "a.ts"),
      `export function add() {}\n`,
    );
    const r = await findDefinition({ outDir, name: "nonexistent" });
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual([]);
  });
});

describe("findCallers", () => {
  it("finds files that reference a symbol", async () => {
    await writeFile(
      path.join(outDir, "src", "math.ts"),
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    await writeFile(
      path.join(outDir, "src", "consumer.ts"),
      `import { add } from "./math.js";\nexport function double(x: number) { return add(x, x); }\n`,
    );
    await writeFile(
      path.join(outDir, "src", "other.ts"),
      `export function unrelated() { return 42; }\n`,
    );
    const r = await findCallers({ outDir, name: "add" });
    expect(r.ok).toBe(true);
    // src/consumer.ts references `add` (in import + call).
    const callers = r.matches!.map((m) => m.file).sort();
    expect(callers).toContain("src/consumer.ts");
    // src/math.ts is the definition site, not a caller.
    expect(callers).not.toContain("src/math.ts");
    expect(callers).not.toContain("src/other.ts");
  });

  it("matches by word boundary, not substring", async () => {
    await writeFile(
      path.join(outDir, "src", "a.ts"),
      `export function id() {}\n`,
    );
    await writeFile(
      path.join(outDir, "src", "b.ts"),
      `import { id } from "./a.js";\nexport function getId() { return id(); }\n`,
    );
    await writeFile(
      path.join(outDir, "src", "c.ts"),
      `export const valid = "yes"; // contains "id" as substring but not as identifier\n`,
    );
    const r = await findCallers({ outDir, name: "id" });
    expect(r.ok).toBe(true);
    const callers = r.matches!.map((m) => m.file).sort();
    expect(callers).toContain("src/b.ts");
    expect(callers).not.toContain("src/c.ts");
  });
});

describe("findImportsOf", () => {
  it("finds files that import from a given module path", async () => {
    await writeFile(
      path.join(outDir, "src", "errors.ts"),
      `export class TodoError extends Error {}\n`,
    );
    await writeFile(
      path.join(outDir, "src", "use1.ts"),
      `import { TodoError } from "./errors.js";\n`,
    );
    await writeFile(
      path.join(outDir, "src", "use2.ts"),
      `import { TodoError } from "./errors.js";\nimport other from "vitest";\n`,
    );
    await writeFile(
      path.join(outDir, "src", "unrelated.ts"),
      `import { x } from "./other.js";\n`,
    );
    const r = await findImportsOf({ outDir, modulePath: "./errors.js" });
    expect(r.ok).toBe(true);
    const importers = r.matches!.map((m) => m.file).sort();
    expect(importers).toEqual(["src/use1.ts", "src/use2.ts"]);
  });

  it("matches the import specifier verbatim (relative paths must match)", async () => {
    await writeFile(
      path.join(outDir, "src", "a.ts"),
      `import { x } from "./b.js";\n`,
    );
    await writeFile(
      path.join(outDir, "src", "c.ts"),
      `import { x } from "../src/b.js";\n`,
    );
    const r = await findImportsOf({ outDir, modulePath: "./b.js" });
    // Only exact-spec match. The user can normalize externally if
    // they want loose matching.
    expect(r.ok).toBe(true);
    const importers = r.matches!.map((m) => m.file).sort();
    expect(importers).toEqual(["src/a.ts"]);
  });
});
