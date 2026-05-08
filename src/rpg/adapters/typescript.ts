/**
 * TypeScript language adapter. Handles `.ts`, `.tsx`, `.mts`, `.cts`.
 *
 * Re-entrancy contract: each `extract()` call instantiates its own
 * tree-sitter `Parser`. The parser type comes from the native
 * `tree-sitter` package (CJS). Construction is cheap; making it
 * per-call rules out the singleton state-mutation hazard where two
 * concurrent extractions for `typescript` and `tsx` could interleave
 * a `setLanguage` against an in-progress `parse`. The grammar objects
 * themselves are cached at module scope.
 */

import { createRequire } from "node:module";

import type {
  LanguageAdapter,
  ExtractedFile,
  ExtractWarning,
} from "./types.js";
import type {
  ClassNode,
  FunctionNode,
  MethodNode,
  NodeId,
  RawImport,
} from "../types.js";

const require = createRequire(import.meta.url);

const languageCache = new Map<string, any>();

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};

function loadLanguage(language: string): any | null {
  const cached = languageCache.get(language);
  if (cached) return cached;
  const mod = require("tree-sitter-typescript");
  const lang = mod[language];
  if (!lang) return null;
  languageCache.set(language, lang);
  return lang;
}

function newParser(): any {
  const Parser = require("tree-sitter");
  return new Parser();
}

function pickLanguage(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

interface Pos {
  row: number;
  column: number;
}

interface Ctx {
  fileId: NodeId;
  source: string;
  /** Top-level classes + functions in source order. Methods nest under
   *  their class node and are *also* tracked in `methods` so the loader
   *  can populate the global node map. */
  topLevel: Array<ClassNode | FunctionNode>;
  methods: MethodNode[];
  imports: RawImport[];
  exportedNames: Set<string>;
}

function astId(fileId: NodeId, kind: string, name: string, line: number): NodeId {
  return `${kind}:${fileId}#${name}@${line}`;
}

function methodId(classId: NodeId, name: string, line: number): NodeId {
  return `method:${classId}#${name}@${line}`;
}

function makeRange(
  startByte: number,
  endByte: number,
  startPos: Pos,
  endPos: Pos,
) {
  return {
    byteRange: { start: startByte, end: endByte },
    lineRange: { start: startPos.row + 1, end: endPos.row + 1 },
  };
}

export const typescriptAdapter: LanguageAdapter = {
  language: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  extract({ fileId, filePath, source }): ExtractedFile {
    const language = pickLanguage(filePath);
    if (!language) return emptyExtraction();
    const lang = loadLanguage(language);
    if (!lang) return emptyExtraction();
    const parser = newParser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);

    const ctx: Ctx = {
      fileId,
      source,
      topLevel: [],
      methods: [],
      imports: [],
      exportedNames: new Set(),
    };
    walkTopLevel(tree.rootNode, ctx, /*exported*/ false);
    for (const entry of ctx.topLevel) {
      if (entry.kind !== "function") continue;
      if (ctx.exportedNames.has(entry.name)) entry.exported = true;
    }

    const warnings: ExtractWarning[] = [];
    if (tree.rootNode.hasError) {
      warnings.push({
        kind: "parse-error",
        message: `tree-sitter reported error nodes while parsing ${filePath}`,
      });
    }

    return {
      topLevel: ctx.topLevel,
      methods: ctx.methods,
      imports: ctx.imports,
      exports: Array.from(ctx.exportedNames),
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};

function emptyExtraction(): ExtractedFile {
  return {
    topLevel: [],
    methods: [],
    imports: [],
    exports: [],
  };
}

function walkTopLevel(node: any, ctx: Ctx, exportedScope: boolean): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    visitTopLevelChild(child, ctx, exportedScope);
  }
}

/** Find the wrapped declaration inside an `export_statement` and emit it
 *  with the export_statement's byte range. The declaration's identifier
 *  goes into `exportedNames` so the post-walk pass can stamp
 *  `FunctionNode.exported = true`. */
