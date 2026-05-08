/**
 * Per-leaf TDD loop.
 *
 * One leaf at a time: author tests, author body, run the leaf's
 * tests in isolation via the harness, retry on failure with the
 * prior failing assertion as feedback. Up to `maxAttempts` tries
 * before giving up; on give-up, returns the best effort so the
 * orchestrator can decide (move on, decompose, etc.).
 *
 * Tests are authored once at the start of the leaf and held constant
 * across retries — the contract doesn't move. Phase 7's recursive
 * decomposition is the place that *changes* contracts; here we
 * just satisfy the one we wrote.
 */

import path from "node:path";

import type { LLMClient } from "../llm/types.js";
import type {
  FileNode,
  PlannedInterface,
  RPG,
} from "../rpg/types.js";
import {
  diagnoseFailure,
  type FailureCategory,
  type FailureDiagnosisResult,
} from "../architect/diagnose-failure.js";
import {
  BODY_AUTHOR_SYSTEM_PROMPT,
  TEST_AUTHOR_SYSTEM_PROMPT,
  buildBodyAuthorUserPrompt,
  buildTestAuthorUserPrompt,
  stripCodeFences,
} from "./prompts.js";
import { validateTypeScriptSource } from "./validate-ts.js";
import { renderTypeScriptFile } from "./render.js";
import {
  leafToTestFilename,
  runTests,
  type LeafTestOutcome,
} from "./test-harness.js";

/** Directory the harness writes per-leaf test files into. All test
 *  files share this directory regardless of leaf id, so the relative
 *  import to a host file depends only on the host's path. */
const TEST_FILE_DIR = "tests/leaves";

/** Compute the relative-import specifier the test file should use to
 *  import from the host file. POSIX-only, drops extension, appends
 *  `.js` to match TS-as-JS convention (matches the renderer's import
 *  emission). */
function testImportSpecifier(hostFilePath: string): string {
  let rel = path.posix.relative(TEST_FILE_DIR, hostFilePath);
  const ext = path.extname(rel);
  if (ext.length > 0) rel = rel.slice(0, -ext.length);
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
  return `${rel}.js`;
}

export interface LeafImplementInput {
  leaf: PlannedInterface;
  hostFile: FileNode;
  rpg: RPG;
  /** Bodies for already-implemented leaves (used by the renderer so
   *  the harness sees the latest in-progress code). The current leaf's
   *  prior body, if any, is also threaded in via this map; the loop
   *  updates it on each attempt. */
  bodyByLeafId: Map<string, string>;
  /** Per-leaf test source map (used by the harness). Test authoring
   *  populates this for the current leaf if it isn't already set. */
  testsByLeafId: Map<string, string>;
  /** Optional snapshot store for test sources that have been
   *  rewritten in response to a `test_brittleness` diagnostic. The
   *  ORIGINAL test (the one the body author was first held to) is
   *  saved here on the first rewrite and never overwritten — the
   *  orchestrator's recovery paths (fresh_approach / decompose) use
   *  it to restore the original contract before retrying the body.
   *  Without this, a brittleness rewrite would silently weaken the
   *  contract for every subsequent retry of the same leaf. */
  originalTestsByLeafId?: Map<string, string>;
  /** Shared harness directory. The orchestrator owns it; the leaf
   *  loop only reads. */
  workDir: string;
  maxAttempts?: number;
  temperature?: number;
  /** Wall-clock timeout for each per-leaf test run, forwarded to the
   *  harness. Defaults to the harness' own default (120s). */
  testTimeoutMs?: number;
  /** Optional architect-supplied hint suggesting an alternative
   *  implementation strategy. Set by the orchestrator after a
   *  `fresh_approach` decision; the body-author user prompt prepends
   *  it on the FIRST attempt of this re-run so the model sees the
   *  guidance immediately. Cleared on subsequent attempts to avoid
   *  reinforcing a bad hint when the body still fails. */
  approachHint?: string;
  /** Maximum number of test-author retries when the authored test
   *  source fails to parse as TypeScript. Each retry includes the
   *  prior parse error so the model can fix the syntax. Defaults to
   *  3. The body-author retry budget is separate (see
   *  `maxAttempts`). */
  maxTestAuthorAttempts?: number;
  /** Failure-diagnosis configuration. When `enabled`, every body-
   *  retry failure runs through a 5-round majority-vote LLM judge
   *  (see RPG paper §5.3) that classifies the failure as
   *  `implementation` / `test_brittleness` / `environment`. A
   *  `test_brittleness` verdict triggers a test rewrite that
   *  consumes from the separate `maxTestRewrites` budget; the body
   *  retry continues against the new test. `environment` and
   *  `implementation` verdicts both fall through to normal body
   *  retry — env auto-fix is gated on the future stack/package.json
   *  phase and not yet wired here.
   *
   *  Default: disabled, preserving the legacy "test contract is
   *  immutable across body retries" behavior for unit tests. The
   *  production drivers (build-todomvc, run-task) opt in. */
  diagnosis?: {
    enabled?: boolean;
    /** Per-failure judge rounds; paper specifies 5. */
    rounds?: number;
    /** Skip diagnosis for the first N failures of each leaf — the
     *  paper diagnoses every failure but in practice most early
     *  failures are real implementation bugs. Default 0 (diagnose
     *  every failure). */
    afterFailures?: number;
  };
  /** Per-leaf budget for test-rewrite remediations triggered by a
   *  `test_brittleness` diagnosis. Paper §5.3: "20 remediation
   *  attempts for test or environment errors." Default 20. */
  maxTestRewrites?: number;
}

