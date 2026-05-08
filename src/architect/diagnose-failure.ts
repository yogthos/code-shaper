/**
 * Phase 6/7b — failure-diagnosis with majority voting.
 *
 * Faithful to RPG paper §4 + §5.3 + Appendix D.4 Algorithm 4:
 *
 *   "A lightweight majority-vote diagnosis separates genuine
 *    implementation errors from environment or test issues,
 *    automatically handling the latter and returning the former for
 *    repair via the localization–editing workflow." (§4)
 *
 *   "we use 5-round majority voting for attribution" (§5.3)
 *
 * The judge is called N times (default 5) with non-zero temperature
 * so rounds aren't perfectly correlated; the majority category wins.
 * When the majority is `test_brittleness` we also collect the
 * `testRewriteHint` from the winning round; same for `envPatchHint`
 * when the majority is `environment`.
 */

import {
  FAILURE_DIAGNOSIS_SYSTEM_PROMPT,
  buildFailureDiagnosisUserPrompt,
  type FailureDiagnosisPromptInput,
} from "./diagnose-failure-prompts.js";
import type { LLMClient } from "../llm/types.js";

export type FailureCategory =
  | "implementation"
  | "test_brittleness"
  | "environment";

export interface FailureDiagnosisInput extends FailureDiagnosisPromptInput {
  /** Number of judge rounds. Paper specifies 5; tests can override. */
  rounds?: number;
  /** Per-round temperature. Paper doesn't pin a value; 0.7 is a
   *  reasonable variance level for genuine majority voting (a 0.0
   *  setting would just produce N identical answers). */
  temperature?: number;
}

export interface FailureDiagnosisResult {
  category: FailureCategory;
  /** Vote counts per category across rounds. Sum equals
   *  `rounds.fulfilled` (rounds whose response parsed). */
  votes: { implementation: number; test_brittleness: number; environment: number };
  /** When `category` is `test_brittleness`, the hint from the first
   *  round that voted for the majority. Empty otherwise. */
  testRewriteHint?: string;
  /** When `category` is `environment`, the hint from the first round
   *  that voted for the majority. Empty otherwise. */
  envPatchHint?: string;
  /** Per-round raw reasoning, useful for logging and debugging. */
  reasoning: string[];
  /** How many rounds parsed cleanly. May be < `rounds` if the model
   *  emitted malformed JSON; the diagnosis still resolves on votes
   *  cast by the rounds that did parse. */
  fulfilledRounds: number;
  /** Audit gap #19: per-round error messages from rounds that
   *  threw or failed to parse. Distinguishes "5 rounds all errored
   *  out" from "5 rounds confidently voted implementation" — both
   *  previously surfaced as `category: "implementation"` because
   *  the runOneRound catch-all swallowed the error. Callers
   *  should inspect roundErrors when fulfilledRounds < rounds and
   *  surface the actual cause to whoever is consuming the
   *  category (operator log, retry feedback, etc.). */
  roundErrors: string[];
}

interface ParsedRound {
  category: FailureCategory;
  reasoning: string;
  testRewriteHint?: string;
  envPatchHint?: string;
}

/** Wrapper from runOneRound: either the parsed verdict, or an
 *  error message describing why the round failed (LLM client
 *  threw, response empty, JSON malformed, schema mismatch). */
interface RoundOutcome {
  parsed: ParsedRound | null;
  error: string | null;
}

const DEFAULT_ROUNDS = 5;

/**
 * Run a 5-round majority-vote LLM judge on a test failure.
 *
 * On a tie, prefer `implementation` — the conservative default,
 * because mis-routing an implementation bug to test rewrite would
 * relax the contract and hide the bug, while mis-routing a brittle
 * test to implementation just costs another body retry.
 */
