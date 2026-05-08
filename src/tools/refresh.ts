/**
 * After a byte-level edit to a `FileNode.content`, re-extract the file
 * via its language adapter and replace the file's portion of the RPG
 * node map. Cross-file edges are then re-resolved globally — cheap,
 * and keeps the invariant that the RPG always equals what
 * `loadRepo(materialize(rpg))` would produce.
 *
 * `removed` / `added` are reported as set-differences so callers can
 * use them as cache-invalidation primitives: a node id that appears
 * in both the pre- and post-edit graphs (same name, same kind, same
 * line) shows up in neither list, even though its byte range may have
 * changed. The contract is "ids that came/went," not "ids touched."
 *
 * Returned status:
 *   - "ok"          — extraction succeeded, no parse errors.
 *   - "parse-error" — adapter reported error nodes; the caller should
 *                     revert the content change. The node map IS
 *                     updated to the broken state so the diff is still
 *                     reportable; in practice edit tools revert on
 *                     parse-error before returning to callers.
 *   - "no-adapter"  — file has no adapter for its extension. The
 *                     caller edited a non-source file we can't
 *                     structurally model.
 */

import {
  getAdapterForFile,
  type ExtractedFile,
} from "../rpg/adapters/index.js";
import { resolveImportEdges, resolveInheritEdges } from "../rpg/resolve.js";
import type { FileNode, NodeId, RPG } from "../rpg/types.js";

export type RefreshStatus = "ok" | "parse-error" | "no-adapter";

export interface RefreshResult {
  status: RefreshStatus;
  /** Adapter parse-error message, when applicable. */
  message?: string;
  /** Ids present before refresh but not after. */
  removed: NodeId[];
  /** Ids present after refresh but not before. */
  added: NodeId[];
}

export function refreshFile(rpg: RPG, file: FileNode): RefreshResult {
  const adapter = getAdapterForFile(file.path);
  if (!adapter) {
    return { status: "no-adapter", removed: [], added: [] };
  }

  // Snapshot the set of ids "owned" by this file: top-level children +
  // every method on a top-level class. Used for the post-extract diff.
  const before = collectFileIds(rpg, file);

  // Drop the old slice from the global node map. We deliberately do
  // this before extraction so the new slice's ids — which often
  // collide with the old (same name + same kind + same line) — don't
  // get clobbered when we write them.
  for (const id of before) {
    delete rpg.nodes[id];
  }
  file.children = [];

  const extracted: ExtractedFile = adapter.extract({
    fileId: file.id,
    filePath: file.path,
    source: file.content,
  });

  file.rawImports = extracted.imports;
  file.exports = extracted.exports;

  for (const entry of extracted.topLevel) {
    rpg.nodes[entry.id] = entry;
    file.children.push(entry.id);
  }
  for (const method of extracted.methods) {
    rpg.nodes[method.id] = method;
  }

  const after = collectFileIds(rpg, file);

  rpg.imports = resolveImportEdges(rpg);
  rpg.inherits = resolveInheritEdges(rpg);

  const removed: NodeId[] = [];
  const added: NodeId[] = [];
  for (const id of before) if (!after.has(id)) removed.push(id);
  for (const id of after) if (!before.has(id)) added.push(id);

  const parseErrors = (extracted.warnings ?? []).filter(
    (w) => w.kind === "parse-error",
  );
  if (parseErrors.length > 0) {
    return {
      status: "parse-error",
      message: parseErrors.map((w) => w.message).join("; "),
      removed,
      added,
    };
  }
  return { status: "ok", removed, added };
}

function collectFileIds(rpg: RPG, file: FileNode): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const childId of file.children) {
    ids.add(childId);
    const child = rpg.nodes[childId];
    if (!child) continue;
    if (child.kind === "class") {
      for (const methodId of child.children) ids.add(methodId);
    }
  }
  return ids;
}
