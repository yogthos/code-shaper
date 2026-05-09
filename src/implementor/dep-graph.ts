/**
 * Step Q4-B — leaf dependency graph from test imports.
 *
 * Parses each leaf's test source for cross-file imports and
 * resolves them to other leaves. The orchestrator's scheduler
 * (Q4-C) uses this to gate dispatch on dependencies — a leaf
 * doesn't run until the leaves whose symbols it imports have
 * all landed.
 *
 * Why test-import-based: the architect's interfacePlan dataflow
 * captures intentional dependencies (data passes from leaf A's
 * output into leaf B's input). But "integration" leaves whose
 * tests EXERCISE other leaves (not just their data) escape this
 * model. Reading the test imports gives us a more complete
 * picture.
 *
 * Resolution model: a test file lives at `tests/leaves/<slug>.test.ts`.
 * Its imports use repo-relative paths through the `../../src/foo.js`
 * convention. We strip the `.js` extension, resolve relative to
 * the test directory, and look up which leaf exports the symbol.
 */

import path from "node:path";
import { extractTopLevelImports } from "./edit-tools.js";
import { isFile } from "../rpg/types.js";
import type { RPG } from "../rpg/types.js";

const TEST_FILE_DIR = "tests/leaves";

export type LeafDependencyGraph = Map<string, Set<string>>;

export function buildLeafDependencyGraph(
  rpg: RPG,
  testsByLeafId: Map<string, string>,
): LeafDependencyGraph {
  // Build a lookup table: (filePath, exportedSymbolName) → leafId.
  // Both function/method names and class names participate, since
  // a test that imports a class transitively depends on its
  // constructor leaf (the class isn't usable until the constructor
  // is implemented).
  const symbolToLeaf = new Map<string, string>();
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node) || !node.interfacePlan) continue;
    for (const entry of node.interfacePlan.entries) {
      const key = `${node.path}::${entry.name}`;
      symbolToLeaf.set(key, entry.leafCapabilityId);
      // Method leaves are also reachable via the owning class
      // name. import { TodoError } pulls in TodoError's
      // constructor leaf; treat the constructor leaf as the
      // representative.
      if (entry.kind === "method" && entry.ownerClassName) {
        const classKey = `${node.path}::${entry.ownerClassName}`;
        // Only set once — first method wins (typically the
        // constructor or the first declared method). The
        // scheduler's "all deps landed" check will gate on
        // whichever leaf got recorded.
        if (!symbolToLeaf.has(classKey)) {
          symbolToLeaf.set(classKey, entry.leafCapabilityId);
        }
      }
    }
    // Standalone class declarations (no methods planned) don't
    // appear here. That's fine — they'd render as empty stubs and
    // the test would still resolve them; no dep needed.
  }

  const graph: LeafDependencyGraph = new Map();
  // Initialize every planned leaf with an empty dep set so the
  // scheduler's lookup is total.
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node) || !node.interfacePlan) continue;
    for (const entry of node.interfacePlan.entries) {
      graph.set(entry.leafCapabilityId, new Set());
    }
  }

  for (const [leafId, testSrc] of testsByLeafId) {
    const ourDeps = graph.get(leafId);
    if (!ourDeps) continue; // Test for a leaf that's not in the RPG (shouldn't happen).
    const imports = extractTopLevelImports(testSrc);
    for (const imp of imports) {
      // Resolve the import's `source` (e.g. "../../src/foo.js")
      // relative to the test file's directory.
      const resolved = resolveTestImport(imp.source);
      if (resolved === null) continue; // Non-relative (e.g., "vitest").
      const key = `${resolved}::${imp.name}`;
      const depLeafId = symbolToLeaf.get(key);
      if (!depLeafId || depLeafId === leafId) continue;
      ourDeps.add(depLeafId);
    }
  }

  return graph;
}

/** Resolve a relative import specifier from a test file to the
 *  repo-relative source path it points at. Returns null when the
 *  specifier is non-relative (a package import like "vitest"). */
function resolveTestImport(specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  // Test files live at `tests/leaves/<slug>.test.ts`. Their
  // imports are relative to that directory.
  const fromTestDir = path.posix.normalize(
    path.posix.join(TEST_FILE_DIR, specifier),
  );
  // Drop trailing `.js` (TS-as-JS convention) so the result
  // matches the FileNode.path format (e.g. "src/foo.ts").
  let resolved = fromTestDir;
  if (resolved.endsWith(".js")) {
    resolved = resolved.slice(0, -3) + ".ts";
  } else if (!resolved.endsWith(".ts")) {
    resolved = resolved + ".ts";
  }
  return resolved;
}
