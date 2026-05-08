/**
 * Step 1 of the agentic dev-loop refactor — read-only tools.
 *
 * Two pure-function primitives the body-author agent uses to gain
 * cross-file visibility before editing:
 *
 *   listFilesTool — every FileNode in the RPG with a path, planned
 *     leaf names, and a short summary. The agent uses this to find
 *     out where a referenced symbol might live.
 *
 *   readFileTool — rendered content of one file, reflecting the
 *     CURRENT bodyByLeafId / testsByLeafId state. This is the same
 *     view the test harness sees, so the agent can confirm what
 *     code is actually being compiled.
 *
 * Why we keep these as pure functions over (rpg, bodyByLeafId,
 * testsByLeafId) instead of going through outDir on disk: the
 * agent's view should match what the renderer + harness sees, not
 * the last-materialized state. With incremental materialize the
 * two are usually in sync, but during a multi-turn session the
 * agent may make several edits before the next disk write —
 * reading from the in-memory render keeps the loop honest.
 */

import { isFile } from "../rpg/types.js";
import type { FileNode, PlannedInterface, RPG } from "../rpg/types.js";
import { renderTypeScriptFile } from "./render.js";
import {
  checkTypescriptSyntax,
  extractFunctionBody,
  extractMethodBody,
} from "./edit-tools.js";

// ── listFilesTool ────────────────────────────────────────────────────

export interface ListFilesInput {
  rpg: RPG;
}

export interface ListedFile {
  /** Repo-relative path. */
  path: string;
  /** Names of leaves planned in this file (function/method names).
   *  Empty for files without an `interfacePlan` (existing-content
   *  files in extend-mode runs). */
  plannedLeaves: string[];
  /** Symbol names exported by this file. Sourced from the
   *  FileNode's `exports` (parser-extracted) when present, otherwise
   *  derived from the planned interface entries. */
  exports: string[];
  /** Short, single-line summary so the agent can scan the file
   *  list. Derived from the file's leading docstring/comment when
   *  the file has content, or from the first leaf's description
   *  when the file is still in plan-stub state. Empty when neither
   *  source produces anything. */
  summary: string;
}

export interface ListFilesResult {
  files: ListedFile[];
}