function walkExportedDeclaration(exportNode: any, ctx: Ctx): void {
  for (let i = 0; i < exportNode.childCount; i++) {
    const child = exportNode.child(i);
    if (!child) continue;
    if (child.type === "function_declaration") {
      handleFunctionDeclaration(child, ctx, /*exported*/ true, exportNode);
      return;
    }
    if (child.type === "class_declaration") {
      handleClassDeclaration(child, ctx, /*exported*/ true, exportNode);
      return;
    }
    if (
      child.type === "lexical_declaration" ||
      child.type === "variable_declaration"
    ) {
      handleVariableDeclaration(child, ctx, /*exported*/ true, exportNode);
      return;
    }
  }
}

function visitTopLevelChild(node: any, ctx: Ctx, exportedScope: boolean): void {
  switch (node.type) {
    case "import_statement":
      handleImport(node, ctx);
      return;
    case "export_statement": {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        // `export { x } from './y'` — record bindings as raw imports so
        // the cross-file edge resolver sees them; do not flag as exports
        // of *this* file (they're forwards, not declarations).
        const source = stripQuotes(sourceNode.text);
        const clause = findChild(node, "export_clause");
        if (clause) {
          for (let j = 0; j < clause.childCount; j++) {
            const spec = clause.child(j);
            if (spec?.type !== "export_specifier") continue;
            const name = spec.childForFieldName("name")?.text;
            if (name) ctx.imports.push({ name, source, isDefault: false });
          }
        }
        return;
      }
      const clause = findChild(node, "export_clause");
      if (clause) {
        for (let j = 0; j < clause.childCount; j++) {
          const spec = clause.child(j);
          if (spec?.type !== "export_specifier") continue;
          const name = spec.childForFieldName("name")?.text;
          if (name) ctx.exportedNames.add(name);
        }
      }
      // Inline exported declarations (`export function f`, `export class C`,
      // `export const f = …`): record them with the byte range of the
      // *export_statement* so edits include the `export` keyword. Without
      // this, splicing a new `export function f` over the function's own
      // range would duplicate the keyword.
      walkExportedDeclaration(node, ctx);
      return;
    }
    case "function_declaration":
      handleFunctionDeclaration(node, ctx, exportedScope);
      return;
    case "class_declaration":
      handleClassDeclaration(node, ctx, exportedScope);
      return;
    case "lexical_declaration":
    case "variable_declaration":
      handleVariableDeclaration(node, ctx, exportedScope);
      return;
    default:
      if (
        node.type === "ambient_declaration" ||
        node.type === "internal_module" ||
        node.type === "module"
      ) {
        walkTopLevel(node, ctx, exportedScope);
      }
      return;
  }
}

function handleImport(node: any, ctx: Ctx): void {
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return;
  const source = stripQuotes(sourceNode.text);
  const clause = findChild(node, "import_clause");
  if (!clause) {
    ctx.imports.push({ name: "", source, isDefault: false });
    return;
  }
  for (let i = 0; i < clause.childCount; i++) {
    const child = clause.child(i);
    if (!child) continue;
    if (child.type === "identifier") {
      ctx.imports.push({ name: child.text, source, isDefault: true });
    } else if (child.type === "named_imports") {
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j);
        if (spec?.type !== "import_specifier") continue;
        const aliasNode = spec.childForFieldName("alias");
        const nameNode = spec.childForFieldName("name");
        const localName = (aliasNode ?? nameNode)?.text;
        if (localName) {
          ctx.imports.push({ name: localName, source, isDefault: false });
        }
      }
    } else if (child.type === "namespace_import") {
      const idNode = findChild(child, "identifier");
      if (idNode) {
        ctx.imports.push({ name: idNode.text, source, isDefault: false });
      }
    }
  }
}

