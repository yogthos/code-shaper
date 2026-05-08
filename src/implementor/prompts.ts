/**
 * Implementor prompts (Phase 6).
 *
 * Two LLM calls per leaf:
 *   1. Test author — given a leaf's spec + signature + the host
 *      file's existing exports, produces a vitest test file body.
 *   2. Body author — given the leaf's spec + signature + the test
 *      it must pass, produces the function/method body. On retry,
 *      the prior failing assertion is appended.
 *
 * Both prompts are intentionally narrow: one LLM call = one tightly-
 * scoped output, no chained reasoning, no "design for me" license.
 * That matches rlm-sandbox's findings on small-model orchestration.
 */

import type {
  FileNode,
  PlannedInterface,
  PlannedSignature,
} from "../rpg/types.js";

export const TEST_AUTHOR_SYSTEM_PROMPT = `You are an Implementor agent producing a vitest test file for a single function or method.

You'll be given:
  - The function/method's signature (params + return type + async).
  - A description of what it does, written by the architect.
  - The host file's path and its other exported members for context.
  - The exact import specifier you must use to import the subject.

Your job is to produce a vitest test FILE BODY (a complete .ts source) that imports the function/method by name and asserts its behavior in 1–4 it-blocks. The tests should be specific enough to fail when the body is wrong, but loose enough to pass when the body is correct in a different reasonable way (no over-specification of internal call patterns).

Rules:
  - Use \`import { describe, it, expect } from "vitest";\`
  - Import the subject from the EXACT specifier you're given — do not improvise. The harness has already computed the relative path from the test file's location to the host file.
  - Methods of a class: instantiate the class first.
  - Async functions: \`await\` and \`expect(await fn()).toBe(...)\` patterns.
  - Don't write tests for behavior the description doesn't specify — fewer focused tests beat broad fragile coverage.

Output strictly the raw TypeScript source of the test file. No JSON wrapper, no explanatory prose.`;

export interface TestAuthorPromptInput {
  leaf: PlannedInterface;
  hostFile: FileNode;
  /** Class declaration — present when the leaf is a method. Used so
   *  the prompt knows the class name for instantiation. */
  ownerClassName?: string;
  /** Optional snippet of the rendered file showing the current state
   *  (signatures + stub bodies). Helps the model understand siblings. */
  renderedFile?: string;
  /** Exact import specifier the test file should use to reach the
   *  host. The orchestrator computes this so deeply-nested files (e.g.
   *  `src/foo/bar/baz.ts`) get the right number of `../` steps. */
  importSpecifier: string;
}

export function buildTestAuthorUserPrompt(input: TestAuthorPromptInput): string {
  const lines: string[] = [];
  lines.push(`# Subject under test`);
  lines.push("");
  if (input.leaf.kind === "method") {
    const owner = input.ownerClassName ?? input.leaf.ownerClassName ?? "Class";
    lines.push(`Method \`${owner}.${input.leaf.name}\``);
  } else {
    lines.push(`Function \`${input.leaf.name}\``);
  }
  lines.push("");
  lines.push("Signature:");
  lines.push("```ts");
  lines.push(renderSignature(input.leaf));
  lines.push("```");
  lines.push("");
  lines.push("Description (architect):");
  lines.push("");
  lines.push(input.leaf.description);
  lines.push("");
  lines.push(`Host file: \`${input.hostFile.path}\``);
  lines.push("");
  lines.push(`Import specifier (use exactly this): \`"${input.importSpecifier}"\``);
  lines.push("");
  if (input.renderedFile) {
    lines.push(
      "Current rendered host file (signatures + stubs — your subject's body has not been written yet):",
    );
    lines.push("```ts");
    lines.push(input.renderedFile);
    lines.push("```");
    lines.push("");
  }
  lines.push(
    "Return a complete vitest test file body that exercises the subject. Output only TypeScript source, no markdown fences.",
  );
  return lines.join("\n");
}

export const BODY_AUTHOR_SYSTEM_PROMPT = `You are an Implementor agent producing the body of a single TypeScript function or method.

You'll be given:
  - The function/method's signature.
  - A description of what it does.
  - The vitest test file the body must satisfy.
  - The other exported members of the host file (for context — you may import or call them).
  - On retry, the previous body and the failing assertion message.

Your job is to produce a function/method BODY that makes the tests pass. Output is the raw body source — the statements that go inside the curly braces of the function/method, NOT the signature or surrounding braces. The renderer adds the signature, async marker, return type, and braces; you write only the body statements.

Rules:
  - Use only the parameters declared in the signature plus standard library / Node built-ins.
  - When async, you can use \`await\`. Don't add an extra \`async\` keyword — it's already in the signature.
  - When the test imports a sibling function/class from the same file, you may call it directly by name (it will exist).
  - When in doubt, prefer simplicity — a 5-line body that passes is worth more than a 50-line body that handles every edge.
  - On retry, fix only what the failing assertion says is wrong; don't redesign the whole body.

Output strictly the raw body source. No fences, no commentary, no signature lines.`;

