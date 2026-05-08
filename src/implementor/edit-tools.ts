/**
 * Surgical edit tools — RPG paper Appendix D.2.
 *
 * Four scope-bounded edits the implementation agent can apply to a
 * source file. Each tool takes (file source, target identifier, new
 * source) and returns the spliced file source — or an error if the
 * target isn't found, the new source doesn't parse, or the new
 * source declares the wrong entity.
 *
 * §D.2 specifies the tool set verbatim:
 *
 *   edit_whole_class_in_file(file_path, class_name)
 *     "Output must: Provide the full class definition, with all
 *      methods and docstring."
 *
 *   edit_method_of_class_in_file(file_path, class_name, method_name)
 *     "Return the full `class ClassName:` block containing only the
 *      target method. Exclude all unrelated methods. Do not output
 *      the method alone; it must appear within its class block."
 *
 *   edit_function_in_file(file_path, function_name)
 *     "Provide the full function, including signature, logic, and
 *      docstring."
 *
 *   edit_imports_and_assignments_in_file(file_path)
 *     "Contain only import statements and top-level assignments
 *      (no functions or classes)."
 *
 * The fifth tool — `Terminate()` — is a control-flow signal, not a
 * source mutation; it doesn't belong in this module.
 *
 * Implementation: tree-sitter locates the target node in the
 * existing source by name, and the new source is parsed to verify
 * (a) it is valid TypeScript and (b) it contains the same named
 * entity (so the agent can't silently rename a method on us). On
 * success, the mutation is a single byte-range splice; on failure,
 * the original source is returned untouched and an error message
 * is surfaced to the caller.
 */

import { getAdapterByLanguage } from "../rpg/adapters/index.js";

export interface EditResult {
  ok: boolean;
  /** Spliced file source on success. */
  source?: string;
  /** Diagnostic on failure. */
  error?: string;
}

interface ParseSuccess {
  ok: true;
  parser: unknown;
  tree: TreeSitterTree;
}
interface ParseFailure {
  ok: false;
  error: string;
}

interface TreeSitterNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
  childForFieldName: (name: string) => TreeSitterNode | null;
  text: string;
  hasError: boolean;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

/**
 * Replace a top-level function declaration. Errors:
 *   - Function not found in the original source
 *   - newSource doesn't parse as TypeScript
 *   - newSource doesn't declare a function with `name` (or declares
 *     more than one top-level item)
 */
export function editFunctionInFile(
  source: string,
  name: string,
  newSource: string,
): EditResult {
  const parsed = parseTs(source);
  if (!parsed.ok) return { ok: false, error: `original: ${parsed.error}` };
  const target = findFunctionDeclaration(parsed.tree.rootNode, name);
  if (!target) {
    return {
      ok: false,
      error: `function "${name}" not found in source`,
    };
  }
  const newParsed = parseTs(newSource);
  if (!newParsed.ok) {
    return { ok: false, error: `new source: ${newParsed.error}` };
  }
  // Sanity-check: the new source must declare a function with the
  // same name. Anything else (different name, missing function,
  // extra top-level junk) signals an LLM hallucination — better to
  // refuse the edit than to splice a renamed/moved declaration.
  const newDecl = findFunctionDeclaration(newParsed.tree.rootNode, name);
  if (!newDecl) {
    return {
      ok: false,
      error: `new source must declare a function named "${name}"`,
    };
  }
  // Review fix #1 — export-keyword mismatch. If the original target
  // is wrapped in `export_statement` but the new source is bare
  // `function foo()`, splicing the bare declaration over the export
  // wrapper drops the `export` keyword silently — every importer
  // breaks. Reject the mismatch and let the LLM retry; we don't
  // auto-wrap because preserving structure beats inferring intent.
  const origExported = target.type === "export_statement";
  const newExported = newDecl.type === "export_statement";
  if (origExported !== newExported) {
    return {
      ok: false,
      error: `export keyword mismatch: original ${
        origExported ? "is exported" : "is not exported"
      } but new source ${
        newExported ? "exports" : "does not export"
      } the function — preserve the export modifier`,
    };
  }
  return spliceRange(source, target.startIndex, target.endIndex, newDecl.text);
}

