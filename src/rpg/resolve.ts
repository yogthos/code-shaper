/**
 * Cross-file edge resolution.
 *
 * Extracted from `load.ts` so it can be reused by Phase 2 edit tools:
 * after any edit that changes a file's imports or class hierarchy, we
 * re-run resolution against the post-edit RPG and replace the edge
 * arrays. The functions are pure with respect to the input — they read
 * the current node map and return fresh edge arrays — so callers can
 * choose whether to mutate `rpg.imports` / `rpg.inherits` in place or
 * compare against a snapshot for diffing.
 */

import path from "node:path";
import { getRegisteredExtensions } from "./adapters/index.js";
import type {
  FileNode,
  ImportEdge,
  InheritsEdge,
  NodeId,
  RPG,
  RPGNode,
} from "./types.js";

export function resolveImportEdges(rpg: RPG): ImportEdge[] {
  const filesByPath = indexFilesByPath(rpg);
  const edges: ImportEdge[] = [];
  for (const node of Object.values(rpg.nodes) as RPGNode[]) {
    if (node.kind !== "file") continue;
    for (const imp of node.rawImports) {
      const resolved = resolveImportSpecifier(node.path, imp.source, filesByPath);
      edges.push({
        fromFile: node.id,
        toFile: resolved?.id ?? null,
        source: imp.source,
        name: imp.name,
      });
    }
  }
  return edges;
}

export function resolveInheritEdges(rpg: RPG): InheritsEdge[] {
  // Cross-file class-name collisions resolve to the first match in
  // node-id-insertion order. Tolerable: the architect can refine, and
  // every edge keeps its `baseName` so diagnostics see the original
  // intent.
  const classByName = new Map<string, NodeId[]>();
  for (const node of Object.values(rpg.nodes) as RPGNode[]) {
    if (node.kind !== "class") continue;
    const list = classByName.get(node.name) ?? [];
    list.push(node.id);
    classByName.set(node.name, list);
  }
  const edges: InheritsEdge[] = [];
  for (const node of Object.values(rpg.nodes) as RPGNode[]) {
    if (node.kind !== "class") continue;
    for (const baseName of node.extendsNames) {
      const matches = classByName.get(baseName) ?? [];
      const targetId = matches[0] ?? null;
      edges.push({ fromClass: node.id, toClass: targetId, baseName });
    }
  }
  return edges;
}

function indexFilesByPath(rpg: RPG): Map<string, FileNode> {
  const out = new Map<string, FileNode>();
  for (const node of Object.values(rpg.nodes) as RPGNode[]) {
    if (node.kind === "file") out.set(node.path, node);
  }
  return out;
}

function resolveImportSpecifier(
  importingFilePath: string,
  source: string,
  filesByPath: Map<string, FileNode>,
): FileNode | null {
  if (!source.startsWith(".")) return null;
  const importerDir = path.dirname(importingFilePath);
  const candidatePath = path.normalize(path.join(importerDir, source));
  for (const cand of expandSpecifierCandidates(candidatePath)) {
    const file = filesByPath.get(cand);
    if (file) return file;
  }
  return null;
}

function expandSpecifierCandidates(base: string): string[] {
  // Try each registered adapter extension appended directly, then
  // `index.<ext>` inside a directory of the same name. We don't try the
  // literal `base` — `filesByPath` only indexes parsed source files
  // (which always have a known extension), so a bare specifier can
  // never match the literal path. `.js`-suffixed specifiers are
  // rewritten to their TS-family counterparts: TypeScript code
  // conventionally imports its emitted output names (`./util.js`), but
  // the source file on disk is `./util.ts`.
  const out: string[] = [];
  const exts = getRegisteredExtensions();
  for (const ext of exts) {
    out.push(`${base}${ext}`);
    if (base.endsWith(".js")) {
      out.push(`${base.slice(0, -3)}${ext}`);
    }
  }
  for (const ext of exts) {
    out.push(path.join(base, `index${ext}`));
  }
  return out;
}