export interface BodyAuthorPromptInput {
  leaf: PlannedInterface;
  hostFile: FileNode;
  testSource: string;
  /** Snippet of the rendered file with sibling signatures (so the
   *  body knows what siblings it can call). */
  renderedFile?: string;
  /** Set on retry: the previous body that didn't pass. */
  previousBody?: string;
  /** Set on retry: the failing assertion message from vitest. */
  failureMessage?: string;
  /** Architect-supplied hint after a Phase 7a `fresh_approach`
   *  decision. Rendered prominently at the top of the user prompt
   *  so the body author sees the suggested strategy before reading
   *  the rest of the context. */
  approachHint?: string;
}

export function buildBodyAuthorUserPrompt(input: BodyAuthorPromptInput): string {
  const lines: string[] = [];
  if (input.approachHint && input.approachHint.trim().length > 0) {
    lines.push("# Architect-suggested approach");
    lines.push("");
    lines.push(
      "A prior attempt at this body did not pass. The architect reviewed and suggests a different strategy:",
    );
    lines.push("");
    lines.push(`> ${input.approachHint.trim()}`);
    lines.push("");
    lines.push(
      "Use this strategy as your starting point. If you think a different angle is clearly better, that's fine — but explain only via the body itself; don't add commentary.",
    );
    lines.push("");
  }
  lines.push("# Subject");
  lines.push("");
  if (input.leaf.kind === "method") {
    lines.push(
      `Method \`${input.leaf.ownerClassName ?? "Class"}.${input.leaf.name}\``,
    );
  } else {
    lines.push(`Function \`${input.leaf.name}\``);
  }
  lines.push("");
  lines.push("Signature:");
  lines.push("```ts");
  lines.push(renderSignature(input.leaf));
  lines.push("```");
  lines.push("");
  lines.push("Description:");
  lines.push("");
  lines.push(input.leaf.description);
  lines.push("");
  if (input.renderedFile) {
    lines.push("# Host file (current state)");
    lines.push("");
    lines.push("```ts");
    lines.push(input.renderedFile);
    lines.push("```");
    lines.push("");
  }
  lines.push("# Test the body must pass");
  lines.push("");
  lines.push("```ts");
  lines.push(input.testSource);
  lines.push("```");
  lines.push("");
  if (input.previousBody !== undefined && input.failureMessage !== undefined) {
    lines.push("# Previous attempt failed");
    lines.push("");
    lines.push("Body you previously produced:");
    lines.push("```ts");
    lines.push(input.previousBody);
    lines.push("```");
    lines.push("");
    lines.push("Failure message from vitest:");
    lines.push("```");
    lines.push(input.failureMessage);
    lines.push("```");
    lines.push("");
    lines.push(
      "Fix the body so the assertion passes. Output the complete corrected body, not a diff.",
    );
  } else {
    lines.push(
      "Produce the body. Output only the statements inside the function — no signature, no braces, no commentary.",
    );
  }
  return lines.join("\n");
}

function renderSignature(leaf: PlannedInterface): string {
  const params = leaf.signature.params
    .map((p: PlannedSignature["params"][number]) => {
      const opt = p.optional ? "?" : "";
      return `${p.name}${opt}: ${p.type}`;
    })
    .join(", ");
  const ret = leaf.signature.returnType;
  const asyncPrefix = leaf.signature.isAsync ? "async " : "";
  if (leaf.kind === "method") {
    return `${asyncPrefix}${leaf.name}(${params}): ${ret}`;
  }
  return `${asyncPrefix}function ${leaf.name}(${params}): ${ret}`;
}

/** Strip any markdown code fences the LLM might wrap output in. Both
 *  the test author and the body author are instructed to return raw
 *  source, but conservative stripping makes the pipeline forgiving. */
export function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```(?:[a-zA-Z0-9]+)?\s*\r?\n?([\s\S]*?)```\s*$/);
  return fence ? fence[1]!.trim() : trimmed;
}

