/**
 * Step Q4-A — standalone test authoring.
 *
 * Test authoring used to live inline in implementLeaf. Pulling it
 * out lets us:
 *   1. Run a phase-5b that authors EVERY leaf's test in parallel
 *      before phase 6 starts. With all tests in hand, step Q4-B
 *      can build a dep graph from test imports and step Q4-C can
 *      schedule leaves with dep gating.
 *   2. Make implementLeaf cheaper on retries — the test contract
 *      is immutable across body retries (excluding brittleness
 *      rewrites), so re-authoring on every attempt is wasteful.
 *
 * Authoring contract: produce a vitest test file that imports the
 * leaf via its host file's relative path and exercises the
 * leaf's signature + description. The test must parse as
 * TypeScript on the first attempt (with a small retry budget for
 * parse failures — the LLM occasionally emits prose).
 */

import path from "node:path";

import type { LLMClient } from "../llm/types.js";
import type {
  FileNode,
  PlannedInterface,
  RPG,
} from "../rpg/types.js";
import { isFile } from "../rpg/types.js";
import {
  TEST_AUTHOR_SYSTEM_PROMPT,
  buildTestAuthorUserPrompt,
  stripCodeFences,
} from "./prompts.js";
import { validateTypeScriptSource } from "./validate-ts.js";
import { renderTypeScriptFile } from "./render.js";

const TEST_FILE_DIR = "tests/leaves";

function testImportSpecifier(hostFilePath: string): string {
  let rel = path.posix.relative(TEST_FILE_DIR, hostFilePath);
  const ext = path.extname(rel);
  if (ext.length > 0) rel = rel.slice(0, -ext.length);
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
  return `${rel}.js`;
}

export interface AuthorTestInput {
  leaf: PlannedInterface;
  hostFile: FileNode;
  rpg: RPG;
  bodyByLeafId: Map<string, string>;
  /** How many times to retry on parse error before giving up.
   *  Default 3 — the LLM usually gets it on the first try; the
   *  retries cover stray-prose cases. */
  maxAttempts?: number;
  temperature?: number;
}

export interface AuthorTestResult {
  ok: boolean;
  testSource: string;
  /** When ok=false: explanation of what went wrong. */
  error?: string;
  /** Number of LLM calls used. */
  attempts: number;
}

const DEFAULT_MAX_TEST_AUTHOR_ATTEMPTS = 3;

export async function authorLeafTest(
  client: LLMClient,
  input: AuthorTestInput,
): Promise<AuthorTestResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_TEST_AUTHOR_ATTEMPTS;
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
  for (let i = 0; i < maxAttempts; i++) {
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
    let response;
    try {
      response = await client.chat(
        messages,
        input.temperature !== undefined
          ? { temperature: input.temperature }
          : undefined,
      );
    } catch (e) {
      return {
        ok: false,
        testSource: "",
        attempts: i + 1,
        error: `test author chat failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const candidate = stripCodeFences(response.content);
    if (candidate.length === 0) {
      return {
        ok: false,
        testSource: priorTestSource ?? "",
        attempts: i + 1,
        error: "test author returned empty content",
      };
    }
    const parse = validateTypeScriptSource(candidate);
    if (parse.ok) {
      return { ok: true, testSource: candidate, attempts: i + 1 };
    }
    priorTestSource = candidate;
    priorParseError = parse.error;
  }
  return {
    ok: false,
    testSource: priorTestSource ?? "",
    attempts: maxAttempts,
    error: `test author produced unparseable TypeScript across ${maxAttempts} attempts; last error: ${priorParseError ?? "(unknown)"}`,
  };
}

// ── authorAllLeafTests ───────────────────────────────────────────────

export interface AuthorAllInput {
  bodyByLeafId: Map<string, string>;
  /** Pre-existing tests (e.g. authored in a prior run, or
   *  injected by the caller) are SKIPPED — only leaves missing a
   *  test entry get authored. */
  testsByLeafId: Map<string, string>;
  /** How many leaves to author concurrently. Default 4 — test
   *  authoring is cheap (one chat call per leaf with 3 retries
   *  max) and provider rate-limits are usually fine at this
   *  level. */
  maxConcurrent?: number;
  /** Per-leaf parse retry budget. Forwarded to authorLeafTest. */
  maxAttemptsPerLeaf?: number;
  temperature?: number;
  /** Optional progress callback fired before/after each leaf. */
  onProgress?: (event: TestAuthorProgressEvent) => void;
}

export interface TestAuthorProgressEvent {
  phase: "start" | "done";
  leafCapabilityId: string;
  leafName: string;
  /** Set on phase: "done". */
  ok?: boolean;
  /** Set on phase: "done" when ok=false. */
  error?: string;
}

export interface AuthorAllResult {
  /** True iff every leaf either had a test pre-populated OR one
   *  was authored successfully. */
  ok: boolean;
  /** Number of NEW tests this call wrote into testsByLeafId. */
  authored: number;
  /** Failures collected. Empty when ok=true. */
  failures: Array<{ leafCapabilityId: string; leafName: string; error: string }>;
}

const DEFAULT_AUTHOR_CONCURRENCY = 4;

export async function authorAllLeafTests(
  client: LLMClient,
  rpg: RPG,
  input: AuthorAllInput,
): Promise<AuthorAllResult> {
  // Collect every leaf in the RPG that has an interfacePlan
  // entry. Skip leaves with a pre-populated test source (e.g.,
  // resumption from a prior run, or test injected by the caller
  // for a unit test).
  interface PendingLeaf {
    leaf: PlannedInterface;
    hostFile: FileNode;
  }
  const pending: PendingLeaf[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node) || !node.interfacePlan) continue;
    for (const entry of node.interfacePlan.entries) {
      if (input.testsByLeafId.has(entry.leafCapabilityId)) continue;
      pending.push({ leaf: entry, hostFile: node });
    }
  }
  if (pending.length === 0) {
    return { ok: true, authored: 0, failures: [] };
  }
  const maxConcurrent = Math.max(
    1,
    input.maxConcurrent ?? DEFAULT_AUTHOR_CONCURRENCY,
  );
  let cursor = 0;
  let authored = 0;
  const failures: AuthorAllResult["failures"] = [];

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= pending.length) return;
      const { leaf, hostFile } = pending[idx]!;
      input.onProgress?.({
        phase: "start",
        leafCapabilityId: leaf.leafCapabilityId,
        leafName: leaf.name,
      });
      const r = await authorLeafTest(client, {
        leaf,
        hostFile,
        rpg,
        bodyByLeafId: input.bodyByLeafId,
        ...(input.maxAttemptsPerLeaf !== undefined
          ? { maxAttempts: input.maxAttemptsPerLeaf }
          : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
      });
      if (r.ok) {
        input.testsByLeafId.set(leaf.leafCapabilityId, r.testSource);
        authored++;
        input.onProgress?.({
          phase: "done",
          leafCapabilityId: leaf.leafCapabilityId,
          leafName: leaf.name,
          ok: true,
        });
      } else {
        failures.push({
          leafCapabilityId: leaf.leafCapabilityId,
          leafName: leaf.name,
          error: r.error ?? "(no error detail)",
        });
        input.onProgress?.({
          phase: "done",
          leafCapabilityId: leaf.leafCapabilityId,
          leafName: leaf.name,
          ok: false,
          error: r.error ?? "(no error detail)",
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: maxConcurrent }, () => worker()),
  );
  return { ok: failures.length === 0, authored, failures };
}
