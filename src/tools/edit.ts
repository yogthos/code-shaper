/**
 * AST edit tools. Each tool takes the RPG, locates the target node by
 * symbolic name, splices the supplied source over that node's byte
 * range, then re-extracts the file. Parse errors trigger a full revert
 * — the RPG and `FileNode.content` come back unchanged.
 *
 * Persistence stays decoupled: edits mutate the in-memory RPG only.
 * Callers materialize to disk via `materializeRPG()` when ready.
 *
 * Mirrors the four primitives the paper specifies (Appendix D.2):
 *   - edit_function_in_file
 *   - edit_method_of_class_in_file
 *   - edit_whole_class_in_file
 *   - edit_imports_and_assignments_in_file
 */

import type { ByteRange, FileNode, RPG } from "../rpg/types.js";
import {
  locateClass,
  locateFile,
  locateFunction,
  locateMethod,
} from "./locate.js";
import { refreshFile } from "./refresh.js";
import { fail, ok, type EditApplied, type ToolResult } from "./types.js";

export interface EditFunctionRequest {
  filePath: string;
  functionName: string;
  /** Replacement source — the entire function declaration including
   *  signature and (when applicable) `export`. The edit replaces the
   *  byte range that originally spanned the function declaration. */
  newSource: string;
}

export interface EditMethodRequest {
  filePath: string;
  className: string;
  methodName: string;
  newSource: string;
}

export interface EditClassRequest {
  filePath: string;
  className: string;
  newSource: string;
}

export interface EditImportsRequest {
  filePath: string;
  /** Replacement source for the imports + leading top-level
   *  assignments block. The edit replaces the prefix of the file
   *  ending at the start of the first class/function declaration.
   *  When the file has no declarations, the entire file is replaced. */
  newSource: string;
}

export function editFunctionInFile(
  rpg: RPG,
  req: EditFunctionRequest,
): ToolResult<EditApplied> {
  const fileResult = locateFile(rpg, req.filePath);
  if (!fileResult.ok) return fileResult;
  const file = fileResult.value;

  const fnResult = locateFunction(rpg, file, req.functionName);
  if (!fnResult.ok) return fnResult;

  return applyByteEdit(rpg, file, fnResult.value.byteRange, req.newSource);
}

export function editMethodOfClassInFile(
  rpg: RPG,
  req: EditMethodRequest,
): ToolResult<EditApplied> {
  const fileResult = locateFile(rpg, req.filePath);
  if (!fileResult.ok) return fileResult;
  const file = fileResult.value;

  const classResult = locateClass(rpg, file, req.className);
  if (!classResult.ok) return classResult;

  const methodResult = locateMethod(rpg, classResult.value, req.methodName);
  if (!methodResult.ok) return methodResult;

  return applyByteEdit(rpg, file, methodResult.value.byteRange, req.newSource);
}

export function editWholeClassInFile(
  rpg: RPG,
  req: EditClassRequest,
): ToolResult<EditApplied> {
  const fileResult = locateFile(rpg, req.filePath);
  if (!fileResult.ok) return fileResult;
  const file = fileResult.value;

  const classResult = locateClass(rpg, file, req.className);
  if (!classResult.ok) return classResult;

  return applyByteEdit(rpg, file, classResult.value.byteRange, req.newSource);
}

export function editImportsAndAssignmentsInFile(
  rpg: RPG,
  req: EditImportsRequest,
): ToolResult<EditApplied> {
  const fileResult = locateFile(rpg, req.filePath);
  if (!fileResult.ok) return fileResult;
  const file = fileResult.value;

  const range = importsRange(rpg, file);
  return applyByteEdit(rpg, file, range, req.newSource);
}

/**
 * Byte range covering the imports + assignments prefix.
 *
 *   `[0, firstDeclStart)` where `firstDeclStart` is the start byte of
 *   the first class or function declaration in the file.
 *
 *   For declarationless files (pure-imports modules, type-only
 *   barrels, top-level scripts, etc.) the range covers the entire
 *   file. That's intentional: those files are 100% "imports and
 *   assignments" by definition, so an edit through this tool replaces
 *   them in full.
 */
function importsRange(rpg: RPG, file: FileNode): ByteRange {
  let firstStart = file.content.length;
  for (const childId of file.children) {
    const child = rpg.nodes[childId];
    if (!child) continue;
    if (child.kind !== "class" && child.kind !== "function") continue;
    if (child.byteRange.start < firstStart) {
      firstStart = child.byteRange.start;
    }
  }
  return { start: 0, end: firstStart };
}

function applyByteEdit(
  rpg: RPG,
  file: FileNode,
  range: ByteRange,
  newSource: string,
): ToolResult<EditApplied> {
  if (
    range.start < 0 ||
    range.end > file.content.length ||
    range.start > range.end
  ) {
    return fail(
      "INVALID_REQUEST",
      `byte range [${range.start}, ${range.end}) out of bounds for ${file.path} (length ${file.content.length})`,
    );
  }

  const before = file.content.slice(0, range.start);
  const after = file.content.slice(range.end);
  const previousContent = file.content;

  file.content = before + newSource + after;
  const result = refreshFile(rpg, file);

  if (result.status === "parse-error") {
    // Revert: restore content, then refresh again so the RPG returns
    // to its pre-edit shape. The second refresh is on known-good
    // content; if it fails the file was already broken before the
    // edit and we propagate that.
    file.content = previousContent;
    refreshFile(rpg, file);
    return fail(
      "PARSE_ERROR",
      `edit rejected: ${result.message ?? "tree-sitter reported error nodes"}`,
    );
  }
  if (result.status === "no-adapter") {
    // Reachable only if a FileNode was added bypassing loadRepo (the
    // dir walker filters by registered extensions). Restore content;
    // re-running refreshFile would just return no-adapter again.
    file.content = previousContent;
    return fail(
      "UNSUPPORTED_LANGUAGE",
      `no language adapter for ${file.path}`,
    );
  }

  return ok({
    filePath: file.path,
    newRange: { start: range.start, end: range.start + newSource.length },
    removed: result.removed,
    added: result.added,
  });
}