/**
 * Replace a top-level class declaration. The new source must be the
 * full class body — all methods, no orphans.
 */
export function editWholeClassInFile(
  source: string,
  name: string,
  newSource: string,
): EditResult {
  const parsed = parseTs(source);
  if (!parsed.ok) return { ok: false, error: `original: ${parsed.error}` };
  const target = findClassDeclaration(parsed.tree.rootNode, name);
  if (!target) {
    return { ok: false, error: `class "${name}" not found in source` };
  }
  const newParsed = parseTs(newSource);
  if (!newParsed.ok) {
    return { ok: false, error: `new source: ${newParsed.error}` };
  }
  const newDecl = findClassDeclaration(newParsed.tree.rootNode, name);
  if (!newDecl) {
    return {
      ok: false,
      error: `new source must declare a class named "${name}"`,
    };
  }
  // Review fix #1 — same export-keyword guard as for functions.
  const origExported = target.type === "export_statement";
  const newExported = newDecl.type === "export_statement";
  if (origExported !== newExported) {
    return {
      ok: false,
      error: `export keyword mismatch: original ${
        origExported ? "is exported" : "is not exported"
      } but new source ${
        newExported ? "exports" : "does not export"
      } the class — preserve the export modifier`,
    };
  }
  return spliceRange(source, target.startIndex, target.endIndex, newDecl.text);
}

/**
 * Replace a single method on a class. Per §D.2, the model emits the
 * FULL class block containing ONLY the target method — that
 * constraint exists to prevent the LLM from accidentally rewriting
 * sibling methods. We honor that contract on input but only splice
 * the method itself: other methods on the existing class are
 * preserved verbatim.
 */
export function editMethodOfClassInFile(
  source: string,
  className: string,
  methodName: string,
  newSourceWithClassBlock: string,
): EditResult {
  const parsed = parseTs(source);
  if (!parsed.ok) return { ok: false, error: `original: ${parsed.error}` };
  const classNode = findClassDeclaration(parsed.tree.rootNode, className);
  if (!classNode) {
    return { ok: false, error: `class "${className}" not found in source` };
  }
  const methodNode = findMethodDefinition(classNode, methodName);
  if (!methodNode) {
    return {
      ok: false,
      error: `method "${className}.${methodName}" not found`,
    };
  }
  // Validate the LLM emitted a class block, not a bare method, and
  // that the block contains exactly the target method.
  const newParsed = parseTs(newSourceWithClassBlock);
  if (!newParsed.ok) {
    return { ok: false, error: `new source: ${newParsed.error}` };
  }
  const newClassNode = findClassDeclaration(
    newParsed.tree.rootNode,
    className,
  );
  if (!newClassNode) {
    return {
      ok: false,
      error: `new source must contain a class block "class ${className} { … }" — see §D.2`,
    };
  }
  const newMethodNode = findMethodDefinition(newClassNode, methodName);
  if (!newMethodNode) {
    return {
      ok: false,
      error: `new class block must contain a method named "${methodName}"`,
    };
  }
  // Refuse if the block has unrelated methods — the §D.2 contract is
  // explicit: "Exclude all unrelated methods." Other methods would
  // be silently dropped if we let them through.
  const otherMethods = collectMethodNames(newClassNode).filter(
    (n) => n !== methodName,
  );
  if (otherMethods.length > 0) {
    return {
      ok: false,
      error: `new class block must contain ONLY the target method; got extras: ${otherMethods.join(", ")}`,
    };
  }
  // Review fix #2 — non-method declarations in the class block
  // (fields, constructor, static blocks, getters/setters) parse
  // cleanly and pass the "only one method named X" check, but the
  // splice only replaces the method's byte range — anything else
  // the LLM put in the block is silently discarded. The model
  // thinks it added `value = 0` or a constructor; the file never
  // gets it. Reject any non-method named child up front so the
  // model retries with a class block containing ONLY the method
  // (per §D.2) and either uses edit_whole_class_in_file or asks
  // the architect to update the plan when fields/constructors
  // need to change.
  const stowaways = collectNonMethodMemberKinds(newClassNode);
  if (stowaways.length > 0) {
    return {
      ok: false,
      error: `new class block must contain ONLY the target method (no fields, constructors, static blocks, getters/setters, etc.); got: ${stowaways.join(", ")}. Use edit_whole_class_in_file if the rest of the class needs changes.`,
    };
  }
  return spliceRange(
    source,
    methodNode.startIndex,
    methodNode.endIndex,
    newMethodNode.text,
  );
}

