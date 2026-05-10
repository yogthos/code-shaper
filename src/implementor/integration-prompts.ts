/**
 * Phase 7b prompt templates — branch-level integration test author
 * + leaf-blame attribution.
 *
 * Test author: shows the branch's leaves (signatures + descriptions
 * + import paths) and asks for ONE integration test that exercises
 * how they compose. Bias toward end-to-end behavior over
 * white-box assertion of internal call patterns.
 *
 * Blame attribution: shows the failing assertion and the leaves
 * involved in the branch; asks the architect to pick the most
 * likely culprit and emit either a `fresh_approach` hint or a
 * `decompose` plan, reusing the Phase 7a vocabulary.
 */

import type {
  CapabilityNode,
  PlannedInterface,
  RPG,
} from "../rpg/types.js";

export const INTEGRATION_TEST_AUTHOR_SYSTEM_PROMPT = `You are an Implementor agent producing a vitest integration test for a branch capability — a non-leaf capability whose subtree contains multiple leaves.

You'll be given:
  - The branch's name + description.
  - Each leaf the branch contains: name, signature, description, host file path, import specifier.
  - Optional context about how the leaves should compose (data flow edges, parent's intent).

Your job is to author a SINGLE vitest test file that exercises how the leaves WORK TOGETHER. The test should:
  - Import every leaf via its given import specifier (use exactly the strings provided).
  - Compose them in a realistic scenario implied by the branch description.
  - Assert end-to-end behavior, not internal call counts. The leaves' OWN unit tests already verify per-function correctness — this test verifies they fit together.
  - Stay under ~50 lines. Two or three it-blocks is plenty; coverage by quantity hurts readability.

Rules:
  - Use \`import { describe, it, expect } from "vitest";\`
  - When a leaf is async, use \`await\`.
  - When a leaf is a method, instantiate the class first.
  - Don't write per-leaf assertions — those belong in unit tests.
  - Don't assert on intermediate state that the branch's contract doesn't define.

Output strictly the raw TypeScript source of the test file. No JSON wrapper, no explanatory prose.`;

export interface IntegrationTestAuthorInput {
  branch: CapabilityNode;
  /** The leaves under this branch (transitive — including those born
   *  from Phase 7a decomposition). */
  leaves: Array<{
    capability: CapabilityNode;
    interface: PlannedInterface;
    hostFilePath: string;
    importSpecifier: string;
  }>;
  /** Render of dataFlow edges that touch this branch's leaves, useful
   *  context about producer→consumer ordering. Empty when the branch
   *  has no internal data flow. */
  dataFlowSummary: string;
}

export function buildIntegrationTestAuthorUserPrompt(
  input: IntegrationTestAuthorInput,
): string {
  const lines: string[] = [];
  lines.push(`# Branch: ${input.branch.name}`);
  lines.push("");
  lines.push(input.branch.description);
  lines.push("");

  lines.push("# Leaves in this branch");
  lines.push("");
  for (const l of input.leaves) {
    lines.push(`## \`${l.interface.name}\``);
    lines.push("");
    lines.push(`Host file: \`${l.hostFilePath}\``);
    lines.push(`Import specifier: \`"${l.importSpecifier}"\``);
    lines.push("");
    lines.push("Signature:");
    lines.push("```ts");
    lines.push(renderSignature(l.interface));
    lines.push("```");
    lines.push("");
    lines.push("Description:");
    lines.push(l.capability.description);
    lines.push("");
  }

  if (input.dataFlowSummary.trim().length > 0) {
    lines.push("# Data flow");
    lines.push("");
    lines.push(input.dataFlowSummary);
    lines.push("");
  }

  lines.push(
    "Author a single vitest integration test file that exercises how these leaves fit together. Output only TypeScript source.",
  );
  return lines.join("\n");
}

// ── Blame attribution ───────────────────────────────────────────────

export const INTEGRATION_BLAME_SYSTEM_PROMPT = `You are an Architect agent diagnosing an integration-test failure.

A branch's integration test failed. You'll be given the branch's leaves (each with its current signature, description, and unit-test status) and the failing assertion. Your job is to pick the SINGLE most likely culprit leaf and choose a recovery action.

Recovery actions match the Phase 7a vocabulary:
  1. FRESH_APPROACH — the named leaf's body is wrong; supply a hint at a different implementation strategy.
  2. DECOMPOSE — the named leaf is doing multiple concerns; supply 2-5 single-responsibility sub-leaves whose composition will satisfy the original signature.

Guidance:
  - Read the assertion message carefully. Often it names a function or a class involved in the failure — that's a strong hint.
  - Prefer FRESH_APPROACH when the contract is right but the implementation is buggy.
  - Prefer DECOMPOSE when the leaf's description and the failure together suggest the leaf is too broad.
  - Do NOT pick a leaf whose unit tests are already passing AND whose function isn't named in the failure unless you have a clear theory.

Output strictly JSON, schema given in the user message.`;