export interface LeafImplementResult {
  leafId: string;
  /** True when the final body passes the leaf's tests. */
  ok: boolean;
  /** Body source the loop settled on (passing if ok, best-effort
   *  otherwise). Already written into `bodyByLeafId` by the time
   *  this returns. */
  body: string;
  /** Test source authored by the test step. Already written into
   *  `testsByLeafId`. */
  testSource: string;
  /** Number of body-author attempts taken (1 = first try). */
  attempts: number;
  /** Last failing test outcome if !ok. */
  lastFailure?: LeafTestOutcome;
  /** When fatal harness error (vitest startup failure, tsc parse
   *  failure on the rendered file) prevented the loop from completing,
   *  the message is here. */
  fatal?: string;
  /** Number of test-rewrite remediations the diagnostic triggered.
   *  Distinct from `attempts` (which counts body-author retries).
   *  Always 0 when diagnosis is disabled or no brittle test was
   *  detected. */
  testRewrites?: number;
  /** Per-failure diagnosis trail for observability. One entry per
   *  failure that triggered the diagnostic; entries appear in the
   *  order they fired. */
  diagnoses?: Array<{
    attempt: number;
    category: FailureCategory;
    votes: FailureDiagnosisResult["votes"];
  }>;
}

export async function implementLeaf(
  client: LLMClient,
  input: LeafImplementInput,
): Promise<LeafImplementResult> {
  const maxAttempts = input.maxAttempts ?? 3;
  const leafId = input.leaf.leafCapabilityId;

  // 1. Author tests (once per leaf, with parse-error retry). The
  //    LLM occasionally emits prose inside the source — `That should
  //    handle it` instead of a comment, etc. Vitest would surface
  //    such a file as an opaque suite-level failure that can't be
  //    fixed by retrying the body. Validate up front so we retry the
  //    AUTHOR with parse-error feedback while the test contract is
  //    still mutable.
  let testSource = input.testsByLeafId.get(leafId) ?? "";
  if (!testSource) {
    const maxTestAttempts = input.maxTestAuthorAttempts ?? 3;
    const renderedFile = renderTypeScriptFile({
      file: input.hostFile,
      bodyByLeafId: input.bodyByLeafId,
      rpg: input.rpg,
    });
    const baseTestPrompt = buildTestAuthorUserPrompt({
      leaf: input.leaf,
      hostFile: input.hostFile,
      ownerClassName: input.leaf.ownerClassName ?? undefined,
      renderedFile,
      importSpecifier: testImportSpecifier(input.hostFile.path),
    });
    let priorTestSource: string | null = null;
    let priorParseError: string | null = null;
    for (let i = 0; i < maxTestAttempts; i++) {
      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [
        { role: "system", content: TEST_AUTHOR_SYSTEM_PROMPT },
        { role: "user", content: baseTestPrompt },
      ];
      if (priorTestSource !== null && priorParseError !== null) {
        messages.push({ role: "assistant", content: priorTestSource });
        messages.push({
          role: "user",
          content: `Your previous test source failed to parse as TypeScript: ${priorParseError}\nCommon causes: prose outside of comment markers, missing semicolons, unterminated strings. Return a corrected, complete vitest test file body now. Output only TypeScript source.`,
        });
      }
      const testResponse = await client.chat(
        messages,
        input.temperature !== undefined
          ? { temperature: input.temperature }
          : undefined,
      );
      const candidate = stripCodeFences(testResponse.content);
      if (candidate.length === 0) {
        return {
          leafId,
          ok: false,
          body: "",
          testSource: "",
          attempts: 0,
          fatal: "test author returned empty content",
        };
      }
      const parse = validateTypeScriptSource(candidate);
      if (parse.ok) {
        testSource = candidate;
        break;
      }
      priorTestSource = candidate;
      priorParseError = parse.error;
    }
    if (!testSource) {
      return {
        leafId,
        ok: false,
        body: "",
        testSource: priorTestSource ?? "",
        attempts: 0,
        fatal: `test author produced unparseable TypeScript across ${maxTestAttempts} attempts; last error: ${priorParseError ?? "(unknown)"}`,
      };
    }
    input.testsByLeafId.set(leafId, testSource);
  }

  // 2. Body authoring + retry loop.
  let body = "";
  let attempts = 0;
  let priorBodyEmpty = false;
  let lastFailure: LeafTestOutcome | undefined;
  let lastFatal: string | undefined;

  // Diagnosis + test-rewrite state. Per the RPG paper §5.3:
  //   - 5-round MV diagnosis attributes each failure
  //   - 20 remediation attempts for test/env errors (separate budget
  //     from the 8 body-debug attempts)
  const diagnosisEnabled = input.diagnosis?.enabled === true;
  const diagnosisRounds = input.diagnosis?.rounds ?? 5;
  const afterFailures = input.diagnosis?.afterFailures ?? 0;
  const maxTestRewrites = input.maxTestRewrites ?? 20;
  let testRewrites = 0;
  let failuresSeen = 0;
  const diagnoses: NonNullable<LeafImplementResult["diagnoses"]> = [];

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const renderedFile = renderTypeScriptFile({
      file: input.hostFile,
      bodyByLeafId: input.bodyByLeafId,
      rpg: input.rpg,
    });
    // Build retry feedback. Two flavors:
    //   - prior attempt returned an empty body → tell the model
    //     directly so it doesn't repeat the mistake.
    //   - prior attempt returned a non-empty body that failed tests →
    //     replay the body and the failing assertion.
    // First attempt (i === 0) gets no feedback.
    let retryFeedback:
      | { previousBody: string; failureMessage: string }
      | undefined;
    if (i > 0) {
      if (priorBodyEmpty) {
        retryFeedback = {
          previousBody: "(empty — your previous response was blank)",
          failureMessage:
            "Your previous response was empty. Return a non-empty function body. Do not include the signature, just the statements.",
        };
      } else {
        retryFeedback = {
          previousBody: body,
          failureMessage: lastFailure?.failureMessage ?? "(no message)",
        };
      }
    }
    const bodyPrompt = buildBodyAuthorUserPrompt({
      leaf: input.leaf,
      hostFile: input.hostFile,
      testSource,
      renderedFile,
      ...(retryFeedback ?? {}),
      // Architect's fresh-approach hint applies only to the FIRST
      // attempt of this re-run. After that the model is iterating on
      // its own attempts; reinforcing the hint when it isn't working
      // would just reinforce the bad strategy.
      ...(i === 0 && input.approachHint
        ? { approachHint: input.approachHint }
        : {}),
    });
    const bodyResponse = await client.chat(
      [
        { role: "system", content: BODY_AUTHOR_SYSTEM_PROMPT },
        { role: "user", content: bodyPrompt },
      ],
      input.temperature !== undefined
        ? { temperature: input.temperature }
        : undefined,
    );
    body = stripCodeFences(bodyResponse.content);
    if (body.length === 0) {
      lastFatal = "body author returned empty content";
      priorBodyEmpty = true;
      continue;
    }
    priorBodyEmpty = false;
    input.bodyByLeafId.set(leafId, body);

    // 3. Run leaf's tests.
    const result = await runTests(input.rpg, {
      bodyByLeafId: input.bodyByLeafId,
      testsByLeafId: input.testsByLeafId,
      leafIds: [leafId],
      workDir: input.workDir,
      ...(input.testTimeoutMs !== undefined
        ? { timeoutMs: input.testTimeoutMs }
        : {}),
    });
    const slug = leafToTestFilename(leafId).replace(".test.ts", "");
    const outcome = result.byLeaf.get(slug);
    if (!outcome) {
      // Vitest emitted no result for this leaf's test. Most often
      // means the suite failed to load (compile error, import error)
      // before any test ran. Surface the harness's stderr so the
      // body author has something actionable; treat as a recoverable
      // failure so the retry loop continues.
      //
      // Important: count this as a failure for diagnostic-budget
      // purposes. The diagnostic can correctly classify a failed-to-
      // load test as `test_brittleness` (e.g., a typo in an import
      // path) or `environment` (missing dep). Without incrementing
      // `failuresSeen`, leaves with malformed tests would burn the
      // entire body-debug budget without ever firing the diagnostic.
      lastFatal =
        result.fatal ?? `vitest reported no outcome for leaf ${leafId}`;
      lastFailure = {
        ok: false,
        failureMessage:
          result.fatal ??
          "vitest produced no results for this leaf (likely a file-load or compile error)",
        testCount: 0,
      };
      failuresSeen++;
      continue;
    }
    if (outcome.ok) {
      return {
        leafId,
        ok: true,
        body,
        testSource,
        attempts,
        testRewrites,
        ...(diagnoses.length > 0 ? { diagnoses } : {}),
      };
    }
    lastFailure = outcome;
    // When the per-leaf failure message is suite-level and stderr
    // carries the real diagnostic, blend them so the retry prompt
    // sees both.
    if (result.fatal && outcome.failureMessage.includes("suite-level")) {
      lastFailure = {
        ...outcome,
        failureMessage: `${outcome.failureMessage}\nstderr:\n${result.fatal}`,
      };
    }
    failuresSeen++;

    // 5-round MV failure diagnosis (RPG paper §5.3 + Algorithm 4
    // step 5). Skips the first `afterFailures` failures to avoid
    // burning judge calls before the body has had any retries; once
    // engaged, runs once per subsequent failure.
    //
    // Also short-circuits once the test-rewrite budget is exhausted:
    // if `testRewrites >= maxTestRewrites`, even a `test_brittleness`
    // verdict can't be acted on, so running the 5-round judge would
    // waste ~5 LLM calls per remaining failure for no behavior
    // change. Two checks below — exhausted budget skips the
    // diagnostic entirely.
    if (
      diagnosisEnabled &&
      failuresSeen > afterFailures &&
      testRewrites < maxTestRewrites
    ) {
      const diag = await diagnoseFailure(client, {
        description: input.leaf.description,
        failureMessage: lastFailure.failureMessage,
        testSource,
        bodySource: body,
        rounds: diagnosisRounds,
      });
      diagnoses.push({
        attempt: attempts,
        category: diag.category,
        votes: diag.votes,
      });

      if (
        diag.category === "test_brittleness" &&
        testRewrites < maxTestRewrites
      ) {
        // Snapshot the original test BEFORE the first rewrite so
        // the orchestrator's recovery paths can restore the
        // original contract. Subsequent rewrites on the same leaf
        // do NOT overwrite the snapshot — the original stays the
        // canonical contract. Skip if no snapshot store was passed.
        if (
          input.originalTestsByLeafId &&
          !input.originalTestsByLeafId.has(leafId)
        ) {
          input.originalTestsByLeafId.set(leafId, testSource);
        }
        // Auto-fix the test. The rewrite is a single test-author
        // call seeded with the rewrite hint + the failure + the
        // body source (the diagnostic vouches that the body is
        // plausibly correct). Validation: the new source must
        // parse as TS; otherwise we keep the prior test.
        const rewritten = await reviseTestForBrittleness(
          client,
          {
            originalUserPrompt: buildTestAuthorUserPrompt({
              leaf: input.leaf,
              hostFile: input.hostFile,
              ownerClassName: input.leaf.ownerClassName ?? undefined,
              renderedFile: renderTypeScriptFile({
                file: input.hostFile,
                bodyByLeafId: input.bodyByLeafId,
                rpg: input.rpg,
              }),
              importSpecifier: testImportSpecifier(input.hostFile.path),
            }),
            priorTestSource: testSource,
            failureMessage: lastFailure.failureMessage,
            rewriteHint: diag.testRewriteHint ?? "(no hint provided)",
            bodySource: body,
          },
          input.temperature,
        );
        if (rewritten.ok && rewritten.testSource) {
          testSource = rewritten.testSource;
          input.testsByLeafId.set(leafId, testSource);
          testRewrites++;
          // Re-run the SAME body against the rewritten test in this
          // same iteration. If it now passes, we return success.
          // If it still fails, the next loop iteration will retry
          // the body — which now correctly sees the new (presumably
          // less brittle) test.
          const rerun = await runTests(input.rpg, {
            bodyByLeafId: input.bodyByLeafId,
            testsByLeafId: input.testsByLeafId,
            leafIds: [leafId],
            workDir: input.workDir,
            ...(input.testTimeoutMs !== undefined
              ? { timeoutMs: input.testTimeoutMs }
              : {}),
          });
          const slug2 = leafToTestFilename(leafId).replace(".test.ts", "");
          const outcome2 = rerun.byLeaf.get(slug2);
          if (outcome2?.ok) {
            return {
              leafId,
              ok: true,
              body,
              testSource,
              attempts,
              testRewrites,
              ...(diagnoses.length > 0 ? { diagnoses } : {}),
            };
          }
          if (outcome2) {
            lastFailure = outcome2;
          }
        }
        // If the rewrite failed to produce a parseable test, fall
        // through to normal body retry — the body author still has
        // budget and may bridge the gap.
      }
      // category === "environment": auto-fix is gated on the
      // future stack/package.json phase. Until then, fall through
      // to body retry as if classified `implementation`.
      // category === "implementation": fall through normally.
    }
  }

  return {
    leafId,
    ok: false,
    body,
    testSource,
    attempts,
    ...(lastFailure ? { lastFailure } : {}),
    ...(lastFatal ? { fatal: lastFatal } : {}),
    testRewrites,
    ...(diagnoses.length > 0 ? { diagnoses } : {}),
  };
}

