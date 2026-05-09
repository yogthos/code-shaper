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
import { editLeafViaTools, type ToolName } from "./edit-author.js";
import { runLeafDevLoop } from "./dev-loop.js";
import {
  extractFunctionBody,
  extractMethodBody,
} from "./edit-tools.js";
import { applyEnvFixViaTools } from "./env-fix.js";
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
  /** Project directory containing package.json. Required when
   *  env-fix is enabled (the diagnostic's `environment` branch
   *  mutates package.json + node_modules at this path). */
  projectDir?: string;
  /** Per-leaf budget for env-fix remediations triggered by an
   *  `environment` diagnosis. Shares the same paper §5.3 spirit
   *  as `maxTestRewrites`. Default 5 — env issues should resolve
   *  in a few patches; more typically signals the diagnosis is
   *  wrong. Requires `projectDir` and `enableEnvFix`. */
  maxEnvPatches?: number;
  /** Enable env-fix on `environment` diagnostic verdicts. Default
   *  false. Production drivers opt in; tests opt out so they
   *  don't need a stub npm binary. Requires `projectDir`. */
  enableEnvFix?: boolean;
  /** Override the npm binary used by env-fix (tests). */
  envFixNpmBinary?: string;
  /** Skip the npm install re-run inside env-fix (tests; or when
   *  the harness reuses a pre-populated node_modules). */
  envFixSkipNpmInstall?: boolean;
  /** When true, replace the streaming body-author with the §D.2
   *  tool-using edit author: the LLM is given the rendered file
   *  source plus the leaf's task and picks `edit_function_in_file`
   *  or `edit_method_of_class_in_file` (depending on the leaf
   *  kind), emits structured args, and the harness applies the
   *  tool. The leaf's body is then extracted from the new file
   *  source via tree-sitter and stored in `bodyByLeafId` so the
   *  renderer continues to drive subsequent leaves on the same
   *  file consistently. Default false; production drivers opt in. */
  useEditTools?: boolean;
  /** When true, replace the body-author + §D.2 path with the
   *  full multi-turn dev loop (`runLeafDevLoop`): the model gets
   *  read tools (list_files, read_file), edit tools (edit_file
   *  string-replace + the §D.2 surgical tools), probes
   *  (typecheck, run_test), and Terminate. Within ONE chat
   *  session it can explore the project, edit, run tests, and
   *  decide it's done. Subsumes `useEditTools`. Default false;
   *  production drivers opt in. */
  useDevLoop?: boolean;
  /** Per-dev-loop iteration budget. Default 15. */
  devLoopMaxIterations?: number;
  /** Optional project-context digest forwarded to the dev loop's
   *  user prompt. Synthesized once by the orchestrator. */
  projectContext?: string;
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
  /** Aggregated dev-loop trail entries across attempts. Surfaced
   *  so the orchestrator can scan for cross-cutting failure
   *  patterns (npm install errors, etc.) and lift them into
   *  shared learnedFacts for subsequent leaves. */
  devLoopTrail?: Array<{
    tool: string;
    args?: Record<string, unknown>;
    ok: boolean;
    error?: string;
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
  // V3: when useDevLoop is on, the dev loop's TDD model means the
  // model writes its OWN tests via edit_file. Skip the harness-
  // level test author entirely. The §D.2 / streaming author
  // paths still use it.
  if (!testSource && !input.useDevLoop) {
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
  /** Step Q4-D: count consecutive dev-loop exhaustions. When the
   *  dev loop runs to its iteration budget without calling
   *  Terminate, more retries on the same leaf rarely help — each
   *  retry burns ~15 LLM calls. Cap at 2 such exhaustions before
   *  giving up so we don't burn 8 × 15 = 120 calls per stuck
   *  leaf. */
  let devLoopExhaustedCount = 0;
  const MAX_DEV_LOOP_EXHAUSTIONS = 2;

  // Diagnosis + test-rewrite state. Per the RPG paper §5.3:
  //   - 5-round MV diagnosis attributes each failure
  //   - 20 remediation attempts for test/env errors (separate budget
  //     from the 8 body-debug attempts)
  const diagnosisEnabled = input.diagnosis?.enabled === true;
  const diagnosisRounds = input.diagnosis?.rounds ?? 5;
  const afterFailures = input.diagnosis?.afterFailures ?? 0;
  const maxTestRewrites = input.maxTestRewrites ?? 20;
  const maxEnvPatches = input.maxEnvPatches ?? 5;
  const envFixEnabled =
    input.enableEnvFix === true && typeof input.projectDir === "string";
  let testRewrites = 0;
  let envPatches = 0;
  let failuresSeen = 0;
  const diagnoses: NonNullable<LeafImplementResult["diagnoses"]> = [];
  const aggregatedDevLoopTrail: NonNullable<LeafImplementResult["devLoopTrail"]> =
    [];
  // Audit gap #5: per-leaf trail of prior diagnostic verdicts +
  // remediations. Threaded into each subsequent diagnostic call so
  // the judge sees what was already tried and can pick a different
  // category when the prior remediation didn't resolve the failure.
  const priorAttempts: NonNullable<
    Parameters<typeof diagnoseFailure>[1]["priorAttempts"]
  > = [];

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const renderedFile = renderTypeScriptFile({
      file: input.hostFile,
      bodyByLeafId: input.bodyByLeafId,
      rpg: input.rpg,
    });
    // Build retry feedback. Three flavors, in priority order:
    //   - prior attempt's TOOL/AUTHOR refused (edit-tool rejected
    //     the new source, body author returned empty, etc.). Surface
    //     `lastFatal` verbatim so the model sees the actual refusal
    //     reason — without this, every refusal collapses to a canned
    //     "your response was empty" message and the model repeats
    //     the same naming bug forever.
    //   - prior attempt produced a body that ran but failed a test.
    //     Replay the body + the assertion message.
    //   - first attempt (i === 0): no feedback.
    let retryFeedback:
      | { previousBody: string; failureMessage: string }
      | undefined;
    if (i > 0) {
      if (lastFatal && priorBodyEmpty) {
        // Prior attempt didn't produce a usable body — show the
        // actual refusal reason rather than a canned "blank
        // response" message. lastFatal is set by:
        //   - body author returned empty content
        //   - edit author tool call refused (wrong name, parse
        //     error, etc.)
        //   - vitest produced no outcome (suite-level load fail)
        retryFeedback = {
          previousBody: body || "(no body produced this attempt)",
          failureMessage: lastFatal,
        };
      } else if (lastFailure) {
        retryFeedback = {
          previousBody: body,
          failureMessage: lastFailure.failureMessage,
        };
      }
    }
    if (input.useDevLoop) {
      // Dev-loop author: multi-turn agent with read/edit/probe
      // tools. The model can call list_files / read_file to
      // explore the project, edit the active file (string-
      // replace via edit_file or §D.2 surgical tools), run
      // typecheck + run_test mid-session, and call Terminate
      // when it believes the leaf is done. We then run the test
      // ONCE more below to verify; ok=true here just means the
      // model committed.
      const r = await runLeafDevLoop(client, {
        leaf: input.leaf,
        hostFile: input.hostFile,
        rpg: input.rpg,
        bodyByLeafId: input.bodyByLeafId,
        testsByLeafId: input.testsByLeafId,
        workDir: input.workDir,
        ...(input.projectDir !== undefined ? { outDir: input.projectDir } : {}),
        ...(input.projectContext !== undefined
          ? { projectContext: input.projectContext }
          : {}),
        ...(retryFeedback?.failureMessage !== undefined
          ? { failureMessage: retryFeedback.failureMessage }
          : {}),
        ...(input.devLoopMaxIterations !== undefined
          ? { maxIterations: input.devLoopMaxIterations }
          : {}),
        ...(input.testTimeoutMs !== undefined
          ? { testTimeoutMs: input.testTimeoutMs }
          : {}),
        ...(input.envFixNpmBinary !== undefined
          ? { npmBinary: input.envFixNpmBinary }
          : {}),
        ...(input.envFixSkipNpmInstall !== undefined
          ? { skipNpmInstall: input.envFixSkipNpmInstall }
          : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
      });
      for (const t of r.trail) {
        aggregatedDevLoopTrail.push({
          tool: t.tool,
          args: t.args,
          ok: t.ok,
          ...(t.error ? { error: t.error } : {}),
        });
      }
      if (!r.ok || !r.body) {
        // Treat as if the body was empty so the loop's standard
        // empty-body retry path kicks in. The trail's tail is
        // surfaced as lastFatal so the next attempt's prompt
        // shows what the agent did before giving up.
        const tail = r.trail
          .slice(-3)
          .map(
            (t) =>
              `${t.tool}(${JSON.stringify(t.args)})${t.error ? " → " + t.error.slice(0, 200) : t.summary ? " → " + t.summary : ""}`,
          )
          .join(" | ");
        lastFatal = `dev loop failed: ${r.error ?? "no body produced"}${tail ? ` [trail: ${tail}]` : ""}`;
        priorBodyEmpty = true;
        // Step Q4-D: detect "exhausted without Terminate" — when
        // the dev loop hit its iteration budget without the
        // model committing, retries rarely help. Bail out early
        // after MAX_DEV_LOOP_EXHAUSTIONS to avoid burning the
        // full leaf retry budget on the same stuck state.
        if (r.error && /exhausted/.test(r.error)) {
          devLoopExhaustedCount++;
          if (devLoopExhaustedCount >= MAX_DEV_LOOP_EXHAUSTIONS) {
            lastFatal = `${lastFatal} [bailing after ${devLoopExhaustedCount} dev-loop exhaustions; further retries unlikely to help]`;
            break;
          }
        }
        continue;
      }
      body = r.body;
      priorBodyEmpty = false;
      lastFatal = undefined;
      devLoopExhaustedCount = 0;
      // V3: the dev loop's TDD model means the model wrote its
      // own tests AND ran them via run_test before calling
      // Terminate. Trust the terminal state — return ok now
      // without a duplicate post-loop verify. Phase 7b will
      // run all project tests as the final correctness gate.
      return {
        leafId,
        ok: true,
        body,
        testSource: input.testsByLeafId.get(leafId) ?? "",
        attempts: i + 1,
        ...(input.diagnosis ? {} : {}),
        testRewrites,
        ...(aggregatedDevLoopTrail.length > 0
          ? { devLoopTrail: aggregatedDevLoopTrail }
          : {}),
      };
    } else if (input.useEditTools) {
      // §D.2 tool-using author: the LLM picks an edit tool scoped
      // to this leaf's kind, emits structured args, the harness
      // applies the tool to the rendered file, and we extract the
      // body for `bodyByLeafId` so the renderer drives subsequent
      // leaves consistently.
      //
      // Tool restriction: methods only get edit_method_of_class_in_file;
      // free-standing functions only get edit_function_in_file. The
      // imports tool is intentionally NOT exposed here — imports
      // are owned by the architect's operation vocabulary and
      // refreshed on every plan mutation. Letting the body author
      // edit imports would race with that flow.
      const allowedTools: ToolName[] =
        input.leaf.kind === "method"
          ? ["edit_method_of_class_in_file"]
          : ["edit_function_in_file"];
      const taskDescription = buildEditTaskDescription(
        input.leaf,
        i === 0 && input.approachHint ? input.approachHint : null,
      );
      const editResult = await editLeafViaTools(client, {
        fileSource: renderedFile,
        filePath: input.hostFile.path,
        taskDescription,
        testSource,
        allowedTools,
        ...(retryFeedback?.failureMessage !== undefined
          ? { failureMessage: retryFeedback.failureMessage }
          : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
      });
      if (!editResult.ok || !editResult.source) {
        lastFatal = `edit author failed: ${editResult.error ?? "(unknown)"}`;
        // Treat as if the body was empty — the loop logic already
        // handles "no usable body this attempt" via priorBodyEmpty.
        priorBodyEmpty = true;
        continue;
      }
      // Extract the leaf's body STATEMENTS from the edited file
      // source. This is what the renderer wants in bodyByLeafId.
      const extracted =
        input.leaf.kind === "method" && input.leaf.ownerClassName
          ? extractMethodBody(
              editResult.source,
              input.leaf.ownerClassName,
              input.leaf.name,
            )
          : extractFunctionBody(editResult.source, input.leaf.name);
      if (!extracted) {
        lastFatal = `edit author produced source missing the target ${input.leaf.kind} ${input.leaf.name}`;
        priorBodyEmpty = true;
        continue;
      }
      body = extracted;
      priorBodyEmpty = false;
      // Clear lastFatal — the prior refusal was just resolved by
      // this attempt's successful edit. Next iteration's retry
      // feedback should reflect any NEW failure (test outcome),
      // not stale tool-refusal text.
      lastFatal = undefined;
      input.bodyByLeafId.set(leafId, body);
    } else {
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
        // Prior body was empty — but include what the model actually
        // returned (often prose without code fences) so the retry
        // prompt is informative, not "your response was empty".
        lastFatal = `body author returned empty content. Raw response head: ${bodyResponse.content.slice(0, 600).replace(/\s+/g, " ")}`;
        priorBodyEmpty = true;
        continue;
      }
      priorBodyEmpty = false;
      lastFatal = undefined;
      input.bodyByLeafId.set(leafId, body);
    }

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
      // Review fix #9: do NOT `continue` here — the diagnostic
      // block at the bottom of the iteration is the whole point
      // of the failuresSeen accounting. A suite-level failure
      // (compile error, import typo, missing dep) is exactly the
      // case the diagnostic should classify as `environment` or
      // `test_brittleness`. The previous `continue` jumped over
      // the diagnostic, leaving file-load failures to burn the
      // entire body-debug budget without ever firing it.
      failuresSeen++;
    } else if (outcome.ok) {
      return {
        leafId,
        ok: true,
        body,
        testSource,
        attempts,
        testRewrites,
        ...(diagnoses.length > 0 ? { diagnoses } : {}),
      };
    } else {
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
    }

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
        ...(priorAttempts.length > 0 ? { priorAttempts } : {}),
      });
      diagnoses.push({
        attempt: attempts,
        category: diag.category,
        votes: diag.votes,
      });
      // Default remediation summary; overwritten when the verdict
      // routes to a specific tool below.
      let remediation =
        diag.category === "implementation"
          ? "no remediation — body retry only"
          : "(none)";
      // We record this AFTER the verdict-routing block sets a
      // specific remediation summary. See pushPriorAttempt() calls
      // below.
      const recordPriorAttempt = (final: string): void => {
        priorAttempts.push({
          category: diag.category,
          remediation: final,
          // The leaf-retry contract: if we're back here on the next
          // iteration, the prior remediation didn't resolve the
          // failure. Mark `no_progress`. (When env-fix's rerun
          // succeeds we early-return; the diagnostic only sees
          // priorAttempts when we kept iterating.)
          outcome: "no_progress",
        });
      };
      void remediation;

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
        recordPriorAttempt(
          `rewrote test (rewrite ${testRewrites > 0 ? "applied" : "skipped"}); rerun still failing`,
        );
      }
      // category === "environment" (Stage C of feature #5): when
      // env-fix is enabled, the model picks one of the four npm-
      // mutation tools (add_dependency / remove_dependency /
      // set_script / npm_run) and the harness applies it via the
      // npm-tools primitives. We then re-run the SAME test against
      // the SAME body — if the failure was indeed env-related, the
      // rerun passes without burning body-author retries. If
      // env-fix fails OR the rerun still fails, fall through to
      // body retry. Bounded by `maxEnvPatches`.
      if (
        diag.category === "environment" &&
        envFixEnabled &&
        envPatches < maxEnvPatches
      ) {
        const envFix = await applyEnvFixViaTools(client, {
          projectDir: input.projectDir!,
          envPatchHint: diag.envPatchHint ?? "(no hint provided)",
          failureMessage: lastFailure.failureMessage,
          bodySource: body,
          testSource,
          ...(input.envFixNpmBinary !== undefined
            ? { npmBinary: input.envFixNpmBinary }
            : {}),
          ...(input.envFixSkipNpmInstall !== undefined
            ? { skipNpmInstall: input.envFixSkipNpmInstall }
            : {}),
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
        });
        // Review fix #6: only count toward `envPatches` when at
        // least one tool call in the trail actually changed disk
        // state. Probes (npm_run) and no-op idempotent calls
        // (add_dependency at matching version) shouldn't burn
        // budget.
        const realChange = envFix.trail.some(
          (e) =>
            (e.tool === "add_dependency" ||
              e.tool === "remove_dependency" ||
              e.tool === "set_script") &&
            e.npmResult?.ok === true &&
            e.npmResult.changed === true,
        );
        if (realChange) envPatches++;

        // Review fix #7: re-run the test even when `envFix.ok` is
        // false, IF any tool call in the trail landed a
        // package.json mutation (installRan but install exited
        // non-zero, or set_script). The mutation may already be
        // sufficient given the host repo's installed deps; a
        // transient network failure on `npm install` shouldn't
        // gate the rerun.
        const shouldRerun = envFix.ok || realChange;
        if (shouldRerun) {
          // Re-run the test against the same body. If it now passes,
          // the env was indeed the issue.
          const rerun = await runTests(input.rpg, {
            bodyByLeafId: input.bodyByLeafId,
            testsByLeafId: input.testsByLeafId,
            leafIds: [leafId],
            workDir: input.workDir,
            ...(input.testTimeoutMs !== undefined
              ? { timeoutMs: input.testTimeoutMs }
              : {}),
          });
          const slug3 = leafToTestFilename(leafId).replace(".test.ts", "");
          const outcome3 = rerun.byLeaf.get(slug3);
          if (outcome3?.ok) {
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
          if (outcome3) {
            lastFailure = outcome3;
          }
        }
        // env-fix failed or test still red — fall through to body
        // retry. Audit gaps #3 / #21 (stderr propagation): blend the
        // env-fix outcome into lastFailure so the NEXT retry's
        // prompt sees what env-fix actually did and what failed.
        // Without this, the body author keeps retrying as if nothing
        // changed and never learns that the dep it's trying to use
        // doesn't compile (e.g., better-sqlite3 vs node 26's V8 API).
        const envFixSummary = summarizeEnvFix(envFix);
        if (envFixSummary && lastFailure) {
          lastFailure = {
            ...lastFailure,
            failureMessage: `${lastFailure.failureMessage}\n\n[env-fix attempt]\n${envFixSummary}`,
          };
        }
        recordPriorAttempt(
          envFix.trail.length > 0
            ? `env-fix trail: ${envFix.trail
                .map(
                  (e) =>
                    `${e.tool}(${JSON.stringify(e.args)})${
                      e.npmResult
                        ? ` → installRan=${e.npmResult.installRan} installOk=${e.npmResult.installOk}`
                        : e.error
                          ? ` → error: ${e.error.slice(0, 100)}`
                          : ""
                    }`,
                )
                .join("; ")} → ${envFix.ok ? "rerun still failing" : "no-op or failed: " + (envFix.error ?? "(no error)").slice(0, 200)}`
            : "env-fix produced no tool calls",
        );
      } else if (diag.category === "implementation") {
        recordPriorAttempt("body retry (no test/env intervention)");
      }
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
    ...(aggregatedDevLoopTrail.length > 0
      ? { devLoopTrail: aggregatedDevLoopTrail }
      : {}),
  };
}