export interface IntegrationBlameInput {
  branch: CapabilityNode;
  branchTestSource: string;
  failureMessage: string;
  leaves: Array<{
    leafCapabilityId: string;
    interface: PlannedInterface;
    hostFilePath: string;
    /** Most recent body the implementor produced — useful diagnostic. */
    currentBody: string;
    decompositionDepth: number;
  }>;
  /** Optional ranked list from a §D.1 localization run. When the
   *  integration's `useLocalization` flag is on, the harness
   *  navigates the RPG via the four §D.1 data tools before this
   *  blame call and threads the resulting candidates here as
   *  EXTRA context — the architect still has full discretion to
   *  pick a culprit, but tends to do so more accurately when the
   *  failure mentions a function name that localization could
   *  resolve to a specific leaf. */
  localizationHint?: Array<{
    filePath: string;
    /** Format from §D.1 Terminate(): "function: foo" / "class: Bar"
     *  / "method: Bar.baz". */
    interface: string;
  }>;
  /** Recoveries previously attempted on THIS branch — feeds into a
   *  "previously tried, didn't help" block so the model pivots
   *  instead of looping on the same culprit + decision. */
  priorRecoveries?: Array<{
    round: number;
    culpritLeafId: string;
    decision: "fresh_approach" | "decompose";
    reason: string;
  }>;
}

