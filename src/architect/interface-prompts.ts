/**
 * Phase 5 prompt templates — interface design + data flow.
 *
 * The architect receives every leaf capability, the folder/file
 * structure that Phase 4 produced, and decides:
 *   - which file each leaf lives in (creating new files inside an
 *     ancestor folder when necessary);
 *   - whether the leaf becomes a standalone function or a method of a
 *     shared class;
 *   - the signature and one-paragraph description;
 *   - cross-leaf data flow (typed I/O) edges where one leaf consumes
 *     the output of another.
 *
 * Within-file inheritance (`extends`) is supported; lifting common
 * base classes across multiple files is Phase 5b territory.
 */

import {
  isCapability,
  isFile,
  isFolder,
  type CapabilityNode,
  type RPG,
  type RPGNode,
} from "../rpg/types.js";
import { renderCapabilityForest } from "./capability-walk.js";

export interface InterfacePromptInput {
  /** Same description string the proposal stage saw. */
  projectDescription: string;
  /** Pre-rendered prompt body (file structure + leaf table + ancestry).
   *  Built via `renderInterfacePromptBody`. */
  body: string;
  /** Allowed file extensions for new files the architect might propose. */
  allowedExtensions: string[];
  /** Greenfield (initial pipeline) vs. extend (existing repo loaded
   *  via loadRepo). Extend mode injects an extra paragraph telling
   *  the architect to integrate with existing files where naming
   *  conventions allow, and to leave already-implemented members
   *  alone. */
  mode?: "greenfield" | "extend";
}

export const INTERFACE_SYSTEM_PROMPT = `You are an Architect agent in the interface-design stage of Repository Planning Graph (RPG) construction.

Inputs you'll see:
  - The project description.
  - The folder/file structure already mapped (each file may host one or more leaf capabilities).
  - A table of every LEAF capability with its description and its current ancestor mappings.
  - The list of allowed file extensions.

Your output for each leaf capability:
  - Choose a host file. Prefer a file already mapped to one of the leaf's ancestors. When no ancestor maps to a file (the nearest mapping is a folder), propose a new file path inside that folder.
  - Decide whether the leaf becomes a standalone function or a method of a shared class. Cluster interdependent leaves under a class; keep independent ones as standalone functions.
  - Specify the function/method signature: parameter names + types, return type, whether async.
  - Write a one-paragraph description that's specific enough to drive tests.
  - Classify the testability of the task — set testability to one of:

      "unit" — pure logic the implementor can test in isolation (validation rules, computations, parsing, transformations, state-update functions, business-rule checks). The implementor writes unit tests + body together using TDD.

      "integration" — framework-adapter / lifecycle / wiring code whose behavior is only meaningful as part of the wider system. Examples: registering routes on an HTTP framework, mounting middleware, hooking into a DOM/Preact lifecycle, configuring a database connection pool, server bootstrap, app entry points. The implementor writes the body directly; project-level integration tests exercise it end-to-end.

      Be deliberate. A function called registerErrorMiddleware(app) that just calls app.use(...) is "integration". A function called mapErrorToStatusCode(error) that returns a number is "unit". When in doubt, prefer "unit" — most logic IS unit-testable. Mark "integration" only when the function's behavior cannot be verified without running the framework.

Also produce, for each file:
  - A list of containers declared in that file. The default container kind is "class"; the schema also supports "interface", "protocol" (think Clojure protocol / Haskell type-class / Rust trait abstractions), "record"/"struct" (data-bearing types), and "module" (namespacing for FP-leaning languages). Pick the kind that fits the language and design — when in doubt for TypeScript, "class" is correct. A container can extend another container IN THE SAME FILE; the extension models inheritance, implementation, or protocol-extension depending on the kind.

And produce data-flow edges: for each leaf that consumes another leaf's output, an edge with a typed payload label.

Rules:
  - Every leaf appears in exactly one entry under \`interfaces\`.
  - Names within a file are unique — don't declare two functions or two methods of the same class with the same name.
  - Names follow common TypeScript conventions: camelCase for functions/methods/variables, PascalCase for classes.
  - File paths are repo-relative, no \`..\`, end with one of the allowed extensions.
  - Method entries name a class declared in the same file.
  - extendsName, when non-null, names another class declared in the same file.
  - Data-flow edges reference real leaf capability ids by their full id string.

Output strictly as JSON matching the schema you'll be told. No prose outside the JSON.`;

