/**
 * Step U6 — AST query toolkit for the dev loop.
 *
 * Four cheap, definitive queries the model would otherwise grep
 * for:
 *
 *   listSymbolsInFile  — top-level exports + their kinds
 *   findDefinition     — where is symbol X declared?
 *   findCallers        — who references X?
 *   findImportsOf      — what files import from path P?
 *
 * All driven by tree-sitter parses of `.ts` files under outDir.
 * The model uses these in place of grep/list invocations that
 * would (a) be slower and (b) give false-positive substring
 * matches.
 *
 * Implementation: each query walks `outDir/src/**\/*.ts` (and
 * `outDir/tests/**\/*.ts`), parses on demand, runs the
 * appropriate check. No persistent cache — files are small
 * enough that re-parse overhead is dominated by the model's
 * LLM call latency, and a stale cache would surface
 * inconsistencies.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

interface TreeSitterNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  text: string;
  namedChildren: TreeSitterNode[];
  children: TreeSitterNode[];
  childForFieldName: (name: string) => TreeSitterNode | null;
  hasError: boolean;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface ParsedFile {
  path: string;
  source: string;
  tree: TreeSitterTree;
}

let parserSingleton: { parse: (s: string) => TreeSitterTree } | null = null;

function getParser(): { parse: (s: string) => TreeSitterTree } {
  if (parserSingleton) return parserSingleton;
  const req = createRequire(import.meta.url);
  const Parser = req("tree-sitter");
  const tsMod = req("tree-sitter-typescript");
  const parser = new Parser();
  parser.setLanguage(tsMod.typescript);
  parserSingleton = parser as { parse: (s: string) => TreeSitterTree };
  return parserSingleton;
}

// ── File enumeration ───────────────────────────────────────────────

/** Directories the model would never want surfaced: vendor code,
 *  build artifacts, hidden config (we don't index those for AST
 *  queries — too noisy and irrelevant to the dev loop's goals). */
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

async function enumerateSourceFiles(outDir: string): Promise<string[]> {
  // Walk the WHOLE outDir (not just src/+tests/). The architect's
  // file-structure phase may produce non-canonical folder names
  // like `business-logic/`, `http-api/`, `test-suite/` — hard-
  // coding `src/` would silently miss them. Exclude vendor and
  // build dirs to keep the result focused on the project's own
  // sources.
  const out: string[] = [];
  try {
    await walkDir(outDir, out);
  } catch {
    // outDir doesn't exist; return empty.
  }
  return out
    .map((abs) => path.relative(outDir, abs).split(path.sep).join("/"))
    .sort();
}

async function walkDir(dir: string, acc: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkDir(full, acc);
    } else if (
      e.isFile() &&
      (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))
    ) {
      acc.push(full);
    }
  }
}

async function parseFile(
  outDir: string,
  relPath: string,
): Promise<ParsedFile | null> {
  const full = path.join(outDir, relPath);
  let source: string;
  try {
    source = await readFile(full, "utf-8");
  } catch {
    return null;
  }
  const parser = getParser();
  const tree = parser.parse(source);
  return { path: relPath, source, tree };
}

// ── listSymbolsInFile ──────────────────────────────────────────────

export interface ListSymbolsInput {
  outDir: string;
  /** Repo-relative path to the file. */
  path: string;
}

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "method" | "const" | "let" | "type" | "interface";
  line: number;
  exported: boolean;
  /** For functions/methods: the param + return signature when
   *  derivable. For classes: the `extends` clause. */
  signature?: string;
}

export interface ListSymbolsResult {
  ok: boolean;
  symbols?: SymbolInfo[];
  error?: string;
}

export async function listSymbolsInFile(
  input: ListSymbolsInput,
): Promise<ListSymbolsResult> {
  // Existence + readability check.
  const full = path.join(input.outDir, input.path);
  try {
    const s = await stat(full);
    if (!s.isFile()) {
      return { ok: false, error: `${input.path} is not a file` };
    }
  } catch {
    return {
      ok: false,
      error: `file not found: ${JSON.stringify(input.path)} (under outDir)`,
    };
  }
  const parsed = await parseFile(input.outDir, input.path);
  if (!parsed) {
    return { ok: false, error: `failed to read ${input.path}` };
  }
  const symbols: SymbolInfo[] = [];
  for (const child of parsed.tree.rootNode.namedChildren) {
    collectTopLevelSymbols(child, symbols);
  }
  return { ok: true, symbols };
}