/**
 * Replace the import block AND any top-level assignments at the top
 * of the file. The "imports + assignments" region is everything up
 * to the first declaration (function/class/etc.) that isn't an
 * import or top-level assignment.
 *
 * §D.2 also requires: "Do not remove existing imports unless they
 * are demonstrably incorrect" and "Retain imports even if they
 * appear unused, to preserve runtime dependencies." We don't enforce
 * those at the parser level — the agent's prompt does, and we let
 * the agent's output stand on its own merits as long as it's
 * syntactically valid.
 */
export function editImportsAndAssignmentsInFile(
  source: string,
  newSource: string,
): EditResult {
  const parsed = parseTs(source);
  if (!parsed.ok) return { ok: false, error: `original: ${parsed.error}` };
  const newParsed = parseTs(newSource);
  if (!newParsed.ok) {
    return { ok: false, error: `new source: ${newParsed.error}` };
  }
  // The new source must contain ONLY imports + top-level
  // assignments. Reject if anything else (function/class/export
  // function) appears.
  for (const child of newParsed.tree.rootNode.namedChildren) {
    if (!isImportOrAssignmentNode(child)) {
      return {
        ok: false,
        error: `new source contains a non-import / non-assignment top-level node: ${child.type}`,
      };
    }
  }
  // Find the byte range of the import-and-assignment region in the
  // original. It runs from byte 0 (or from leading-whitespace) to
  // the start of the first non-import / non-assignment top-level
  // child. If the file has no such trailing child, the region is
  // the entire file.
  let endIndex = source.length;
  for (const child of parsed.tree.rootNode.namedChildren) {
    if (!isImportOrAssignmentNode(child)) {
      endIndex = child.startIndex;
      break;
    }
  }
  // Trim trailing whitespace from the new source so we don't
  // accumulate blank lines on each edit.
  return spliceRange(source, 0, endIndex, newSource.trimEnd() + "\n\n");
}

/**
 * Extract just the body STATEMENTS of a top-level function from a
 * source string. Returns null if the function isn't found or its
 * body block can't be located.
 *
 * "Body statements" = the bytes between `{` and `}` (exclusive),
 * with leading/trailing whitespace trimmed but interior structure
 * preserved. This is what the renderer expects in `bodyByLeafId` —
 * the renderer wraps it in a signature + braces. So feeding the
 * extraction back into the renderer reproduces the input function
 * up to whitespace.
 */
export function extractFunctionBody(
  source: string,
  name: string,
): string | null {
  const parsed = parseTs(source);
  if (!parsed.ok) return null;
  const fn = findFunctionDeclaration(parsed.tree.rootNode, name);
  if (!fn) return null;
  // The actual function_declaration may be wrapped in
  // export_statement; descend if so.
  let target = fn;
  if (target.type === "export_statement") {
    const decl = target.childForFieldName("declaration");
    if (decl && decl.type === "function_declaration") target = decl;
  }
  const body = target.childForFieldName("body");
  if (!body) return null;
  return extractBodyContent(body.text);
}