/**
 * Summarize an env-fix attempt for the next retry's prompt. The
 * goal is the body author seeing exactly what the harness tried,
 * what failed, and what the install-time error actually was — so
 * a busted dependency choice (better-sqlite3 vs current node V8,
 * version not on the registry, etc.) reaches the model the next
 * time it composes a body or picks a different env-fix tool.
 *
 * Format:
 *
 *   tool=add_dependency args={"name":"foo","version":"^1","which":"runtime"}
 *   ok=false  installRan=true  exitCode=1
 *   error: <error string the npm-tool returned>
 *   stderr (last 2000 chars):
 *   <tail of npm install stderr — npm puts the actionable error LAST>
 */
function summarizeEnvFix(
  envFix: import("./env-fix.js").EnvFixResult,
): string | null {
  if (envFix.trail.length === 0 && !envFix.error) return null;
  const lines: string[] = [];
  lines.push(
    `iterations=${envFix.iterations}  ok=${envFix.ok}  terminatedExplicitly=${envFix.terminatedExplicitly}`,
  );
  if (envFix.error) {
    lines.push(`session error: ${envFix.error}`);
  }
  // Walk the trail in order. For each entry we emit one summary
  // line + tail-truncated stderr/stdout when the tool call was
  // an npm op. The body author needs to see what was tried in
  // sequence so it can avoid repeating the same dead end.
  envFix.trail.forEach((entry, idx) => {
    // Audit issue #5: render `_invalid` entries (multi-call /
    // unknown-tool / JSON-parse rejections) as a clear refusal
    // line so the body author isn't misled into thinking
    // env-fix did something useful.
    const label =
      entry.tool === "_invalid"
        ? `[step ${idx + 1}] (refused before apply)`
        : `[step ${idx + 1}] ${entry.tool}(${JSON.stringify(entry.args)})`;
    lines.push(`\n${label}`);
    const npm = entry.npmResult;
    if (npm) {
      const exitCode =
        "exitCode" in npm ? (npm as { exitCode?: unknown }).exitCode : "n/a";
      lines.push(
        `  ok=${npm.ok}  installRan=${npm.installRan}  installOk=${npm.installOk}  exitCode=${exitCode}`,
      );
      if (npm.error) lines.push(`  error: ${npm.error}`);
      if (npm.installStderr) {
        const tail =
          npm.installStderr.length > 2000
            ? "...[truncated head]\n" +
              npm.installStderr.slice(npm.installStderr.length - 2000)
            : npm.installStderr;
        lines.push(`  stderr:\n${tail}`);
      }
      if (npm.installStdout) {
        const tail =
          npm.installStdout.length > 1000
            ? "...[truncated head]\n" +
              npm.installStdout.slice(npm.installStdout.length - 1000)
            : npm.installStdout;
        lines.push(`  stdout (tail):\n${tail}`);
      }
    } else if (entry.error) {
      lines.push(`  agent-side error: ${entry.error}`);
    }
  });
  return lines.join("\n");
}

