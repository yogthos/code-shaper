/**
 * Shared capability-tree traversal used by both `summarizeExistingRPG`
 * (Phase 3 extend-mode summary) and `renderStructurePromptBody`
 * (Phase 4 prompt body).
 *
 * The traversal:
 *   1. Walks every capability reachable from the root folder, in
 *      declaration order, depth-first, with a `depth` counter.
 *   2. Visits orphan capabilities (those whose parent isn't in the
 *      root-reachable set) at depth 0 in a deterministic order so a
 *      partially-broken graph still surfaces every node.
 *
 * Callers supply a `format(node, depth) → string` and receive the
 * accumulated lines. Keeps two prompt renderers' rendering logic in one
 * place.
 */

import { isCapability, type CapabilityNode, type RPG } from "../rpg/types.js";

export type CapabilityFormatter = (
  node: CapabilityNode,
  depth: number,
) => string;

export function renderCapabilityForest(
  rpg: RPG,
  format: CapabilityFormatter,
): string[] {
  const lines: string[] = [];
  const visited = new Set<string>();
  const root = rpg.nodes[rpg.rootId];
  if (root) {
    for (const childId of root.children) {
      const child = rpg.nodes[childId];
      if (child && isCapability(child)) {
        renderSubtree(rpg, child, 0, format, lines, visited);
      }
    }
  }
  // Orphan capabilities — keep them visible so the architect can spot
  // a broken graph rather than a quietly missing entry.
  for (const node of Object.values(rpg.nodes)) {
    if (isCapability(node) && !visited.has(node.id)) {
      renderSubtree(rpg, node, 0, format, lines, visited);
    }
  }
  return lines;
}

function renderSubtree(
  rpg: RPG,
  node: CapabilityNode,
  depth: number,
  format: CapabilityFormatter,
  out: string[],
  visited: Set<string>,
): void {
  if (visited.has(node.id)) return;
  visited.add(node.id);
  out.push(format(node, depth));
  for (const childId of node.children) {
    const child = rpg.nodes[childId];
    if (child && isCapability(child)) {
      renderSubtree(rpg, child, depth + 1, format, out, visited);
    }
  }
}