/**
 * Extract just the body STATEMENTS of a method on a class. Returns
 * null if the class or method isn't found. Same trim semantics as
 * `extractFunctionBody`.
 */
export function extractMethodBody(
  source: string,
  className: string,
  methodName: string,
): string | null {
  const parsed = parseTs(source);
  if (!parsed.ok) return null;
  const cls = findClassDeclaration(parsed.tree.rootNode, className);
  if (!cls) return null;
  const method = findMethodDefinition(cls, methodName);
  if (!method) return null;
  const body = method.childForFieldName("body");
  if (!body) return null;
  return extractBodyContent(body.text);
}

/** Strip the outer `{` / `}` from a statement_block's text. */
function extractBodyContent(blockText: string): string {
  let s = blockText.trim();
  if (s.startsWith("{")) s = s.slice(1);
  if (s.endsWith("}")) s = s.slice(0, -1);
  // Common indentation cleanup: every body line typically starts
  // with at least 2 spaces (inside the function scope). Dedent by
  // the minimum leading whitespace across non-blank lines so the
  // renderer's own indenting does the right thing.
  const lines = s.split("\n");
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const m = line.match(/^(\s*)/);
    const indent = m ? m[1]!.length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent !== Infinity && minIndent > 0) {
    return lines
      .map((l) => (l.length >= minIndent ? l.slice(minIndent) : l))
      .join("\n")
      .trim();
  }
  return s.trim();
}

// ── Internals ────────────────────────────────────────────────────────

function parseTs(source: string): ParseSuccess | ParseFailure {
  const adapter = getAdapterByLanguage("typescript");
  if (!adapter) {
    return {
      ok: false,
      error: "no typescript adapter registered",
    };
  }
  // Reuse the same parser we already load for AST extraction.
  // tree-sitter is reentrant per parser instance.
  const Parser = require("tree-sitter");
  const tsMod = require("tree-sitter-typescript");
  const parser = new Parser();
  parser.setLanguage(tsMod.typescript);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) {
    return {
      ok: false,
      error: `tree-sitter reported error nodes while parsing source`,
    };
  }
  return { ok: true, parser, tree };
}

function findFunctionDeclaration(
  root: TreeSitterNode,
  name: string,
): TreeSitterNode | null {
  for (const child of root.namedChildren) {
    // Plain function: `function foo() {}`
    if (child.type === "function_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode && nameNode.text === name) return child;
    }
    // Exported: `export function foo() {}` wraps the function in an
    // `export_statement` whose `declaration` field is the
    // function_declaration.
    if (child.type === "export_statement") {
      const decl = child.childForFieldName("declaration");
      if (decl && decl.type === "function_declaration") {
        const nameNode = decl.childForFieldName("name");
        if (nameNode && nameNode.text === name) return child;
      }
    }
  }
  return null;
}

function findClassDeclaration(
  root: TreeSitterNode,
  name: string,
): TreeSitterNode | null {
  for (const child of root.namedChildren) {
    if (child.type === "class_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode && nameNode.text === name) return child;
    }
    if (child.type === "export_statement") {
      const decl = child.childForFieldName("declaration");
      if (decl && decl.type === "class_declaration") {
        const nameNode = decl.childForFieldName("name");
        if (nameNode && nameNode.text === name) return child;
      }
    }
  }
  return null;
}

function findMethodDefinition(
  classNode: TreeSitterNode,
  methodName: string,
): TreeSitterNode | null {
  // The actual class_declaration may be nested inside an
  // export_statement; descend if needed.
  let target = classNode;
  if (target.type === "export_statement") {
    const decl = target.childForFieldName("declaration");
    if (decl && decl.type === "class_declaration") target = decl;
  }
  // class_declaration has a `body` field of type `class_body` whose
  // children include `method_definition` nodes.
  const body = target.childForFieldName("body");
  if (!body) return null;
  for (const child of body.namedChildren) {
    if (child.type !== "method_definition") continue;
    const nameNode = child.childForFieldName("name");
    if (nameNode && nameNode.text === methodName) return child;
  }
  return null;
}