export function listFilesTool(input: ListFilesInput): ListFilesResult {
  const files: ListedFile[] = [];
  for (const node of Object.values(input.rpg.nodes)) {
    if (!isFile(node)) continue;
    files.push({
      path: node.path,
      plannedLeaves: (node.interfacePlan?.entries ?? []).map((e) => e.name),
      exports: derivedExports(node),
      summary: deriveSummary(node),
    });
  }
  // Stable order so the agent's view doesn't shuffle between
  // iterations.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

function derivedExports(file: FileNode): string[] {
  if (file.exports && file.exports.length > 0) return [...file.exports];
  // Fall back to plan-derived names. PlannedInterface.exported
  // tells us whether the symbol will be exported once
  // implemented.
  const planned = file.interfacePlan?.entries ?? [];
  const names = planned.filter((e) => e.exported).map((e) => e.name);
  // Add planned class names too — they're declared in
  // `interfacePlan.classes` and exported when used externally.
  const classes = file.interfacePlan?.classes ?? [];
  for (const c of classes) {
    if (c.exported) names.push(c.name);
  }
  return names;
}

function deriveSummary(file: FileNode): string {
  // Try the leading docstring/comment of existing content first.
  if (file.content && file.content.length > 0) {
    const fromContent = extractLeadingDoc(file.content);
    if (fromContent) return fromContent;
  }
  // Fall back to the first planned leaf's description, single-line.
  const firstLeaf = file.interfacePlan?.entries?.[0];
  if (firstLeaf?.description) {
    return oneLine(firstLeaf.description);
  }
  return "";
}

/** Pull the first JSDoc-style block (slash-star-star ... star-slash),
 *  or the first run of slash-slash line comments, into a one-line
 *  summary. Cheap parse, no tree-sitter — keeps the tool a hot path. */
function extractLeadingDoc(source: string): string | null {
  const trimmed = source.replace(/^\s+/, "");
  // /** ... */ (JSDoc-style)
  const jsdoc = /^\/\*\*([\s\S]*?)\*\//.exec(trimmed);
  if (jsdoc && jsdoc[1]) {
    const body = jsdoc[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter((l) => l.length > 0)
      .join(" ");
    return oneLine(body);
  }
  // /* ... */ (block comment)
  const block = /^\/\*([\s\S]*?)\*\//.exec(trimmed);
  if (block && block[1]) return oneLine(block[1]);
  // Run of // line comments at the top.
  const lines = trimmed.split("\n");
  const linePrefixed: string[] = [];
  for (const line of lines) {
    const m = /^\s*\/\/\s?(.*)$/.exec(line);
    if (!m) break;
    linePrefixed.push(m[1] ?? "");
  }
  if (linePrefixed.length > 0) return oneLine(linePrefixed.join(" "));
  return null;
}

function oneLine(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  // Cap length so the file list stays scannable in the model's
  // context window.
  return collapsed.length > 120 ? collapsed.slice(0, 117) + "…" : collapsed;
}

// ── readFileTool ─────────────────────────────────────────────────────

export interface ReadFileInput {
  rpg: RPG;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
  path: string;
}

export interface ReadFileResult {
  ok: boolean;
  /** Set on success — the rendered (or raw, for extend-mode files)
   *  content of the requested path. */
  content?: string;
  /** Set on failure — explanation including, when relevant, the
   *  list of available paths so the model can correct its query. */
  error?: string;
}

export function readFileTool(input: ReadFileInput): ReadFileResult {
  // Reject path-traversal up front. Repo-relative paths are
  // canonical here — anything else (`..`, `/abs/...`) is invalid.
  if (
    input.path.length === 0 ||
    input.path.startsWith("/") ||
    input.path.split("/").includes("..")
  ) {
    return {
      ok: false,
      error: `path must be a repo-relative path (no leading "/" or ".." segments). Got ${JSON.stringify(input.path)}`,
    };
  }
  const file = findFileByPath(input.rpg, input.path);
  if (!file) {
    const available = listAvailablePaths(input.rpg);
    const suggestion =
      available.length > 0
        ? ` Available: ${available.slice(0, 20).join(", ")}${available.length > 20 ? ", …" : ""}.`
        : "";
    return {
      ok: false,
      error: `path ${JSON.stringify(input.path)} is not in the project (no such file in the RPG).${suggestion}`,
    };
  }
  // Files with an interfacePlan render through the
  // bodyByLeafId-aware renderer. Files without (extend-mode) just
  // return their existing content verbatim.
  if (file.interfacePlan) {
    const content = renderTypeScriptFile({
      file,
      bodyByLeafId: input.bodyByLeafId,
      rpg: input.rpg,
    });
    return { ok: true, content };
  }
  return { ok: true, content: file.content };
}

function findFileByPath(rpg: RPG, target: string): FileNode | null {
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node) && node.path === target) return node;
  }
  return null;
}

function listAvailablePaths(rpg: RPG): string[] {
  const paths: string[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node)) paths.push(node.path);
  }
  paths.sort();
  return paths;
}

// ── editFileTool ─────────────────────────────────────────────────────

export interface EditFileInput {
  rpg: RPG;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
  /** Path of the file the active leaf belongs to. The model can
   *  ONLY edit this file — other files are read-only via
   *  readFileTool. Same scoping discipline as the §D.2 tools. */
  activeFilePath: string;
  /** Capability id of the leaf currently being implemented. After
   *  a successful edit we extract its body via tree-sitter and
   *  write it back to bodyByLeafId so subsequent renders + tests
   *  see the new code. */
  activeLeafId: string;
  /** Path the agent supplied in the tool call. Must equal
   *  activeFilePath for the edit to be accepted. */
  path: string;
  old_str: string;
  new_str: string;
}

export interface EditFileResult {
  ok: boolean;
  /** Set on success — full rendered source after the replacement. */
  newContent?: string;
  /** Set on success — the body extracted for the active leaf and
   *  written into bodyByLeafId. */
  extractedBody?: string;
  error?: string;
}

