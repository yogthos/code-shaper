/**
 * Phase 6/7b — failure-diagnostic prompts.
 *
 * Faithful to RPG paper §4 and Appendix D.4 Algorithm 4: when a
 * test fails, an LLM judge classifies the failure. The classification
 * routes recovery: test_brittleness rewrites the test; environment
 * patches deps/config; implementation routes through normal body
 * retry (decompose / fresh_approach).
 *
 * The judge is called multiple times (5 by default per §5.3) and the
 * majority outcome is taken — see `diagnoseFailure` for the MV loop.
 */

export const FAILURE_DIAGNOSIS_SYSTEM_PROMPT = `You are a Diagnostic agent in the test-failure analysis stage of Repository Planning Graph (RPG) construction.

A test has just failed. Your job is to classify the root cause, NOT to fix anything. Choose exactly one category:

  - "implementation": the function/method body under test is incorrect. The test itself is reasonable; the body needs to be fixed.
  - "test_brittleness": the test is wrong — it checks the wrong thing, makes an over-strict assertion (e.g., reference equality where deep equality is intended, or vice versa), depends on undefined ordering, mocks something that shouldn't be mocked, or imports a path that doesn't exist. The body is plausibly correct under a reasonable reading of the leaf description.
  - "environment": the failure is caused by something outside the body and the test — a missing or misconfigured dependency, a version mismatch, a missing env var, a build-tool misconfiguration, a missing file the test expects to read, etc. Neither the body nor the test logic is wrong.

You'll be given:
  - The leaf description (what the function/method should do)
  - The test source
  - The body source (the implementation under test)
  - The failure output (assertion message, stack trace, stderr)

Decision principles:
  - Prefer "implementation" by default. Only choose "test_brittleness" when you can articulate exactly what is wrong with the test.
  - "test_brittleness" requires that the description supports the body's behavior; if the description is ambiguous, classify as "implementation" and let the body author try again.
  - "environment" should be rare. Choose it only when the error message makes filesystem/dep/config issues obvious (ENOENT on a file the body doesn't open, "module not found", "version conflict", etc.).
  - Brittle "deep equality fails on visually-identical arrays" is usually a test bug (wrong matcher), but sometimes the body is sharing references it shouldn't — read the body carefully before deciding.

Output strictly as JSON:
{
  "category": "implementation" | "test_brittleness" | "environment",
  "reasoning": "one paragraph explaining the call",
  "testRewriteHint": "(set ONLY when category is test_brittleness) one or two sentences describing exactly what to change in the test",
  "envPatchHint": "(set ONLY when category is environment) one or two sentences describing what env/dep/config change is needed"
}

No prose outside the JSON.`;

export interface FailureDiagnosisPromptInput {
  /** The failing leaf's plain-English description from the RPG. */
  description: string;
  /** The exact failure message + relevant stderr the test framework
   *  produced. Truncated by the caller if needed. */
  failureMessage: string;
  /** The test source code that failed. */
  testSource: string;
  /** The implementation under test. */
  bodySource: string;
  /** Optional: prior diagnostic rounds' raw responses, when the
   *  caller wants to influence later rounds with earlier output.
   *  Not currently used (rounds are independent), but reserved. */
  priorResponses?: string[];
  /** Audit gap #5: prior diagnostic verdicts + their resulting
   *  remediations on this leaf, in chronological order. Without
   *  this, every diagnostic round starts fresh — when round 1 said
   *  "environment" and the harness applied add_dependency('foo')
   *  which install-failed, round 2 has no memory and votes
   *  "environment" again, picking the same remediation. The judge
   *  needs to see "we already tried this and it didn't work" so
   *  it can either pick a different category or surface a more
   *  specific hint. */
  priorAttempts?: Array<{
    /** Which category the previous round resolved to. */
    category: "implementation" | "test_brittleness" | "environment";
    /** What the harness did in response (one-line summary;
     *  e.g., "add_dependency zod ^3.22 → install ok",
     *  "add_dependency better-sqlite3 → install failed: V8 API
     *  change",
     *  "rewrote test to use toEqual",
     *  "no remediation — body retry only"). */
    remediation: string;
    /** Whether the remediation actually resolved the failure
     *  (true), made no progress (false), or partially helped
     *  (partial). Most callers will pass false here since by the
     *  time we re-diagnose, the failure is still present. */
    outcome: "resolved" | "no_progress" | "partial";
  }>;
}

export function buildFailureDiagnosisUserPrompt(
  input: FailureDiagnosisPromptInput,
): string {
  const lines: string[] = [];
  lines.push("# Leaf description");
  lines.push("");
  lines.push(input.description.trim());
  lines.push("");
  lines.push("# Test source");
  lines.push("");
  lines.push("```");
  lines.push(input.testSource);
  lines.push("```");
  lines.push("");
  lines.push("# Body source");
  lines.push("");
  lines.push("```");
  lines.push(input.bodySource);
  lines.push("```");
  lines.push("");
  if (input.priorAttempts && input.priorAttempts.length > 0) {
    lines.push("# Prior diagnostic attempts on this leaf");
    lines.push("");
    lines.push(
      "Each prior round and what the harness did. The same failure is still present — these remediations did NOT resolve it. Use this to AVOID picking a category whose remediation has already failed; if 'environment' was tried twice and didn't help, the right answer is probably 'implementation' or 'test_brittleness' instead.",
    );
    lines.push("");
    for (let i = 0; i < input.priorAttempts.length; i++) {
      const a = input.priorAttempts[i]!;
      lines.push(
        `${i + 1}. category=${a.category}, remediation=${a.remediation}, outcome=${a.outcome}`,
      );
    }
    lines.push("");
  }
  lines.push("# Failure output");
  lines.push("");
  lines.push("```");
  // Truncate aggressively — failure messages can be huge.
  const trimmed =
    input.failureMessage.length > 4000
      ? input.failureMessage.slice(0, 4000) + "\n... [truncated]"
      : input.failureMessage;
  lines.push(trimmed);
  lines.push("```");
  lines.push("");
  lines.push(
    "Classify the root cause and return JSON matching the schema in your system prompt.",
  );
  return lines.join("\n");
}