/**
 * Plain-language task brief for the tool-using edit author. Wraps
 * the leaf's name + signature + description, plus an optional
 * approach hint when the orchestrator's fresh_approach recovery
 * fired on this leaf. The edit author already sees the rendered
 * file source separately; this is just the "what to do" prose.
 */
function buildEditTaskDescription(
  leaf: PlannedInterface,
  approachHint: string | null,
): string {
  const lines: string[] = [];
  if (leaf.kind === "method" && leaf.ownerClassName) {
    lines.push(
      `Implement method \`${leaf.ownerClassName}.${leaf.name}\` so it satisfies the test below.`,
    );
  } else {
    lines.push(
      `Implement function \`${leaf.name}\` so it satisfies the test below.`,
    );
  }
  lines.push("");
  lines.push("Description:");
  lines.push(leaf.description.trim());
  lines.push("");
  lines.push("Signature:");
  const params = leaf.signature.params
    .map((p) => `${p.name}: ${p.type}`)
    .join(", ");
  const asyncPrefix = leaf.signature.isAsync ? "async " : "";
  lines.push(
    `${asyncPrefix}${leaf.name}(${params}): ${leaf.signature.returnType}`,
  );
  if (approachHint) {
    lines.push("");
    lines.push("Architect's fresh-approach hint (must follow):");
    lines.push(approachHint);
  }
  return lines.join("\n");
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