export function buildInterfaceUserPrompt(input: InterfacePromptInput): string {
  const lines: string[] = [];
  lines.push("# Project");
  lines.push("");
  lines.push(input.projectDescription.trim());
  lines.push("");

  lines.push("# Allowed file extensions");
  lines.push("");
  lines.push(input.allowedExtensions.join(", "));
  lines.push("");

  if (input.mode === "extend") {
    lines.push("# Extend-mode policy");
    lines.push("");
    lines.push(
      "This is an EXTEND run — the repository already has files on disk. New leaves below should integrate with existing files when their nearestMappedAncestor points at one. When proposing a new file, follow the naming and folder conventions visible in the existing structure. Already-implemented leaves (matching an existing export by name) have been removed from the leaf table; do not invent extra entries for them.",
    );
    lines.push("");
  }

  lines.push(input.body);
  lines.push("");

  lines.push("# Output schema");
  lines.push("");
  lines.push(
    "```json",
    JSON.stringify(
      {
        interfaces: [
          {
            leafCapabilityId: "string (id of a leaf capability)",
            filePath: "string (existing or new file path)",
            kind: "function | method",
            name: "string (camelCase identifier)",
            ownerClassName: "string | null (set only for methods)",
            signature: {
              params: [
                {
                  name: "string (camelCase)",
                  type: "string (TypeScript type)",
                  optional: "boolean (default false)",
                  defaultValue: "string | null (omit or pass null when no default; never the JSON literal undefined)",
                },
              ],
              returnType: "string (TypeScript type, e.g. void or Promise<X>)",
              isAsync: "boolean",
            },
            description: "string",
            exported: "boolean",
            isStatic: "boolean (only meaningful for methods)",
            testability:
              "'unit' | 'integration' (REQUIRED — see system prompt for guidance)",
          },
        ],
        classes: [
          {
            filePath: "string",
            name: "string (PascalCase)",
            containerKind:
              "class | interface | protocol | record | struct | trait | module (optional, default 'class')",
            description: "string",
            extendsName: "string | null (must be a container in the same file)",
            exported: "boolean",
          },
        ],
        dataFlow: [
          {
            fromLeafId: "string (a leaf capability id)",
            toLeafId: "string (a leaf capability id)",
            payload: "string (TypeScript type or domain noun, e.g. Entry[])",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  );
  lines.push("");
  lines.push(
    "Return only valid JSON. Every leaf capability listed in the table must appear exactly once in `interfaces`. `classes` may be empty when no methods are declared. `dataFlow` may be empty when no inter-leaf dependencies exist.",
  );
  return lines.join("\n");
}

/**
 * Render the prompt body that lists files (with their assigned
 * capabilities) and the leaf-capability table the architect must map.
 *
 * Each leaf row shows the leaf's description plus its nearest mapped
 * ancestor (folder or file). The architect uses that ancestor to
 * decide where to put the leaf — inside an existing file, or in a new
 * file under the ancestor folder.
 *
 * Like `renderStructurePromptBody`, this isn't yet token-budgeted;
 * Phase 8 will need a budget for repos with thousands of leaves.
 *
 * `skipLeafIds` (used by extend mode) is a set of leaf capability ids
 * to omit from the "Leaves to map" table — the orchestrator filters
 * already-implemented leaves and the architect should never see them.
 */
export function renderInterfacePromptBody(
  rpg: RPG,
  skipLeafIds?: Set<string>,
): string {
  const lines: string[] = [];

  // Section 1: existing folders + files (for placement context).
  const folders: string[] = [];
  const files: Array<{ path: string }> = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFolder(node) && node.path !== "") folders.push(node.path);
    else if (isFile(node)) files.push({ path: node.path });
  }
  folders.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (folders.length > 0 || files.length > 0) {
    lines.push("# Existing structure");
    lines.push("");
    if (folders.length > 0) {
      lines.push("Folders:");
      for (const f of folders) lines.push(`- ${f}/`);
      lines.push("");
    }
    if (files.length > 0) {
      lines.push("Files:");
      for (const f of files) lines.push(`- ${f.path}`);
      lines.push("");
    }
  }

  // Section 2: every leaf with its ancestry. Walking the capability
  // forest also surfaces non-leaf capabilities for context — they
  // help the architect understand the grouping the leaves come from.
  // In extend mode, already-implemented leaves are dropped from the
  // tree too so the architect doesn't reference their ids.
  lines.push("# Capability tree (architect annotates leaves)");
  lines.push("");
  const capLines = renderCapabilityForest(rpg, (node, depth) => {
    if (node.isLeaf && skipLeafIds && skipLeafIds.has(node.id)) {
      return ""; // omit; cleaned up below
    }
    const indent = "  ".repeat(depth);
    const tag = node.isLeaf ? "[LEAF]" : ancestorTag(rpg, node);
    return `${indent}- ${node.name} ${tag}: ${node.description} [id=${node.id}]`;
  }).filter((l) => l.length > 0);
  if (capLines.length === 0) {
    lines.push("(no capabilities)");
  } else {
    lines.push(...capLines);
  }
  lines.push("");

  // Section 3: a flat leaf table with `nearestMappedAncestor` so the
  // architect can choose a host file/folder per leaf without re-doing
  // the tree walk in its head.
  lines.push("# Leaves to map");
  lines.push("");
  lines.push(
    "Each row: `<leafId>` — `<name>`. nearestMappedAncestor: `<folder|file>:<path>`",
  );
  lines.push("");
  for (const node of Object.values(rpg.nodes)) {
    if (!isCapability(node) || !node.isLeaf) continue;
    if (skipLeafIds && skipLeafIds.has(node.id)) continue;
    const anc = nearestMappedAncestor(rpg, node);
    lines.push(`- ${node.id} — ${node.name}. ${anc}`);
  }
  return lines.join("\n");
}

/** Friendly status tag for non-leaf capabilities. */
function ancestorTag(rpg: RPG, node: CapabilityNode): string {
  if (node.status === "mapped" && node.mappedToId) {
    const target = rpg.nodes[node.mappedToId];
    const path =
      target && (isFolder(target) || isFile(target))
        ? target.path
        : "<unknown>";
    return `[mapped → ${path}]`;
  }
  return "[unmapped]";
}

/** "folder:src/http" or "file:src/http/routing.ts" or
 *  "<no mapped ancestor>" if the leaf's chain ends without a mapping. */
function nearestMappedAncestor(rpg: RPG, leaf: CapabilityNode): string {
  let current: CapabilityNode | null = leaf;
  while (current) {
    if (current.status === "mapped" && current.mappedToId) {
      const target = rpg.nodes[current.mappedToId];
      if (target && isFile(target)) return `nearestMappedAncestor: file:${target.path}`;
      if (target && isFolder(target)) return `nearestMappedAncestor: folder:${target.path}`;
    }
    const parentNode: RPGNode | undefined = current.parent
      ? rpg.nodes[current.parent]
      : undefined;
    if (parentNode && isCapability(parentNode)) {
      current = parentNode;
    } else {
      current = null;
    }
  }
  return "nearestMappedAncestor: <none>";
}