export function editFileTool(input: EditFileInput): EditFileResult {
  // Path validation: same path-traversal rules as readFileTool.
  if (
    input.path.length === 0 ||
    input.path.startsWith("/") ||
    input.path.split("/").includes("..")
  ) {
    return {
      ok: false,
      error: `path must be a repo-relative path (no leading "/" or ".." segments). Got ${JSON.stringify(input.path)}`,
    };
  }
  // Path-existence check fires FIRST so the model gets a "not in
  // project" error (with a helpful suggestion list) rather than a
  // misleading "out of scope" error for paths that simply don't
  // exist.
  const file = findFileByPath(input.rpg, input.path);
  if (!file) {
    const available = listAvailablePaths(input.rpg);
    const suggestion =
      available.length > 0
        ? ` Available: ${available.slice(0, 20).join(", ")}${available.length > 20 ? ", …" : ""}.`
        : "";
    return {
      ok: false,
      error: `path ${JSON.stringify(input.path)} is not in the project (no such file in the RPG).${suggestion}`,
    };
  }
  // Active-file scoping. Other files are read-only — keeps multi-
  // leaf builds reproducible and prevents the model from
  // accidentally rewriting a sibling's source mid-leaf.
  if (input.path !== input.activeFilePath) {
    return {
      ok: false,
      error: `editFileTool can only edit the active leaf's host file (${JSON.stringify(input.activeFilePath)}). Got ${JSON.stringify(input.path)}. Use readFileTool to inspect other files; they are read-only.`,
    };
  }
  if (typeof input.old_str !== "string" || typeof input.new_str !== "string") {
    return {
      ok: false,
      error: "old_str and new_str must both be strings",
    };
  }
  if (input.old_str === input.new_str) {
    return {
      ok: false,
      error: "old_str and new_str are identical — edit would be a no-op. They must differ.",
    };
  }
  // Render current state so the agent's edit is applied to the
  // SAME view it would have read via readFileTool.
  const currentSource = file.interfacePlan
    ? renderTypeScriptFile({
        file,
        bodyByLeafId: input.bodyByLeafId,
        rpg: input.rpg,
      })
    : file.content;
  const matchCount = countOccurrences(currentSource, input.old_str);
  if (matchCount === 0) {
    return {
      ok: false,
      error: `old_str not found in ${JSON.stringify(input.path)}. Make sure you copied it from the file's CURRENT content (not from a prior version). Use readFileTool to refresh your view.`,
    };
  }
  if (matchCount > 1) {
    return {
      ok: false,
      error: `old_str matches ${matchCount} places in ${JSON.stringify(input.path)} — ambiguous. Add more context (a few surrounding lines) to disambiguate so the replacement is unambiguous.`,
    };
  }
  const newContent =
    currentSource.slice(0, currentSource.indexOf(input.old_str)) +
    input.new_str +
    currentSource.slice(currentSource.indexOf(input.old_str) + input.old_str.length);
  const syntax = checkTypescriptSyntax(newContent);
  if (!syntax.ok) {
    return { ok: false, error: `resulting source: ${syntax.error}` };
  }
  // Body extraction: the active leaf's body must still be findable
  // in the new source. Otherwise the next render won't know what
  // to splice in for that leaf — silently breaking the test loop.
  const leaf = findPlannedLeaf(file, input.activeLeafId);
  if (!leaf) {
    return {
      ok: false,
      error: `internal: active leaf ${JSON.stringify(input.activeLeafId)} not found in file ${JSON.stringify(input.path)}'s interfacePlan. (Tool is being called outside its expected context.)`,
    };
  }
  const extractedBody = extractBodyForLeaf(newContent, leaf);
  if (extractedBody === null) {
    return {
      ok: false,
      error: leaf.kind === "method"
        ? `resulting source no longer has a method ${JSON.stringify(`${leaf.ownerClassName}.${leaf.name}`)} that the body extractor can find. Don't rename or remove the method when editing — only modify its body.`
        : `resulting source no longer has a function named ${JSON.stringify(leaf.name)} that the body extractor can find. Don't rename or remove the function when editing — only modify its body.`,
    };
  }
  // Commit: write the extracted body back into bodyByLeafId so the
  // next render + test run sees the model's edit.
  input.bodyByLeafId.set(input.activeLeafId, extractedBody);
  return { ok: true, newContent, extractedBody };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

function findPlannedLeaf(file: FileNode, leafId: string): PlannedInterface | null {
  for (const e of file.interfacePlan?.entries ?? []) {
    if (e.leafCapabilityId === leafId) return e;
  }
  return null;
}

function extractBodyForLeaf(source: string, leaf: PlannedInterface): string | null {
  if (leaf.kind === "method") {
    if (!leaf.ownerClassName) return null;
    return extractMethodBody(source, leaf.ownerClassName, leaf.name);
  }
  return extractFunctionBody(source, leaf.name);
}