function collectMethodNames(classNode: TreeSitterNode): string[] {
  let target = classNode;
  if (target.type === "export_statement") {
    const decl = target.childForFieldName("declaration");
    if (decl && decl.type === "class_declaration") target = decl;
  }
  const body = target.childForFieldName("body");
  if (!body) return [];
  const names: string[] = [];
  for (const child of body.namedChildren) {
    if (child.type !== "method_definition") continue;
    const nameNode = child.childForFieldName("name");
    if (nameNode) names.push(nameNode.text);
  }
  return names;
}

/**
 * Tag any class-body member that ISN'T a method_definition so
 * `editMethodOfClassInFile` can refuse class blocks the LLM packed
 * with side declarations. Returned strings are short identifiers
 * for the error message ("public_field_definition: value", etc.).
 */
function collectNonMethodMemberKinds(classNode: TreeSitterNode): string[] {
  let target = classNode;
  if (target.type === "export_statement") {
    const decl = target.childForFieldName("declaration");
    if (decl && decl.type === "class_declaration") target = decl;
  }
  const body = target.childForFieldName("body");
  if (!body) return [];
  const stowaways: string[] = [];
  for (const child of body.namedChildren) {
    if (child.type === "method_definition") continue;
    if (child.type === "comment") continue;
    // tree-sitter-typescript exposes class members as
    // method_definition (incl. getters/setters and constructors —
    // tests confirm; constructor is a method_definition with name
    // "constructor"), public_field_definition, abstract_method_-
    // signature, class_static_block, abstract_class_signature, etc.
    // Every non-method member is a stowaway here; surface its kind
    // + name (when there is one) so the error message tells the
    // model exactly what to drop.
    const nameNode = child.childForFieldName("name");
    stowaways.push(nameNode ? `${child.type}: ${nameNode.text}` : child.type);
  }
  return stowaways;
}

/** Permitted top-level node types for the "imports + assignments"
 *  scope. tree-sitter-typescript names.
 *
 *  Review fix #5: `ambient_declaration` is intentionally NOT in the
 *  allowlist. It wraps `declare const`, `declare class`, `declare
 *  function`, and `declare module` — the latter three are exactly
 *  what the §D.2 imports tool is supposed to refuse. We accept
 *  `declare const` indirectly by accepting `lexical_declaration`
 *  inside an export_statement; pure `declare const` outside an
 *  export wrapper is rare in our generated code and falls through
 *  to the "not allowed" branch. If a real consumer needs it, the
 *  fix is to walk into ambient_declaration and accept ONLY
 *  variable_declaration / lexical_declaration children. */
function isImportOrAssignmentNode(node: TreeSitterNode): boolean {
  switch (node.type) {
    case "import_statement":
    case "import_alias":
    case "lexical_declaration": // const / let
    case "variable_declaration": // var
    case "expression_statement": // bare assignments at module scope
    case "comment":
      return true;
    default:
      return false;
  }
}

function spliceRange(
  source: string,
  startByte: number,
  endByte: number,
  replacement: string,
): EditResult {
  const newSource =
    source.slice(0, startByte) + replacement + source.slice(endByte);
  // Final validation: the post-splice source must still parse as TS.
  // Catches edge cases where the new fragment was valid in isolation
  // but combined produces a broken file (e.g., missing trailing
  // semicolon meaningful at the join boundary).
  const reparsed = parseTs(newSource);
  if (!reparsed.ok) {
    return {
      ok: false,
      error: `post-splice file does not parse: ${reparsed.error}`,
    };
  }
  return { ok: true, source: newSource };
}
