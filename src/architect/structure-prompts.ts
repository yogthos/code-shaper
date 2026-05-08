/**
 * Phase 4 prompt templates — file-structure encoding.
 *
 * The architect receives the proposal-stage capability tree and a list
 * of every adapter-supported file extension, then assigns each
 * capability to a folder or file path. Leaves stay un-mapped — they
 * cluster into their parent file in Phase 5 (interface design).
 *
 * Two distinct prompt shapes:
 *   - greenfield: every "planned" capability needs a mapping.
 *   - extend:     existing folders/files render verbatim; only
 *                 still-`planned` capabilities get mapped.
 */

import {
  isFile,
  isFolder,
  type CapabilityNode,
  type RPG,
} from "../rpg/types.js";
import { renderCapabilityForest } from "./capability-walk.js";

export interface StructurePromptInput {
  /** Same description string the proposal stage saw — gives the
   *  architect domain context for path naming. */
  projectDescription: string;
  /** Greenfield = empty repo; extend = existing files present. */
  mode: "greenfield" | "extend";
  /** File extensions the loader's adapters can parse. The architect
   *  must pick from this set when mapping a capability to a file. */
  allowedExtensions: string[];
  /** Rendered capability tree + (in extend mode) existing structure
   *  summary. Built via `renderStructurePromptBody`. */
  body: string;
}

export const STRUCTURE_SYSTEM_PROMPT = `You are an Architect agent in the file-structure encoding stage of Repository Planning Graph (RPG) construction.

Your input is a tree of capability nodes (each with an id, name, and description). Your job is to assign every NON-LEAF capability still in status "planned" to a path on disk:

  - Capabilities directly under the project root (depth 1) become FOLDERS.
  - Non-leaf capabilities below depth 1 become FILES inside their ancestor's folder.
  - Leaf capabilities are intentionally NOT mapped at this stage — they cluster into their parent's file as functions/classes in the next stage.

Rules:
  - Paths are repository-relative; no leading slash, no "..", no absolute paths.
  - Use forward slashes only.
  - Folder paths have no extension. File paths end with one of the allowed file extensions you'll be told.
  - Names are lower-case, hyphenated where helpful (e.g. data-loader.ts, not DataLoader.ts).
  - Every file lives under one of the folders you also map. If a deep file requires intermediate folders that aren't separate capabilities, you may omit those — they'll be created implicitly. But intermediate sub-folders for capabilities that ARE non-leaf nodes should be mapped explicitly.
  - Cohesion: each folder owns one functional area; each file owns a coherent set of leaf capabilities.

Output strictly as JSON matching the schema you'll be told. No prose outside the JSON.`;

export function buildStructureUserPrompt(input: StructurePromptInput): string {
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
    lines.push("# Existing-structure policy");
    lines.push("");
    lines.push(
      "This is an EXTEND run — the repository already has a structure on disk. Reuse existing folders where a new capability fits naturally rather than inventing parallel hierarchies. Do not invent new top-level folders when an existing one already covers the area. New file paths should follow the naming conventions visible in the existing files. Do NOT propose moves, renames, or deletions — restructuring is out of scope for this stage.",
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
        mappings: [
          {
            capabilityId: "string (must match an unmapped capability id)",
            kind: "folder | file",
            path: "string (repo-relative)",
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
    "Return only valid JSON. Every non-leaf capability listed as `(unmapped)` must appear exactly once in `mappings`. Capabilities marked `(mapped …)` already have a path — do NOT repeat them.",
  );

  return lines.join("\n");
}

/**
 * Render the prompt body that lists capabilities (with status markers)
 * and, in extend mode, the existing folder/file structure on disk.
 *
 * Capability hierarchy is preserved with indentation. Each line shows:
 *
 *     - <name> [LEAF | (unmapped) | (mapped → <path>)]: <description>
 *
 * Leaves are flagged so the architect doesn't try to map them. The
 * `(unmapped)` annotation calls out exactly which non-leaf capabilities
 * still need a path — useful for both greenfield (everything is
 * unmapped) and extend mode (only the new subset).
 *
 * No truncation: for RepoCraft-scale capability trees (hundreds of
 * nodes) this can blow past the model's context window. Phase 8 /
 * existing-project work will need a budget — likely "show only the
 * unmapped subtree plus its direct ancestors." Today's small targets
 * stay well under context.
 */
export function renderStructurePromptBody(rpg: RPG): string {
  const lines: string[] = [];

  // Existing folders/files appear in extend-mode prompts only when
  // they exist. Greenfield runs against an empty repo; this section
  // would just be empty noise.
  const folders: string[] = [];
  const files: Array<{ path: string }> = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFolder(node) && node.path !== "") folders.push(node.path);
    else if (isFile(node)) files.push({ path: node.path });
  }
  if (folders.length > 0 || files.length > 0) {
    folders.sort();
    files.sort((a, b) => a.path.localeCompare(b.path));
    lines.push("# Existing structure");
    lines.push("");
    if (folders.length > 0) {
      lines.push("Folders already on disk:");
      for (const f of folders) lines.push(`- ${f}/`);
      lines.push("");
    }
    if (files.length > 0) {
      lines.push("Files already on disk:");
      for (const f of files) lines.push(`- ${f.path}`);
      lines.push("");
    }
  }

  lines.push("# Capability tree");
  lines.push("");
  const capabilityLines = renderCapabilityForest(rpg, (node, depth) => {
    const indent = "  ".repeat(depth);
    const tag = capabilityStatusTag(rpg, node);
    return `${indent}- ${node.name} ${tag}: ${node.description} [id=${node.id}]`;
  });
  if (capabilityLines.length === 0) {
    lines.push("(no capabilities — nothing to map)");
  } else {
    lines.push(...capabilityLines);
  }
  return lines.join("\n");
}

function capabilityStatusTag(rpg: RPG, node: CapabilityNode): string {
  if (node.isLeaf) return "[LEAF]";
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
