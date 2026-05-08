/**
 * Load a directory tree into an RPG.
 *
 * Walks `rootDir`, picks a language adapter per file via the registry,
 * and stitches the result into a single graph: folders form the
 * hierarchy spine, file nodes own their content, and AST nodes hang off
 * their owning file in source-declaration order. After every file is
 * parsed, a cross-file pass resolves import edges to file ids where it
 * can (relative imports) and leaves external/unresolved sources as
 * `toFile: null`.
 *
 * Caveats / known scope:
 *   - Path comparisons use POSIX semantics. The loader has not been
 *     exercised on Windows (`\\` separators) — paths are normalized
 *     through `path.sep`, but the ignore list and edge resolution use
 *     literal segment matching.
 *   - Cross-file class-name collisions (two `class Base` in different
 *     files) resolve `extends` to the first match in node-id-insertion
 *     order. The architect can refine in later phases.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  emptyRPG,
  type FolderNode,
  type FileNode,
  type NodeId,
  type RPG,
} from "./types.js";
import { getAdapterForFile, getRegisteredExtensions } from "./adapters/index.js";
import { resolveImportEdges, resolveInheritEdges } from "./resolve.js";

export interface LoadWarning {
  kind: "parse-error";
  /** Repo-relative path of the offending file. */
  path: string;
  message: string;
}

export interface LoadOptions {
  /** Path segments to skip. Each pattern matches a *full* path segment
   *  in the repo-relative path — substring matches are intentionally
   *  not supported, so `"build"` does not skip `"test-build"`. */
  ignore?: string[];
  /** Restrict to these extensions. Defaults to every registered
   *  adapter's extensions. */
  extensions?: string[];
  /** Called once per soft signal surfaced during parsing/loading.
   *  Currently emits `parse-error` when an adapter reports a tree-sitter
   *  error tree. The loader still records what it can extract. */
  onWarning?: (warning: LoadWarning) => void;
}

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".rlm-overlays",
];

function isIgnored(relPath: string, patterns: string[]): boolean {
  // Segment-equality only. Avoids the false positive where a pattern
  // like "build" would skip a folder named "test-build" or "unbuilt".
  const segments = relPath.split(path.sep);
  return patterns.some((p) => segments.includes(p));
}

function folderId(relPath: string): NodeId {
  return `folder:${relPath}`;
}

function fileId(relPath: string): NodeId {
  return `file:${relPath}`;
}

export async function loadRepo(
  rootDir: string,
  options: LoadOptions = {},
): Promise<RPG> {
  const absRoot = path.resolve(rootDir);
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const extensions = (options.extensions ?? getRegisteredExtensions()).map(
    (e) => e.toLowerCase(),
  );

  const rpg = emptyRPG();
  const filesByPath = new Map<string, FileNode>();
  const onWarning = options.onWarning;

  await walkDir(absRoot, "", rpg, ignore, extensions, filesByPath, onWarning);
  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);
  return rpg;
}

async function walkDir(
  absRoot: string,
  relDir: string,
  rpg: RPG,
  ignore: string[],
  extensions: string[],
  filesByPath: Map<string, FileNode>,
  onWarning: ((w: LoadWarning) => void) | undefined,
): Promise<void> {
  const folder = ensureFolder(rpg, relDir);
  const absDir = path.join(absRoot, relDir);
  const entries = await readdir(absDir);
  entries.sort();
  for (const entry of entries) {
    const relPath = relDir ? path.join(relDir, entry) : entry;
    if (isIgnored(relPath, ignore)) continue;
    const absPath = path.join(absRoot, relPath);
    const stats = await stat(absPath);
    if (stats.isDirectory()) {
      await walkDir(absRoot, relPath, rpg, ignore, extensions, filesByPath, onWarning);
      continue;
    }
    if (!stats.isFile()) continue;
    const ext = path.extname(entry).toLowerCase();
    if (!extensions.includes(ext)) continue;
    const content = await readFile(absPath, "utf-8");
    const fileNode = loadFile(rpg, relPath, content, onWarning);
    folder.children.push(fileNode.id);
    filesByPath.set(relPath, fileNode);
  }
}

function ensureFolder(rpg: RPG, relPath: string): FolderNode {
  if (relPath === "") {
    return rpg.nodes[rpg.rootId] as FolderNode;
  }
  const id = folderId(relPath);
  const existing = rpg.nodes[id];
  if (existing && existing.kind === "folder") return existing;
  const parentRel = path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolder(rpg, parentRel);
  const node: FolderNode = {
    id,
    kind: "folder",
    name: path.basename(relPath),
    parent: parent.id,
    children: [],
    features: [],
    path: relPath,
  };
  rpg.nodes[id] = node;
  parent.children.push(id);
  return node;
}

function loadFile(
  rpg: RPG,
  relPath: string,
  content: string,
  onWarning: ((w: LoadWarning) => void) | undefined,
): FileNode {
  const id = fileId(relPath);
  const adapter = getAdapterForFile(relPath);
  const parentDir = path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const parent = ensureFolder(rpg, parentDir);
  const fileNode: FileNode = {
    id,
    kind: "file",
    name: path.basename(relPath),
    parent: parent.id,
    children: [],
    features: [],
    path: relPath,
    content,
    language: adapter?.language ?? null,
    rawImports: [],
    exports: [],
  };
  rpg.nodes[id] = fileNode;
  if (!adapter) return fileNode;

  const extracted = adapter.extract({ fileId: id, filePath: relPath, source: content });
  fileNode.rawImports = extracted.imports;
  fileNode.exports = extracted.exports;

  // Source-order children: walk `topLevel` (the adapter's ordered
  // class+function stream) and append in declaration order.
  for (const entry of extracted.topLevel) {
    rpg.nodes[entry.id] = entry;
    fileNode.children.push(entry.id);
  }
  // Methods aren't file children — they live under their class. The
  // adapter has already wired them into the owning class's `children`
  // array, but we still need them in the global node map.
  for (const method of extracted.methods) {
    rpg.nodes[method.id] = method;
  }

  if (extracted.warnings && onWarning) {
    for (const w of extracted.warnings) {
      onWarning({ kind: w.kind, path: relPath, message: w.message });
    }
  }
  return fileNode;
}

// Cross-file edge resolution lives in `./resolve.ts` so Phase 2 edit
// tools can re-run it after splicing without re-walking the disk.