export function buildIntegrationBlameUserPrompt(
  input: IntegrationBlameInput,
): string {
  const lines: string[] = [];
  lines.push(`# Branch: ${input.branch.name}`);
  lines.push("");
  lines.push(input.branch.description);
  lines.push("");
  lines.push("# Integration test that failed");
  lines.push("");
  lines.push("```ts");
  lines.push(input.branchTestSource);
  lines.push("```");
  lines.push("");
  lines.push("# Failure message");
  lines.push("");
  lines.push("```");
  lines.push(input.failureMessage);
  lines.push("```");
  lines.push("");

  if (input.priorRecoveries && input.priorRecoveries.length > 0) {
    lines.push("# Previously attempted on this branch — DID NOT FIX THE FAILURE");
    lines.push("");
    lines.push(
      "These recoveries were applied in earlier rounds; the integration test still fails (with the message above) AFTER they ran. Picking the same culprit + same decision again is unlikely to work — pivot to a different leaf, or escalate the decision (e.g. fresh_approach → decompose).",
    );
    lines.push("");
    for (const r of input.priorRecoveries) {
      lines.push(
        `- round ${r.round}: ${r.decision} on ${r.culpritLeafId}  — reason: ${r.reason.slice(0, 200).replace(/\s+/g, " ")}`,
      );
    }
    lines.push("");
  }

  if (input.localizationHint && input.localizationHint.length > 0) {
    lines.push("# Localization hint (§D.1 ranked candidates)");
    lines.push("");
    lines.push(
      "A graph-guided localization pass over the failure produced these candidates, most-likely-relevant first. They are HINTS, not bindings — pick the leaf you actually believe is the culprit. The list may include interfaces outside this branch that you cannot act on; ignore those.",
    );
    lines.push("");
    for (const h of input.localizationHint) {
      lines.push(`- ${h.filePath} → ${h.interface}`);
    }
    lines.push("");
  }

  lines.push("# Leaves in this branch (each currently passing its OWN unit tests)");
  lines.push("");
  for (const l of input.leaves) {
    lines.push(`## \`${l.interface.name}\` [id=${l.leafCapabilityId}, depth=${l.decompositionDepth}]`);
    lines.push("");
    lines.push("Signature:");
    lines.push("```ts");
    lines.push(renderSignature(l.interface));
    lines.push("```");
    lines.push("");
    lines.push("Current body:");
    lines.push("```ts");
    lines.push(l.currentBody);
    lines.push("```");
    lines.push("");
  }

  lines.push("# Output schema");
  lines.push("");
  lines.push(
    "```json",
    JSON.stringify(
      {
        culpritLeafId: "string (id of the leaf you blame)",
        decision: "fresh_approach | decompose",
        reason: "string (one paragraph)",
        // Required only when decision === fresh_approach:
        approachHint: "string",
        // Required only when decision === decompose:
        subLeaves: [
          {
            name: "string (camelCase identifier — e.g. fetchTodos, validateInput; NOT the literal word 'camelCase')",
            description: "string",
            signature: {
              params: [{ name: "string", type: "string" }],
              returnType: "string",
              isAsync: "boolean",
            },
            kind: "function | method",
            ownerClassName: "string | null",
            isStatic: "boolean",
            exported: "boolean",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  );
  lines.push("");
  lines.push("Return only valid JSON. No prose outside the JSON.");
  return lines.join("\n");
}

function renderSignature(leaf: PlannedInterface): string {
  const params = leaf.signature.params
    .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
    .join(", ");
  const ret = leaf.signature.returnType;
  const asyncPrefix = leaf.signature.isAsync ? "async " : "";
  if (leaf.kind === "method") {
    return `${asyncPrefix}${leaf.name}(${params}): ${ret}`;
  }
  return `${asyncPrefix}function ${leaf.name}(${params}): ${ret}`;
}

// ── Branch discovery + summaries ────────────────────────────────────

export interface DiscoveredBranch {
  branch: CapabilityNode;
  /** Transitive leaves under this branch, in stable order. */
  leaves: Array<{
    capability: CapabilityNode;
    interface: PlannedInterface;
    hostFilePath: string;
  }>;
}

/** Walk the capability tree and return every non-leaf capability
 *  whose subtree contains AT LEAST 2 leaves (transitively). The
 *  resulting branches are integration-test candidates.
 *
 *  Branches are emitted bottom-up: smaller subgraphs first, larger
 *  enclosing ones after. The orchestrator can choose to author tests
 *  at every level or only at the leaf-most level (paper-style). The
 *  default in `runIntegrationTests` is "every level" since the test
 *  cost is per-branch and the architect decides the granularity. */
export function discoverBranches(rpg: RPG): DiscoveredBranch[] {
  const out: DiscoveredBranch[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (node.kind !== "capability") continue;
    if (node.isLeaf) continue;
    const leaves = collectTransitiveLeaves(rpg, node);
    if (leaves.length < 2) continue;
    out.push({ branch: node, leaves });
  }
  // Sort by depth (deepest first) then by id for stability.
  out.sort((a, b) => {
    const da = a.branch.decompositionDepth;
    const db = b.branch.decompositionDepth;
    if (db !== da) return db - da;
    return a.branch.id.localeCompare(b.branch.id);
  });
  return out;
}

function collectTransitiveLeaves(
  rpg: RPG,
  branch: CapabilityNode,
): DiscoveredBranch["leaves"] {
  const out: DiscoveredBranch["leaves"] = [];
  const visit = (id: string): void => {
    const node = rpg.nodes[id];
    if (!node || node.kind !== "capability") return;
    if (node.isLeaf) {
      const planEntry = findPlanEntry(rpg, id);
      if (planEntry) {
        const hostFilePath =
          node.mappedToId && rpg.nodes[node.mappedToId]?.kind === "file"
            ? (rpg.nodes[node.mappedToId] as { path: string }).path
            : "<unmapped>";
        out.push({
          capability: node,
          interface: planEntry,
          hostFilePath,
        });
      }
      return;
    }
    for (const childId of node.children) visit(childId);
  };
  for (const childId of branch.children) visit(childId);
  return out;
}

function findPlanEntry(
  rpg: RPG,
  leafCapabilityId: string,
): PlannedInterface | null {
  for (const node of Object.values(rpg.nodes)) {
    if (node.kind !== "file" || !node.interfacePlan) continue;
    const entry = node.interfacePlan.entries.find(
      (e) => e.leafCapabilityId === leafCapabilityId,
    );
    if (entry) return entry;
  }
  return null;
}

/** Render the dataFlow edges within a branch's leaves as bullets.
 *  Returns an empty string when the branch has no internal data flow. */
export function renderBranchDataFlow(
  rpg: RPG,
  leaves: DiscoveredBranch["leaves"],
): string {
  const leafIds = new Set(leaves.map((l) => l.capability.id));
  const lines: string[] = [];
  for (const edge of rpg.dataFlow) {
    if (!leafIds.has(edge.fromNode) || !leafIds.has(edge.toNode)) continue;
    const from = rpg.nodes[edge.fromNode];
    const to = rpg.nodes[edge.toNode];
    if (
      from &&
      from.kind === "capability" &&
      to &&
      to.kind === "capability"
    ) {
      lines.push(`- \`${from.name}\` → \`${to.name}\` (payload: ${edge.payload})`);
    }
  }
  return lines.join("\n");
}