export async function diagnoseFailure(
  client: LLMClient,
  input: FailureDiagnosisInput,
): Promise<FailureDiagnosisResult> {
  const rounds = Math.max(1, input.rounds ?? DEFAULT_ROUNDS);
  const temperature = input.temperature ?? 0.7;
  const userPrompt = buildFailureDiagnosisUserPrompt(input);

  const tasks: Array<Promise<RoundOutcome>> = [];
  for (let i = 0; i < rounds; i++) {
    tasks.push(runOneRound(client, userPrompt, temperature));
  }
  // Rounds are independent — fire in parallel. A serial loop would
  // multiply latency by `rounds` for no diagnostic value.
  const results = await Promise.all(tasks);

  const votes = { implementation: 0, test_brittleness: 0, environment: 0 };
  const reasoning: string[] = [];
  const testRewriteHints: string[] = [];
  const envPatchHints: string[] = [];
  const roundErrors: string[] = [];
  for (const r of results) {
    if (r.error) roundErrors.push(r.error);
    if (!r.parsed) continue;
    const p = r.parsed;
    votes[p.category]++;
    reasoning.push(p.reasoning);
    if (p.category === "test_brittleness" && p.testRewriteHint) {
      testRewriteHints.push(p.testRewriteHint);
    }
    if (p.category === "environment" && p.envPatchHint) {
      envPatchHints.push(p.envPatchHint);
    }
  }
  const fulfilled = reasoning.length;

  // Conservative attribution: a non-implementation verdict requires
  // STRICT majority over implementation+environment combined (for
  // test_brittleness) or implementation+test_brittleness combined
  // (for environment). Plurality alone isn't enough.
  //
  // Why: relaxing a test contract (test_brittleness path) or
  // mutating the environment (environment path) actively HIDES
  // implementation bugs that future rounds might have caught.
  // Plurality lets a 2-2-1 split route to brittleness even though
  // half the judges thought the body was wrong. Strict majority
  // ensures the rewrite path only fires when the rounds clearly
  // agree the test (or env) is the cause.
  let winner: FailureCategory = "implementation";
  if (
    votes.test_brittleness > votes.implementation + votes.environment
  ) {
    winner = "test_brittleness";
  } else if (
    votes.environment > votes.implementation + votes.test_brittleness
  ) {
    winner = "environment";
  }

  // If no rounds parsed, default to implementation — the safe
  // assumption when the diagnostic itself is failing.
  const result: FailureDiagnosisResult = {
    category: fulfilled === 0 ? "implementation" : winner,
    votes,
    reasoning,
    fulfilledRounds: fulfilled,
    roundErrors,
  };
  if (result.category === "test_brittleness" && testRewriteHints.length > 0) {
    result.testRewriteHint = testRewriteHints[0];
  }
  if (result.category === "environment" && envPatchHints.length > 0) {
    result.envPatchHint = envPatchHints[0];
  }
  return result;
}

async function runOneRound(
  client: LLMClient,
  userPrompt: string,
  temperature: number,
): Promise<RoundOutcome> {
  try {
    const response = await client.chat(
      [
        { role: "system", content: FAILURE_DIAGNOSIS_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      {
        responseFormat: { type: "json_object" },
        temperature,
      },
    );
    const parsed = parseRound(response.content);
    if (parsed) return { parsed, error: null };
    // Response landed but didn't parse as the expected shape —
    // surface that, rather than silently dropping the round.
    return {
      parsed: null,
      error: `round response unparseable: ${response.content.slice(0, 200)}`,
    };
  } catch (e) {
    // A single round error doesn't sink the diagnosis — other rounds
    // can still vote — but audit gap #19: surface the error so
    // callers can detect "all rounds errored" vs. "all rounds voted
    // implementation."
    return {
      parsed: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseRound(raw: string): ParsedRound | null {
  const text = stripFences(raw).trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const category = obj["category"];
  if (
    category !== "implementation" &&
    category !== "test_brittleness" &&
    category !== "environment"
  ) {
    return null;
  }
  const reasoning = typeof obj["reasoning"] === "string" ? obj["reasoning"] : "";
  const out: ParsedRound = { category, reasoning };
  if (category === "test_brittleness") {
    const hint = obj["testRewriteHint"];
    if (typeof hint === "string" && hint.trim().length > 0) {
      out.testRewriteHint = hint;
    }
  }
  if (category === "environment") {
    const hint = obj["envPatchHint"];
    if (typeof hint === "string" && hint.trim().length > 0) {
      out.envPatchHint = hint;
    }
  }
  return out;
}

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}
