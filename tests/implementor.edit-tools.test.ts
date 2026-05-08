/**
 * Surgical edit tools — tests covering the §D.2 contract.
 *
 *   edit_function_in_file: replace a top-level function
 *   edit_whole_class_in_file: replace an entire class
 *   edit_method_of_class_in_file: replace one method (input is a
 *     class block containing only the target)
 *   edit_imports_and_assignments_in_file: replace the imports +
 *     assignments region only, preserving subsequent code
 */

import { describe, it, expect } from "vitest";
import {
  editFunctionInFile,
  editWholeClassInFile,
  editMethodOfClassInFile,
  editImportsAndAssignmentsInFile,
} from "../src/implementor/edit-tools.js";

describe("editFunctionInFile", () => {
  it("replaces a named top-level function in place", () => {
    const before = `function add(a: number, b: number): number {
  return a - b; // wrong
}

function unrelated(): string {
  return "leave me alone";
}
`;
    const newFn = `function add(a: number, b: number): number {
  return a + b;
}`;
    const result = editFunctionInFile(before, "add", newFn);
    expect(result.ok, result.error).toBe(true);
    expect(result.source).toContain("return a + b;");
    expect(result.source).not.toContain("return a - b;");
    // Unrelated function preserved verbatim.
    expect(result.source).toContain('return "leave me alone";');
  });

  it("handles `export function foo` (export_statement wrapping)", () => {
    const before = `export function add(a: number, b: number): number {
  return 0;
}
`;
    const newFn = `export function add(a: number, b: number): number {
  return a + b;
}`;
    const result = editFunctionInFile(before, "add", newFn);
    expect(result.ok, result.error).toBe(true);
    expect(result.source).toContain("return a + b;");
    expect(result.source).toContain("export function add");
  });

  it("rejects when the function isn't found", () => {
    const before = `function bar() { return 1; }`;
    const r = editFunctionInFile(before, "missing", "function missing() {}");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it("rejects when new source declares a different function name", () => {
    const before = `function foo() { return 1; }`;
    // New source has the wrong name — guards against rename
    // hallucinations.
    const newSrc = `function bar() { return 2; }`;
    const r = editFunctionInFile(before, "foo", newSrc);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must declare a function named/i);
  });

  it("rejects unparseable new source", () => {
    const before = `function foo() { return 1; }`;
    const r = editFunctionInFile(before, "foo", "function foo() { return ;");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/error nodes/i);
  });
});

describe("editWholeClassInFile", () => {
  it("replaces a class declaration in full", () => {
    const before = `class Foo {
  bar(): number { return 1; }
  baz(): number { return 2; }
}

function freestanding(): void {}
`;
    const newClass = `class Foo {
  bar(): number { return 100; }
  baz(): number { return 200; }
  qux(): number { return 300; }
}`;
    const r = editWholeClassInFile(before, "Foo", newClass);
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toContain("return 100;");
    expect(r.source).toContain("qux()");
    expect(r.source).toContain("function freestanding");
  });

  it("rejects when the class isn't found", () => {
    const r = editWholeClassInFile(`class Bar {}`, "Foo", `class Foo {}`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it("rejects when the new source declares a different class name", () => {
    const r = editWholeClassInFile(
      `class Foo {}`,
      "Foo",
      `class Renamed {}`,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must declare a class named/i);
  });
});

describe("editMethodOfClassInFile", () => {
  it("replaces one method, preserves siblings (per §D.2 contract)", () => {
    const before = `class TodoStore {
  add(text: string): void {
    /* old impl */
  }
  remove(id: string): void {
    /* preserve me */
  }
  toggle(id: string): void {
    /* preserve me */
  }
}
`;
    // §D.2: agent emits the class block with ONLY the target method.
    const newBlock = `class TodoStore {
  add(text: string): void {
    /* new impl — better */
  }
}`;
    const r = editMethodOfClassInFile(before, "TodoStore", "add", newBlock);
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toContain("/* new impl — better */");
    expect(r.source).not.toContain("/* old impl */");
    // Siblings untouched.
    expect(r.source).toContain("/* preserve me */");
    expect(r.source).toContain("remove(id: string)");
    expect(r.source).toContain("toggle(id: string)");
  });

  it("rejects when the new block contains unrelated methods", () => {
    const before = `class C {
  a(): void {}
  b(): void {}
}`;
    const newBlock = `class C {
  a(): void {}
  b(): void {} // ← extra
}`;
    const r = editMethodOfClassInFile(before, "C", "a", newBlock);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ONLY the target method/);
  });

  it("rejects when the new source isn't a class block", () => {
    const before = `class C { a(): void {} }`;
    // Bare method definition — not the §D.2-required class block.
    // Bare method syntax doesn't parse as a top-level TS module
    // (a method is only valid inside a class), so the parser
    // rejects it before the "must contain a class" check fires.
    // Either failure message is acceptable; both surface the
    // §D.2 violation to the caller.
    const r = editMethodOfClassInFile(before, "C", "a", `a(): void {}`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/class block|error nodes|parse/i);
  });

  it("rejects when the target method isn't on the class", () => {
    const before = `class C { a(): void {} }`;
    const r = editMethodOfClassInFile(
      before,
      "C",
      "missing",
      `class C { missing(): void {} }`,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/method.*not found/i);
  });
});

describe("editImportsAndAssignmentsInFile", () => {
  it("replaces only the imports+assignments region; preserves declarations below", () => {
    const before = `import { x } from "./old";
import path from "node:path";

const HOST = "localhost";

export function start(): void {
  console.log(HOST, path);
}
`;
    const newImports = `import { y } from "./new";
import path from "node:path";

const HOST = "127.0.0.1";
`;
    const r = editImportsAndAssignmentsInFile(before, newImports);
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toContain('import { y } from "./new"');
    expect(r.source).not.toContain('import { x } from "./old"');
    expect(r.source).toContain('"127.0.0.1"');
    // Body preserved.
    expect(r.source).toContain("export function start");
  });

  it("rejects when the new source contains a function declaration", () => {
    const before = `import x from "./y";
export function f() {}
`;
    const newImports = `import x from "./y";
function leak() {}`;
    const r = editImportsAndAssignmentsInFile(before, newImports);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-import.*non-assignment/);
  });

  it("rejects when the new source contains a class declaration", () => {
    const before = `import x from "./y";
function f() {}
`;
    const newImports = `import x from "./y";
class Leak {}`;
    const r = editImportsAndAssignmentsInFile(before, newImports);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-import.*non-assignment/);
  });

  it("works when the file has only imports (no following declarations)", () => {
    const before = `import x from "./old";
`;
    const newImports = `import x from "./new";
import y from "./other";
`;
    const r = editImportsAndAssignmentsInFile(before, newImports);
    expect(r.ok, r.error).toBe(true);
    expect(r.source).toContain('"./new"');
    expect(r.source).toContain('"./other"');
  });
});

