/**
 * Architect prompt templates.
 *
 * Phase 3 (proposal): produce a hierarchical capability tree from a
 * project description. We deliberately skip the EpiCoder feature-tree
 * retrieval the paper uses (§3.2's explore-exploit step) — at our
 * scale and with no curated ontology to retrieve from, a single
 * structured-output prompt covers it. The prompt is split into
 * greenfield and extend variants so existing-project mode (Task #6)
 * lands later without rewriting the proposal pipeline.
 */

import type { RPG } from "../rpg/types.js";
import { isFile, isFolder } from "../rpg/types.js";
import { renderCapabilityForest } from "./capability-walk.js";

export interface ProposalPromptInput {
  /** User-supplied project description / goal. */
  description: string;
  /** Greenfield: empty repo, plan from scratch.
   *  Extend: an existing RPG; the architect proposes additions. */
  mode: "greenfield" | "extend";
  /** When mode === "extend", a structural summary of the existing RPG
   *  is spliced into the prompt so the architect proposes deltas, not
   *  duplicates. Builders use `summarizeExistingRPG()` to render this. */
  existingSummary?: string;
}

export const PROPOSAL_SYSTEM_PROMPT = `You are an Architect agent producing a Repository Planning Graph (RPG) for a software project.

Your output is the proposal stage: a hierarchical tree of capabilities (what to build), not files or code. Each node has:
  - "name": short label (1-4 words)
  - "description": one-paragraph explanation of what this capability does
  - "children": array of child capabilities, OR omitted for leaves

Leaves are atomic features small enough to be implemented as one or a few functions or classes. Non-leaves are organizational containers that group related capabilities.

Guidelines:
  - Top level: 3 to 7 root capability modules. Each represents a major area of the project (e.g. "Data Loading", "Algorithms", "Evaluation").
  - Each non-leaf capability has 2 to 6 children.
  - Leaves should be specific enough that a developer can write tests for them in <20 lines.
  - Cohesion + decoupling: each module owns one responsibility; cross-module dependencies should be minimal.
  - Do NOT propose file paths, function signatures, or implementation details. Those come later.

Output strictly as JSON matching the schema you'll be told. No prose outside the JSON.`;

export function buildProposalUserPrompt(input: ProposalPromptInput): string {
  const lines: string[] = [];
  lines.push(`# Project description`);
  lines.push("");
  lines.push(input.description.trim());
  lines.push("");

  if (input.mode === "extend" && input.existingSummary) {
    lines.push(`# Existing repository structure`);
    lines.push("");
    lines.push(
      "The repo below already exists. Propose ONLY the new capabilities that need to be added or extended. Do NOT re-list capabilities that already have an implementation; instead, focus your tree on the deltas the user is asking for.",
    );
    lines.push("");
    lines.push(input.existingSummary);
    lines.push("");
  }

  lines.push(`# Output schema`);
  lines.push("");
  lines.push(
    "```json",
    JSON.stringify(
      {
        projectName: "string",
        description: "string",
        rootCapabilities: [
          {
            name: "string",
            description: "string",
            children: [{ name: "string", description: "string" }],
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
    "Return only valid JSON. The top-level object has fields `projectName`, `description`, and `rootCapabilities` (a non-empty array). A capability with no `children` field — or an empty array — is a leaf.",
  );

  return lines.join("\n");
}

/**
 * Render a compact textual summary of the parts of an existing RPG
 * relevant to the architect: folders, files (with exports), and the
 * capability hierarchy preserved as an indented tree. Used by
 * extend-mode proposal prompts so the architect avoids re-proposing
 * what's already implemented.
 *
 * Truncation: the renderer is *not* token-budgeted yet. For
 * RepoCraft-scale inputs (hundreds of files) the resulting string can
 * blow past the model's context window. Phase 8 (incremental edits
 * against existing repos) will need a budget — likely "files: top-N
 * by export count, capabilities: full tree" — but for the small
 * targets we exercise in Phases 3–7 this stays well under 10 KB.
 */
export function summarizeExistingRPG(rpg: RPG): string {
  const lines: string[] = [];
  const folders: string[] = [];
  const files: Array<{ path: string; exports: string[] }> = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFolder(node) && node.path !== "") folders.push(node.path);
    else if (isFile(node)) {
      files.push({ path: node.path, exports: node.exports });
    }
  }
  folders.sort();
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (folders.length > 0) {
    lines.push("## Folders");
    for (const f of folders) lines.push(`- ${f}/`);
    lines.push("");
  }
  if (files.length > 0) {
    lines.push("## Files (with exports)");
    for (const f of files) {
      const exp =
        f.exports.length > 0 ? ` — exports: ${f.exports.join(", ")}` : "";
      lines.push(`- ${f.path}${exp}`);
    }
    lines.push("");
  }

  const capabilityLines = renderCapabilityForest(rpg, (node, depth) => {
    const indent = "  ".repeat(depth);
    const leaf = node.isLeaf ? " (leaf)" : "";
    return `${indent}- ${node.name}${leaf}: ${node.description}`;
  });
  if (capabilityLines.length > 0) {
    lines.push("## Existing capabilities");
    lines.push(...capabilityLines);
    lines.push("");
  }

  if (lines.length === 0) return "(repository is empty)";
  return lines.join("\n");
}