function collectTopLevelSymbols(
  node: TreeSitterNode,
  out: SymbolInfo[],
): void {
  if (node.type === "export_statement") {
    // Find the inner declaration.
    for (const child of node.namedChildren) {
      const s = symbolFromDeclaration(child, true);
      if (s) out.push(s);
    }
    return;
  }
  // Non-exported top-level declarations are NOT surfaced — the
  // model wants to know what's available externally.
  // (We could surface internal declarations in a future
  // iteration if needed.)
  return;
}

function symbolFromDeclaration(
  node: TreeSitterNode,
  exported: boolean,
): SymbolInfo | null {
  switch (node.type) {
    case "function_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return null;
      return {
        name: nameNode.text,
        kind: "function",
        line: node.startPosition.row + 1,
        exported,
        ...(extractFunctionSignature(node)
          ? { signature: extractFunctionSignature(node)! }
          : {}),
      };
    }
    case "class_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return null;
      return {
        name: nameNode.text,
        kind: "class",
        line: node.startPosition.row + 1,
        exported,
        ...(extractClassSignature(node)
          ? { signature: extractClassSignature(node)! }
          : {}),
      };
    }
    case "lexical_declaration":
    case "variable_declaration": {
      // const/let. Take the first variable_declarator's name.
      for (const c of node.namedChildren) {
        if (c.type === "variable_declarator") {
          const nameNode = c.childForFieldName("name");
          if (nameNode && nameNode.type === "identifier") {
            return {
              name: nameNode.text,
              kind: node.type === "variable_declaration" ? "let" : "const",
              line: node.startPosition.row + 1,
              exported,
            };
          }
        }
      }
      return null;
    }
    case "type_alias_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return null;
      return {
        name: nameNode.text,
        kind: "type",
        line: node.startPosition.row + 1,
        exported,
      };
    }
    case "interface_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return null;
      return {
        name: nameNode.text,
        kind: "interface",
        line: node.startPosition.row + 1,
        exported,
      };
    }
    default:
      return null;
  }
}

function extractFunctionSignature(node: TreeSitterNode): string | null {
  const params = node.childForFieldName("parameters");
  const ret = node.childForFieldName("return_type");
  if (!params) return null;
  const sig = params.text + (ret ? `: ${ret.text}` : "");
  return sig;
}

function extractClassSignature(node: TreeSitterNode): string | null {
  // Heritage: `class X extends Y { ... }` — surface the extends.
  for (const child of node.namedChildren) {
    if (child.type === "class_heritage") {
      return child.text;
    }
  }
  return null;
}

// ── findDefinition ─────────────────────────────────────────────────

export interface FindDefinitionInput {
  outDir: string;
  name: string;
}

export interface DefinitionMatch {
  file: string;
  line: number;
  kind: SymbolInfo["kind"];
  exported: boolean;
  signature?: string;
}

export interface FindDefinitionResult {
  ok: boolean;
  matches?: DefinitionMatch[];
  error?: string;
}

export async function findDefinition(
  input: FindDefinitionInput,
): Promise<FindDefinitionResult> {
  const files = await enumerateSourceFiles(input.outDir);
  const matches: DefinitionMatch[] = [];
  for (const file of files) {
    const r = await listSymbolsInFile({ outDir: input.outDir, path: file });
    if (!r.ok || !r.symbols) continue;
    for (const sym of r.symbols) {
      if (sym.name === input.name) {
        matches.push({
          file,
          line: sym.line,
          kind: sym.kind,
          exported: sym.exported,
          ...(sym.signature ? { signature: sym.signature } : {}),
        });
      }
    }
  }
  return { ok: true, matches };
}

// ── findCallers ────────────────────────────────────────────────────

export interface FindCallersInput {
  outDir: string;
  name: string;
}

export interface CallerMatch {
  file: string;
  /** First line where the symbol appears as an identifier. */
  line: number;
  /** Tail of the line for context. Capped at ~120 chars. */
  snippet: string;
}

