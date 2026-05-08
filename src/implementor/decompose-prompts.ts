/**
 * Phase 7a prompt — decompose-stuck-leaf.
 *
 * The architect sees a leaf that exhausted its body-author attempts.
 * Decision: split into single-concern sub-leaves, OR retry with a
 * fresh approach when the leaf is genuinely doing one thing and just
 * picked the wrong implementation strategy. There's no "give up"
 * option that leaves broken code in the build — every leaf must
 * eventually pass its tests, even if that requires multiple
 * decomposition rounds.
 */

import type { PlannedInterface } from "../rpg/types.js";

export const DECOMPOSE_SYSTEM_PROMPT = `You are an Architect agent diagnosing a stuck implementation.

A leaf capability has exhausted its body-author retry budget. You need to decide between two recovery strategies:

  1. DECOMPOSE — the leaf is doing MULTIPLE distinct concerns. Split it into N single-responsibility sub-tasks (each a future leaf), and the original leaf will become a small assembly that calls them. Single-responsibility test: if you can list the leaf's responsibilities and there's more than one, decompose.

  2. FRESH_APPROACH — the leaf is doing ONE thing, but the body-author keeps producing the wrong implementation strategy. Suggest a different angle in plain words; the body-author's next attempt will see your suggestion and discard the prior body. Use this when decomposition would not actually reduce complexity.

There is NO "give up" option. The contract IS the test, and a passing implementation must exist; if you genuinely can't see how, it's a sign the parent's interface is wrong — but escalate through DECOMPOSE rather than skipping.

Decomposition rules:
  - Sub-leaves are SIBLINGS of the original leaf in the same host file. Each gets its own name, signature, and one-paragraph description. Their signatures must be such that the original leaf's body can call them and combine their outputs to satisfy the original tests.
  - 2–5 sub-leaves is the sweet spot. Fewer = decomposition didn't help; more = you're listing every line as a separate function.
  - Each sub-leaf should be testable in isolation in <20 lines.
  - Sub-leaves must NOT change the original leaf's signature or its tests. The original leaf becomes a thin assembly; its tests stay the contract.

Output strictly JSON, schema given in the user message.`;

export interface DecomposePromptInput {
  leaf: PlannedInterface;
  /** Path the leaf lives in (architect needs it to know where helpers go). */
  hostFilePath: string;
  /** The test source the failing leaf must satisfy. */
  testSource: string;
  /** The most recent body attempt. */
  lastBody: string;
  /** The most recent failing assertion message. */
  lastFailure: string;
  /** Number of body-author attempts already burned on this leaf. */
  attemptsExhausted: number;
  /** Decomposition rounds already taken on the original leaf (or its
   *  ancestors). When >0 the architect knows prior decompositions
   *  haven't helped, so it should lean toward FRESH_APPROACH. */
  decompositionDepth: number;
  /** True when this is the LAST decomposition round before depth
   *  budget exhausts; architect must pick FRESH_APPROACH. */
  atDepthLimit: boolean;
}

export function buildDecomposeUserPrompt(input: DecomposePromptInput): string {
  const lines: string[] = [];
  lines.push("# Stuck leaf");
  lines.push("");
  lines.push(`Name: \`${input.leaf.name}\``);
  if (input.leaf.kind === "method") {
    lines.push(`Owner class: \`${input.leaf.ownerClassName ?? "Class"}\``);
  }
  lines.push(`Host file: \`${input.hostFilePath}\``);
  lines.push("");
  lines.push("Signature:");
  lines.push("```ts");
  lines.push(renderSignature(input.leaf));
  lines.push("```");
  lines.push("");
  lines.push("Description (architect-authored, the contract):");
  lines.push("");
  lines.push(input.leaf.description);
  lines.push("");
  lines.push("# Failure context");
  lines.push("");
  lines.push(`Body-author has burned ${input.attemptsExhausted} attempts.`);
  lines.push(
    `Decomposition rounds already taken on this leaf or ancestors: ${input.decompositionDepth}.`,
  );
  if (input.atDepthLimit) {
    lines.push(
      "**This is the LAST decomposition round before depth budget exhausts. You MUST choose FRESH_APPROACH; further decomposition will be rejected.**",
    );
  }
  lines.push("");
  lines.push("Test source the body must satisfy:");
  lines.push("```ts");
  lines.push(input.testSource);
  lines.push("```");
  lines.push("");
  lines.push("Most recent body that failed:");
  lines.push("```ts");
  lines.push(input.lastBody);
  lines.push("```");
  lines.push("");
  lines.push("Most recent failure message:");
  lines.push("```");
  lines.push(input.lastFailure);
  lines.push("```");
  lines.push("");

  lines.push("# Output schema");
  lines.push("");
  lines.push(
    "```json",
    JSON.stringify(
      {
        decision: "decompose | fresh_approach",
        reason: "string (one paragraph explaining the choice)",
        // Required only when decision === "decompose":
        subLeaves: [
          {
            name: "string (camelCase identifier; unique within host file)",
            description: "string (one-paragraph contract)",
            signature: {
              params: [
                { name: "string", type: "string", optional: "boolean" },
              ],
              returnType: "string (TypeScript type)",
              isAsync: "boolean",
            },
            kind: "function | method",
            ownerClassName: "string | null (set only when kind=method)",
            isStatic: "boolean (only for methods)",
            exported: "boolean",
          },
        ],
        // Required only when decision === "fresh_approach":
        approachHint:
          "string (one paragraph hinting at a different implementation strategy)",
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