describe("extractFunctionBody / extractMethodBody", () => {
  it("extracts the body STATEMENTS of a top-level function", async () => {
    const { extractFunctionBody } = await import(
      "../src/implementor/edit-tools.js"
    );
    const src = `function add(a: number, b: number): number {
  const r = a + b;
  return r;
}`;
    const body = extractFunctionBody(src, "add");
    expect(body).toContain("const r = a + b;");
    expect(body).toContain("return r;");
    expect(body).not.toContain("function add");
    expect(body).not.toMatch(/^\s*\{/);
  });

  it("extracts the body of an export-wrapped function", async () => {
    const { extractFunctionBody } = await import(
      "../src/implementor/edit-tools.js"
    );
    const src = `export function add(a: number, b: number): number {
  return a + b;
}`;
    expect(extractFunctionBody(src, "add")).toContain("return a + b;");
  });

  it("extracts the body of a method on a class", async () => {
    const { extractMethodBody } = await import(
      "../src/implementor/edit-tools.js"
    );
    const src = `class Counter {
  inc(): number {
    this.value += 1;
    return this.value;
  }
  value = 0;
}`;
    const body = extractMethodBody(src, "Counter", "inc");
    expect(body).toContain("this.value += 1;");
    expect(body).toContain("return this.value;");
    expect(body).not.toContain("inc(): number");
  });

  it("returns null when the function isn't present", async () => {
    const { extractFunctionBody } = await import(
      "../src/implementor/edit-tools.js"
    );
    expect(extractFunctionBody(`function bar() {}`, "missing")).toBeNull();
  });

  it("dedents bodies to the minimum leading whitespace", async () => {
    const { extractFunctionBody } = await import(
      "../src/implementor/edit-tools.js"
    );
    const src = `function f(): number {
        const x = 1;
        if (x > 0) {
          return x;
        }
        return 0;
      }`;
    const body = extractFunctionBody(src, "f");
    // First non-blank line had 8 leading spaces; after dedent it
    // should start at column 0.
    expect(body!.startsWith("const x = 1;")).toBe(true);
    // Nested indentation (inside the if) is preserved relative to
    // the outermost body — `return x;` was 10 spaces in, so 2
    // spaces deeper than the rest after dedent.
    expect(body).toContain("  return x;");
  });
});

describe("edit-tools — post-splice validation", () => {
  it("rejects edits that produce a non-parseable result", () => {
    // New function source is valid in isolation but the splice
    // boundary ends up unbalanced because the original had braces
    // we need to preserve.
    const before = `function foo() {
  return 1;
}
function bar() {
  return 2;
}
`;
    // New source missing closing brace — won't parse on its own,
    // but even if it did the post-splice file would be broken.
    const newFn = `function foo() {
  return 1;`;
    const r = editFunctionInFile(before, "foo", newFn);
    expect(r.ok).toBe(false);
  });
});