export interface FindCallersResult {
  ok: boolean;
  matches?: CallerMatch[];
  error?: string;
}

export async function findCallers(
  input: FindCallersInput,
): Promise<FindCallersResult> {
  const files = await enumerateSourceFiles(input.outDir);
  const matches: CallerMatch[] = [];
  for (const file of files) {
    const parsed = await parseFile(input.outDir, file);
    if (!parsed) continue;
    // Skip the file if it's the DEFINITION site (avoids
    // self-matches). A file is a caller iff it references the
    // symbol AND is not its declaration site.
    const isDefSite = isDefinitionSite(parsed.tree.rootNode, input.name);
    if (isDefSite) continue;
    // Walk the AST looking for IDENTIFIER nodes whose text
    // matches. This skips comments, string contents, etc. —
    // unlike a regex pass which would false-positive on every
    // mention of the name in a comment.
    const ref = findIdentifierReference(parsed.tree.rootNode, input.name);
    if (ref) {
      const lines = parsed.source.split(/\r?\n/);
      const lineIdx = ref.startPosition.row;
      const line = lines[lineIdx] ?? "";
      const snippet = line.length > 120 ? line.slice(0, 120) + "…" : line;
      matches.push({ file, line: lineIdx + 1, snippet: snippet.trim() });
    }
  }
  return { ok: true, matches };
}

/** Walk the AST DFS looking for an identifier-typed node whose
 *  text matches `name`. Returns the FIRST such node, or null
 *  when none exists. Tree-sitter tokenizes comments and string
 *  contents separately from identifiers, so this skips noise
 *  the regex approach would false-positive on. */
function findIdentifierReference(
  root: TreeSitterNode,
  name: string,
): TreeSitterNode | null {
  const stack: TreeSitterNode[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (
      (cur.type === "identifier" ||
        cur.type === "type_identifier" ||
        cur.type === "property_identifier") &&
      cur.text === name
    ) {
      return cur;
    }
    // children, NOT namedChildren — we may descend into anonymous
    // wrappers (export_statement, import_clause, etc.) and we
    // don't want to miss identifier descendants.
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i]!);
    }
  }
  return null;
}

function isDefinitionSite(root: TreeSitterNode, name: string): boolean {
  for (const child of root.namedChildren) {
    if (child.type === "export_statement") {
      for (const inner of child.namedChildren) {
        if (declaresSymbol(inner, name)) return true;
      }
    }
    if (declaresSymbol(child, name)) return true;
  }
  return false;
}

function declaresSymbol(node: TreeSitterNode, name: string): boolean {
  if (
    node.type === "function_declaration" ||
    node.type === "class_declaration" ||
    node.type === "type_alias_declaration" ||
    node.type === "interface_declaration"
  ) {
    const n = node.childForFieldName("name");
    if (n && n.text === name) return true;
  }
  if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  ) {
    for (const c of node.namedChildren) {
      if (c.type === "variable_declarator") {
        const n = c.childForFieldName("name");
        if (n && n.type === "identifier" && n.text === name) return true;
      }
    }
  }
  return false;
}

// ── findImportsOf ──────────────────────────────────────────────────

export interface FindImportsOfInput {
  outDir: string;
  modulePath: string;
}

export interface ImportMatch {
  file: string;
  line: number;
  /** The verbatim import line. */
  snippet: string;
}

export interface FindImportsOfResult {
  ok: boolean;
  matches?: ImportMatch[];
  error?: string;
}

export async function findImportsOf(
  input: FindImportsOfInput,
): Promise<FindImportsOfResult> {
  const files = await enumerateSourceFiles(input.outDir);
  const matches: ImportMatch[] = [];
  for (const file of files) {
    const parsed = await parseFile(input.outDir, file);
    if (!parsed) continue;
    for (const child of parsed.tree.rootNode.namedChildren) {
      if (child.type !== "import_statement") continue;
      const sourceNode = child.childForFieldName("source");
      if (!sourceNode) continue;
      const importedFrom = stripQuotes(sourceNode.text);
      if (importedFrom === input.modulePath) {
        matches.push({
          file,
          line: child.startPosition.row + 1,
          snippet: child.text.split("\n")[0] ?? child.text,
        });
        break;
      }
    }
  }
  return { ok: true, matches };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
