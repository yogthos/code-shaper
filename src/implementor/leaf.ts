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
      lastFatal =
        result.fatal ?? `vitest reported no outcome for leaf ${leafId}`;
      lastFailure = {
        ok: false,
        failureMessage:
          result.fatal ??
          "vitest produced no results for this leaf (likely a file-load or compile error)",
        testCount: 0,
      };
      continue;
    }
    if (outcome.ok) {
      return { leafId, ok: true, body, testSource, attempts };
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
  }

  return {
    leafId,
    ok: false,
    body,
    testSource,
    attempts,
    ...(lastFailure ? { lastFailure } : {}),
    ...(lastFatal ? { fatal: lastFatal } : {}),
  };
}
