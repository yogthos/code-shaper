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
import type { FileNode, RPG } from "../rpg/types.js";
import { renderTypeScriptFile } from "./render.js";

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

export type ReadFileResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

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