/**
 * Single-shot test rewrite triggered by a `test_brittleness`
 * diagnosis. Reuses TEST_AUTHOR_SYSTEM_PROMPT and the original test
 * author user prompt, then layers an assistant turn (the failing
 * test) and a corrective user turn carrying the rewrite hint, the
 * failure output, and the body source the diagnostic considered
 * correct.
 *
 * Validates the new source as TypeScript (same gate the initial
 * test author goes through). Returns ok: false if the model emits
 * unparseable source — the caller falls back to the prior test.
 */
async function reviseTestForBrittleness(
  client: LLMClient,
  input: {
    originalUserPrompt: string;
    priorTestSource: string;
    failureMessage: string;
    rewriteHint: string;
    bodySource: string;
  },
  temperature: number | undefined,
): Promise<{ ok: boolean; testSource?: string; error?: string }> {
  const trimmedFailure =
    input.failureMessage.length > 2000
      ? input.failureMessage.slice(0, 2000) + "\n... [truncated]"
      : input.failureMessage;
  const reviseTurn = `Your previous test was diagnosed as brittle by a 5-round majority-vote LLM judge. The body under test is plausibly correct under a reasonable reading of the leaf description; the test itself needs to be rewritten.

Failure output:
\`\`\`
${trimmedFailure}
\`\`\`

Rewrite hint from the diagnostic:
${input.rewriteHint}

Body source the diagnostic considered correct:
\`\`\`
${input.bodySource}
\`\`\`

Rewrite the test so it correctly validates the body's intended behavior per the leaf description, fixing the brittleness. Output ONLY the corrected, complete vitest test file source — no prose, no fences.`;

  try {
    const response = await client.chat(
      [
        { role: "system", content: TEST_AUTHOR_SYSTEM_PROMPT },
        { role: "user", content: input.originalUserPrompt },
        { role: "assistant", content: input.priorTestSource },
        { role: "user", content: reviseTurn },
      ],
      temperature !== undefined ? { temperature } : undefined,
    );
    const candidate = stripCodeFences(response.content);
    if (candidate.length === 0) {
      return { ok: false, error: "test reviser returned empty content" };
    }
    const parse = validateTypeScriptSource(candidate);
    if (!parse.ok) {
      return {
        ok: false,
        error: `test reviser produced unparseable TypeScript: ${parse.error}`,
      };
    }
    return { ok: true, testSource: candidate };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
