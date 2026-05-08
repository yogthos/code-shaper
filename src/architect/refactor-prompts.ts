/**
 * Refactor pass prompt.
 *
 * The architect surveys the post-Phase-5 RPG and proposes structural
 * changes from the operation vocabulary. The pass is conservative by
 * default: empty list output is the expected response unless three or
 * more files share an obvious pattern, a file is genuinely too big,
 * or an existing structure clearly conflicts with newly-added
 * capabilities.
 *
 * The same prompt drives extend-mode integration with existing repos
 * — proposed `move_file` / `merge_files` ops let the architect align
 * new capabilities with existing folder names, and
 * `extract_base_class` / `extract_utility` ops factor out emergent
 * shared patterns.
 */

import {
  isFile,
  type InterfacePlan,
  type RPG,
} from "../rpg/types.js";

export interface RefactorPromptInput {
  /** Same project description the prior phases used. */
  projectDescription: string;
  /** Pre-rendered RPG snapshot showing files + their interface plans. */
  body: string;
  /** Whether the run is greenfield (initial pipeline) or extend
   *  (existing repo loaded via loadRepo). The system prompt is the
   *  same; the user prompt's framing differs. */
  mode: "greenfield" | "extend";
}

export const REFACTOR_SYSTEM_PROMPT = `You are an Architect agent in the refactor stage of Repository Planning Graph (RPG) construction.

You are shown the project's current files and their interface plans. Your job is to propose ZERO OR MORE structural operations from a fixed vocabulary. PROPOSING NOTHING IS THE DEFAULT — only emit operations when there's a clear, conservative win.

Operation vocabulary (each is one element in the JSON \`operations\` array):

  - rename_file:        { kind, fromPath, toPath }
  - move_file:          { kind, fromPath, toPath }
  - split_file:         { kind, fromPath, into: [{ path, leafCapabilityIds: [] }] }
  - merge_files:        { kind, fromPaths: [], toPath }
  - extract_base_class: { kind, toFile, baseClassName, baseDescription, methods: [], rewriteExtenders: [{ filePath, className }] }
  - extract_utility:    { kind, toFile, members: [{ fromFile, functionName, leafCapabilityId }] }

Guidance for when to propose each:

  - extract_base_class: only when 3+ classes across different files declare the same method names with similar signatures. Don't propose for two-class symmetry — that's not enough repetition.
  - extract_utility: only when 3+ files import the same helper or are obviously about to. A single shared helper between two files is fine where it lives.
  - merge_files: only when two adjacent files have <3 entries each AND share a single concept. Don't merge purely for file-count reasons.
  - split_file: only when one file has >7 entries OR mixes two clearly distinct concerns. Most files are fine as-is.
  - rename_file / move_file: only when the file's name no longer matches what it actually contains (visible from the interface plan), or when an extend-mode file's name conflicts with existing repository conventions.

Rules for valid output:

  - Every \`fromPath\` and \`toPath\` is a repo-relative path matching the existing files' style.
  - File extensions match the project's existing files.
  - rewriteExtenders.className must reference a class declared in that file.
  - extract_utility members.leafCapabilityId must reference a leaf capability mapped to that file.
  - When in doubt, RETURN AN EMPTY OPERATIONS ARRAY. The pipeline is correct without your help; only intervene when the win is obvious.

Output strictly as JSON: { "operations": [ ... ] }. No prose outside the JSON.`;

export function buildRefactorUserPrompt(input: RefactorPromptInput): string {
  const lines: string[] = [];
  lines.push("# Project");
  lines.push("");
  lines.push(input.projectDescription.trim());
  lines.push("");
  if (input.mode === "extend") {
    lines.push(
      "This is an EXTEND run: the repository existed before this pipeline ran. New capabilities have just been integrated. Look for places where new capabilities don't yet match existing structural conventions, or where the integration created repetition worth factoring.",
    );
    lines.push("");
  } else {
    lines.push(
      "This is a GREENFIELD run: every file you see was just authored by Phase 5. Look for emergent shared patterns — but remember, three small modules are usually fine as three small modules. Conservative is correct.",
    );
    lines.push("");
  }
  lines.push(input.body);
  lines.push("");
  lines.push("# Output");
  lines.push("");
  lines.push("Return JSON: `{ \"operations\": [ ... ] }`. Empty list = no refactor needed.");
  return lines.join("\n");
}

/**
 * Compact dump of every file with its interface plan, used to
 * populate the refactor prompt body. We render:
 *   - file path
 *   - count of entries + classes
 *   - per-entry: leafId, kind, name, ownerClassName, signature shape
 *     (param count + return type), description
 *   - per-class: name, containerKind, extends*, exported
 *
 * Like the other body renderers this isn't yet token-budgeted — for
 * very large repos a follow-up pass should top-N by reference count.
 */
export function renderRefactorPromptBody(rpg: RPG): string {
  const lines: string[] = [];
  lines.push("# Current files + interface plans");
  lines.push("");
  const files = Object.values(rpg.nodes)
    .filter(isFile)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) {
    lines.push("(no files yet)");
    return lines.join("\n");
  }
  for (const f of files) {
    lines.push(`## ${f.path}`);
    lines.push("");
    if (!f.interfacePlan) {
      lines.push(`(no interface plan — file is bare)`);
      lines.push("");
      continue;
    }
    renderPlan(f.interfacePlan, lines);
    lines.push("");
  }
  return lines.join("\n");
}

function renderPlan(plan: InterfacePlan, lines: string[]): void {
  if (plan.classes.length > 0) {
    lines.push("Classes:");
    for (const c of plan.classes) {
      const kind = c.containerKind ?? "class";
      const ext =
        c.extendsName === null
          ? ""
          : c.extendsFromFile
            ? ` extends ${c.extendsName} (from ${c.extendsFromFile})`
            : ` extends ${c.extendsName}`;
      lines.push(
        `- ${c.name} (${kind}${c.exported ? ", exported" : ""})${ext}: ${c.description}`,
      );
    }
    lines.push("");
  }
  if (plan.entries.length > 0) {
    lines.push("Entries:");
    for (const e of plan.entries) {
      const owner =
        e.kind === "method" && e.ownerClassName ? `${e.ownerClassName}.` : "";
      const params = e.signature.params
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
        .join(", ");
      const sig = `(${params}) => ${e.signature.returnType}`;
      const flags = [
        e.exported ? "exported" : null,
        e.signature.isAsync ? "async" : null,
        e.isStatic ? "static" : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- [${e.leafCapabilityId}] ${owner}${e.name}${sig} ${flags ? `(${flags})` : ""}: ${e.description}`,
      );
    }
  }
}