function handleFunctionDeclaration(
  node: any,
  ctx: Ctx,
  exportedScope: boolean,
  rangeNode: any = node,
): void {
  const name = node.childForFieldName("name")?.text;
  if (!name) return;
  const range = makeRange(
    rangeNode.startIndex,
    rangeNode.endIndex,
    rangeNode.startPosition,
    rangeNode.endPosition,
  );
  // The id encodes `range.start` (the *visible* start including any
  // wrapping `export` keyword) so id.line and lineRange.start agree.
  const id = astId(ctx.fileId, "function", name, range.lineRange.start);
  const fn: FunctionNode = {
    id,
    kind: "function",
    name,
    parent: ctx.fileId,
    children: [],
    features: [],
    file: ctx.fileId,
    byteRange: range.byteRange,
    lineRange: range.lineRange,
    exported: exportedScope,
  };
  ctx.topLevel.push(fn);
  if (exportedScope) ctx.exportedNames.add(name);
}

function handleClassDeclaration(
  node: any,
  ctx: Ctx,
  exportedScope: boolean,
  rangeNode: any = node,
): void {
  const name = node.childForFieldName("name")?.text;
  if (!name) return;
  const range = makeRange(
    rangeNode.startIndex,
    rangeNode.endIndex,
    rangeNode.startPosition,
    rangeNode.endPosition,
  );
  const id = astId(ctx.fileId, "class", name, range.lineRange.start);
  const extendsNames: string[] = [];
  const heritage = findChild(node, "class_heritage");
  if (heritage) {
    for (let i = 0; i < heritage.childCount; i++) {
      const child = heritage.child(i);
      if (child?.type === "extends_clause") {
        for (let j = 0; j < child.childCount; j++) {
          const expr = child.child(j);
          if (!expr) continue;
          if (expr.type === "identifier" || expr.type === "type_identifier") {
            extendsNames.push(expr.text);
          }
        }
      }
    }
  }
  const classNode: ClassNode = {
    id,
    kind: "class",
    name,
    parent: ctx.fileId,
    children: [],
    features: [],
    file: ctx.fileId,
    byteRange: range.byteRange,
    lineRange: range.lineRange,
    extendsNames,
  };
  ctx.topLevel.push(classNode);
  if (exportedScope) ctx.exportedNames.add(name);

  const body = node.childForFieldName("body");
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i);
      if (!member) continue;
      if (
        member.type === "method_definition" ||
        member.type === "method_signature"
      ) {
        handleMethod(member, classNode, ctx);
      }
    }
  }
}

function handleMethod(node: any, owner: ClassNode, ctx: Ctx): void {
  const name = node.childForFieldName("name")?.text;
  if (!name) return;
  const range = makeRange(
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
  );
  const id = methodId(owner.id, name, node.startPosition.row + 1);
  let isStatic = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === "static") {
      isStatic = true;
      break;
    }
  }
  const method: MethodNode = {
    id,
    kind: "method",
    name,
    parent: owner.id,
    children: [],
    features: [],
    file: ctx.fileId,
    byteRange: range.byteRange,
    lineRange: range.lineRange,
    ownerClass: owner.id,
    isStatic,
  };
  ctx.methods.push(method);
  owner.children.push(method.id);
}

function handleVariableDeclaration(
  node: any,
  ctx: Ctx,
  exportedScope: boolean,
  rangeNode: any = node,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const decl = node.child(i);
    if (decl?.type !== "variable_declarator") continue;
    const nameNode = decl.childForFieldName("name");
    const valueNode = decl.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    if (nameNode.type !== "identifier") continue;
    if (
      valueNode.type !== "arrow_function" &&
      valueNode.type !== "function_expression" &&
      valueNode.type !== "function"
    ) {
      continue;
    }
    const name = nameNode.text;
    const range = makeRange(
      rangeNode.startIndex,
      rangeNode.endIndex,
      rangeNode.startPosition,
      rangeNode.endPosition,
    );
    const id = astId(ctx.fileId, "function", name, range.lineRange.start);
    const fn: FunctionNode = {
      id,
      kind: "function",
      name,
      parent: ctx.fileId,
      children: [],
      features: [],
      file: ctx.fileId,
      byteRange: range.byteRange,
      lineRange: range.lineRange,
      exported: exportedScope,
    };
    ctx.topLevel.push(fn);
    if (exportedScope) ctx.exportedNames.add(name);
  }
}

function findChild(node: any, type: string): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

function stripQuotes(text: string): string {
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith("`") && text.endsWith("`")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
