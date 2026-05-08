/**
 * Phase 7b — branch-level integration tests.
 *
 * Runs after `buildImplementations` returns ok=true (every leaf has
 * passed its OWN unit tests). For each branch — a non-leaf capability
 * whose subtree contains ≥2 leaves — the architect authors a single
 * integration test that exercises how those leaves compose. We then
 * run all integration tests via the existing harness.
 *
 * On failure: ask the architect for a leaf-blame attribution
 * (returns a culprit leaf id + a Phase 7a recovery action —
 * fresh_approach hint or decompose plan). Apply the recovery,
 * re-implement the affected leaf via `implementLeaf`, re-run only
 * the failing branches' tests. Bounded by `MAX_INTEGRATION_ROUNDS`.
 */

import path from "node:path";

import type { LLMClient } from "../llm/types.js";
import {
  isFile,
  type CapabilityNode,
  type NodeId,
  type PlannedInterface,
  type RPG,
} from "../rpg/types.js";
import {
  applyPresetDecomposition,
  type DecomposeRequest,
  type SubLeafSpec,
} from "./decompose.js";
import { implementLeaf } from "./leaf.js";
import { stripCodeFences } from "./prompts.js";
import { localize } from "../architect/localization.js";
import {
  outcomeForBranch,
  runTests,
  type TestRunResult,
} from "./test-harness.js";
import {
  INTEGRATION_BLAME_SYSTEM_PROMPT,
  INTEGRATION_TEST_AUTHOR_SYSTEM_PROMPT,
  buildIntegrationBlameUserPrompt,
  buildIntegrationTestAuthorUserPrompt,
  discoverBranches,
  renderBranchDataFlow,
  type DiscoveredBranch,
} from "./integration-prompts.js";

/**
 * Default integration-recovery budget. Matches §5.3 of the RPG paper,
 * which specifies "20 remediation attempts for test or environment
 * errors" per failing branch. Was 5; bumped 2026-05-08 to match the
 * paper after observing premature integration failures on TodoMVC.
 *
 * The `IntegrationInput.maxIntegrationRounds` override exists so tests
 * with deterministic permanent-failure mocks (which would otherwise
 * spin all 20 rounds) can cap themselves at a smaller number.
 */
export const MAX_INTEGRATION_ROUNDS = 20;
const TEST_FILE_DIR = "tests/integration";

export interface IntegrationInput {
  /** Already-populated body source per leaf, from a successful Phase
   *  6 + 7a build. The integration phase may extend or rewrite
   *  individual entries when recovery fires. */
  bodyByLeafId: Map<string, string>;
  /** Already-populated leaf test source. The integration phase reads
   *  these unchanged (leaves' contracts don't move) but it may add
   *  new entries when a decompose recovery introduces sub-leaves. */
  testsByLeafId: Map<string, string>;
  /** Harness work directory shared with `buildImplementations`. */
  workDir: string;
  maxAttemptsPerLeaf?: number;
  perLeafTimeoutMs?: number;
  branchRunTimeoutMs?: number;
  temperature?: number;
  /** Override the recovery-round budget (default
   *  MAX_INTEGRATION_ROUNDS = 20). Used by tests that drive
   *  permanently-failing recovery and don't want to spin 20 rounds. */
  maxIntegrationRounds?: number;
  /** §D.1 tool-using localization run before each blame
   *  attribution. The localization output is fed into the blame
   *  prompt as EXTRA context (a ranked candidate list); the blame
   *  call still picks the culprit. Default off so existing tests
   *  see the legacy single-shot blame. Production drivers opt in.
   *  `maxIterations` defaults to 20 per RPG paper §5.3. */
  useLocalization?: boolean;
  localizationMaxIterations?: number;
}

export interface IntegrationResult {
  ok: boolean;
  /** Integration tests authored, by branch capability id. */
  testsByBranchId: Map<string, string>;
  /** Most recent test run; `byBranch` carries per-branch outcomes. */
  finalRun?: TestRunResult;
  /** Architect-driven recoveries, in chronological order. */
  recoveries: Array<{
    /** 1-based index of the integration round this recovery fired in.
     *  Helpful for reading the trail when multiple recoveries land
     *  in the same run. */
    round: number;
    branchId: NodeId;
    culpritLeafId: NodeId;
    decision: "fresh_approach" | "decompose";
    reason: string;
    /** When the harness tried to apply this recovery and the apply
     *  step itself failed (sub-leaf body never satisfied its unit
     *  tests, decompose introduced unbuildable sub-leaves, etc.).
     *  The integration loop continues to the next round so blame
     *  can pick a different culprit or decision. */
    applyError?: string;
  }>;
  /** Branches that still have failing integration tests after the
   *  loop exhausts. Empty when ok=true. */
  failingBranchIds: NodeId[];
  rounds: number;
  error?: string;
}

export async function runIntegrationTests(
  client: LLMClient,
  rpg: RPG,
  input: IntegrationInput,
): Promise<IntegrationResult> {
  const branches = discoverBranches(rpg);
  if (branches.length === 0) {
    return {
      ok: true,
      testsByBranchId: new Map(),
      recoveries: [],
      failingBranchIds: [],
      rounds: 0,
    };
  }

  // Pre-flight: every leaf in every branch must be mapped to a real
  // file. An unmapped leaf would produce a broken integration test
  // (import from `<unmapped>`) and waste an entire LLM round.
  const unmapped: Array<{ branchId: NodeId; leafId: NodeId }> = [];
  for (const b of branches) {
    for (const l of b.leaves) {
      if (!l.capability.mappedToId) {
        unmapped.push({ branchId: b.branch.id, leafId: l.capability.id });
      }
    }
  }
  if (unmapped.length > 0) {
    const detail = unmapped
      .map(({ branchId, leafId }) => `${branchId} → ${leafId}`)
      .join(", ");
    return {
      ok: false,
      testsByBranchId: new Map(),
      recoveries: [],
      failingBranchIds: branches.map((b) => b.branch.id),
      rounds: 0,
      error: `cannot run integration tests; unmapped leaf(es) detected: ${detail}`,
    };
  }

  const testsByBranchId = new Map<string, string>();
  const recoveries: IntegrationResult["recoveries"] = [];

  // Author one integration test per branch.
  for (const b of branches) {
    const source = await authorBranchTest(client, rpg, b, input.temperature);
    if (!source) {
      return {
        ok: false,
        testsByBranchId,
        recoveries,
        failingBranchIds: branches.map((br) => br.branch.id),
        rounds: 0,
        error: `integration test author returned empty content for branch ${b.branch.id}`,
      };
    }
    testsByBranchId.set(b.branch.id, source);
  }

  let lastRun: TestRunResult | undefined;
  let rounds = 0;
  // Per-branch status carried across rounds. Branches start as
  // failing (we haven't run them yet); after each round, we update
  // ONLY the branches that were in the round's filter — branches
  // that already passed in an earlier round retain their status.
  const branchStatus = new Map<string, "failing" | "passing">();
  for (const b of branches) branchStatus.set(b.branch.id, "failing");

  const maxRounds = input.maxIntegrationRounds ?? MAX_INTEGRATION_ROUNDS;
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const failingBranchIds = [...branchStatus.entries()]
      .filter(([, status]) => status === "failing")
      .map(([id]) => id);
    lastRun = await runTests(rpg, {
      bodyByLeafId: input.bodyByLeafId,
      testsByLeafId: input.testsByLeafId,
      integrationTestsByBranchId: testsByBranchId,
      branchIds: failingBranchIds,
      workDir: input.workDir,
      ...(input.branchRunTimeoutMs !== undefined
        ? { timeoutMs: input.branchRunTimeoutMs }
        : {}),
    });

    // Update status ONLY for branches that ran this round. Branches
    // we filtered out aren't in lastRun.byBranch and stay at their
    // prior (passing) status.
    for (const branchId of failingBranchIds) {
      const outcome = outcomeForBranch(lastRun, branchId);
      if (outcome && outcome.ok) {
        branchStatus.set(branchId, "passing");
      } else {
        branchStatus.set(branchId, "failing");
      }
    }

    const stillFailing = [...branchStatus.entries()]
      .filter(([, s]) => s === "failing")
      .map(([id]) => id);
    if (stillFailing.length === 0) {
      return {
        ok: true,
        testsByBranchId,
        finalRun: lastRun,
        recoveries,
        failingBranchIds: [],
        rounds,
      };
    }

    // Recovery: pick the FIRST still-failing branch this round.
    const targetBranchId = stillFailing[0]!;
    const branch = branches.find((b) => b.branch.id === targetBranchId);
    if (!branch) {
      return {
        ok: false,
        testsByBranchId,
        finalRun: lastRun,
        recoveries,
        failingBranchIds: stillFailing,
        rounds,
        error: `failing branch ${targetBranchId} not found in discovered set`,
      };
    }
    const branchOutcome = outcomeForBranch(lastRun, targetBranchId);
    const failureMessage =
      branchOutcome?.failureMessage ?? lastRun.fatal ?? "(no failure detail)";
    const branchTestSource = testsByBranchId.get(targetBranchId) ?? "";

    // §D.1 localization pre-pass (opt-in). Navigates the RPG via
    // the four data tools to produce a ranked candidate list; the
    // result feeds the blame prompt as EXTRA context. The blame
    // call still picks the culprit — localization just biases the
    // model toward interfaces the failure mentioned.
    let localizationHint:
      | Array<{ filePath: string; interface: string }>
      | undefined;
    if (input.useLocalization) {
      // Review fix #9: default 8 iterations (vs the §5.3 paper-wide
      // 20) when invoked from integration recovery. Recovery loops
      // already have 20 rounds × N branches; running the localize
      // agent at full 20-iteration budget per round means hundreds
      // of localization LLM calls per failing branch. The blame
      // model has full branch context regardless — localization
      // is a hint, not a substitute, so a tighter budget is the
      // right tradeoff.
      // Review fix #8: localize() can throw (LLM client timeout,
      // 5xx after retries exhausted). The comment claimed
      // "non-fatal" but a thrown error would have crashed the
      // whole integration round. Wrap in try/catch and fall
      // through without the hint on any failure.
      const localizationBudget = input.localizationMaxIterations ?? 8;
      try {
        const loc = await localize(client, {
          rpg,
          task: `Integration test for branch "${branch.branch.name}" failed. Find the leaf or set of leaves most likely to be the culprit. Failure:\n${failureMessage.slice(0, 1500)}`,
          maxIterations: localizationBudget,
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
        });
        if (loc.ok && loc.result.length > 0) {
          localizationHint = loc.result.map((r) => ({
            filePath: r.filePath,
            interface: r.interface,
          }));
        }
      } catch {
        // Throw → fall through to blame without the hint. The
        // legacy single-shot blame still has the full branch
        // context to work from.
      }
    }

    const blame = await runBlameAttribution(client, rpg, {
      branch: branch.branch,
      leaves: branch.leaves.map((l) => ({
        leafCapabilityId: l.capability.id,
        interface: l.interface,
        hostFilePath: l.hostFilePath,
        currentBody:
          input.bodyByLeafId.get(l.capability.id) ?? "(no body recorded)",
        decompositionDepth: l.capability.decompositionDepth,
      })),
      branchTestSource,
      failureMessage,
      temperature: input.temperature,
      ...(localizationHint ? { localizationHint } : {}),
    });
    if (!blame.ok || !blame.decision) {
      return {
        ok: false,
        testsByBranchId,
        finalRun: lastRun,
        recoveries,
        failingBranchIds: stillFailing,
        rounds,
        error: blame.error ?? "blame attribution failed",
      };
    }

    recoveries.push({
      round: rounds,
      branchId: targetBranchId,
      culpritLeafId: blame.decision.culpritLeafId,
      decision: blame.decision.decision,
      reason: blame.decision.reason,
    });

    const culpritLeaf = branch.leaves.find(
      (l) => l.capability.id === blame.decision!.culpritLeafId,
    );
    if (!culpritLeaf) {
      return {
        ok: false,
        testsByBranchId,
        finalRun: lastRun,
        recoveries,
        failingBranchIds: stillFailing,
        rounds,
        error: `architect named leaf ${blame.decision.culpritLeafId} but it is not in branch ${targetBranchId}`,
      };
    }

    // Apply the recovery — same vocabulary as Phase 7a.
    const applyResult = await applyRecoveryToLeaf(client, rpg, {
      culpritLeaf: {
        capability: culpritLeaf.capability,
        interface: culpritLeaf.interface,
        hostFilePath: culpritLeaf.hostFilePath,
      },
      decision: blame.decision,
      bodyByLeafId: input.bodyByLeafId,
      testsByLeafId: input.testsByLeafId,
      workDir: input.workDir,
      maxAttempts: input.maxAttemptsPerLeaf,
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(input.perLeafTimeoutMs !== undefined
        ? { testTimeoutMs: input.perLeafTimeoutMs }
        : {}),
    });
    if (!applyResult.ok) {
      // Audit gap #15: the previous behavior was to abort the
      // entire integration loop on the first apply failure,
      // throwing away the remaining 19 rounds of recovery budget.
      // A failed fresh_approach on culprit A should not prevent
      // round N+1 from picking culprit B with a different
      // decision.
      //
      // Record the failure on the recovery trail so callers can
      // see it, but continue to the next round — the next blame
      // call sees the still-failing branch with refreshed
      // context (failure messages from the partial-apply state)
      // and can pick a different culprit OR a different decision.
      recoveries[recoveries.length - 1] = {
        ...recoveries[recoveries.length - 1]!,
        applyError: applyResult.error,
      };
      // Branch status remains "failing" — drop into the next
      // round naturally.
      continue;
    }
  }

  const finalFailing = [...branchStatus.entries()]
    .filter(([, s]) => s === "failing")
    .map(([id]) => id);
  return {
    ok: false,
    testsByBranchId,
    ...(lastRun ? { finalRun: lastRun } : {}),
    recoveries,
    failingBranchIds: finalFailing,
    rounds,
    error: `exhausted ${maxRounds} integration rounds; ${finalFailing.length} branch(es) still failing`,
  };
}

// ── Test author ──────────────────────────────────────────────────────

async function authorBranchTest(
  client: LLMClient,
  rpg: RPG,
  branch: DiscoveredBranch,
  temperature: number | undefined,
): Promise<string> {
  const leaves = branch.leaves.map((l) => ({
    capability: l.capability,
    interface: l.interface,
    hostFilePath: l.hostFilePath,
    importSpecifier: integrationImportSpecifier(l.hostFilePath),
  }));
  const userPrompt = buildIntegrationTestAuthorUserPrompt({
    branch: branch.branch,
    leaves,
    dataFlowSummary: renderBranchDataFlow(rpg, branch.leaves),
  });
  const response = await client.chat(
    [
      { role: "system", content: INTEGRATION_TEST_AUTHOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature !== undefined ? { temperature } : undefined,
  );
  return stripCodeFences(response.content);
}

/** Compute the relative-import specifier the integration test should
 *  use to import a leaf from its host file. Mirrors the leaf-loop
 *  helper but anchors at the branch test directory. */
function integrationImportSpecifier(hostFilePath: string): string {
  let rel = path.posix.relative(TEST_FILE_DIR, hostFilePath);
  const ext = path.extname(rel);
  if (ext.length > 0) rel = rel.slice(0, -ext.length);
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
  return `${rel}.js`;
}

// ── Blame attribution ───────────────────────────────────────────────

interface BlameDecision {
  culpritLeafId: NodeId;
  decision: "fresh_approach" | "decompose";
  reason: string;
  approachHint?: string;
  subLeaves?: SubLeafSpec[];
}

interface BlameResult {
  ok: boolean;
  decision?: BlameDecision;
  error?: string;
}

interface BlameInput {
  branch: CapabilityNode;
  leaves: Array<{
    leafCapabilityId: NodeId;
    interface: PlannedInterface;
    hostFilePath: string;
    currentBody: string;
    decompositionDepth: number;
  }>;
  branchTestSource: string;
  failureMessage: string;
  temperature?: number;
  /** Optional localization hint passed verbatim to the prompt
   *  builder. Already-validated `{filePath, interface}` shape. */
  localizationHint?: Array<{ filePath: string; interface: string }>;
}

async function runBlameAttribution(
  client: LLMClient,
  rpg: RPG,
  input: BlameInput,
): Promise<BlameResult> {
  void rpg;
  const userPrompt = buildIntegrationBlameUserPrompt({
    branch: input.branch,
    branchTestSource: input.branchTestSource,
    failureMessage: input.failureMessage,
    leaves: input.leaves,
    ...(input.localizationHint
      ? { localizationHint: input.localizationHint }
      : {}),
  });
  const response = await client.chat(
    [
      { role: "system", content: INTEGRATION_BLAME_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    {
      responseFormat: { type: "json_object" },
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
    },
  );
  const knownLeafIds = new Set(input.leaves.map((l) => l.leafCapabilityId));
  return parseBlameResponse(response.content, knownLeafIds);
}

function parseBlameResponse(
  raw: string,
  knownLeafIds: Set<NodeId>,
): BlameResult {
  const text = stripFences(raw).trim();
  if (!text) return { ok: false, error: "empty blame response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON parse: ${(e as Error).message}` };
  }
  if (!isObject(parsed)) {
    return { ok: false, error: "blame response is not an object" };
  }
  const culpritLeafId = parsed["culpritLeafId"];
  const decision = parsed["decision"];
  const reason = parsed["reason"];
  if (typeof culpritLeafId !== "string" || !knownLeafIds.has(culpritLeafId)) {
    return {
      ok: false,
      error: `culpritLeafId must be one of: ${[...knownLeafIds].join(", ")}; got ${JSON.stringify(culpritLeafId)}`,
    };
  }
  if (decision !== "fresh_approach" && decision !== "decompose") {
    return {
      ok: false,
      error: `decision must be fresh_approach or decompose`,
    };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, error: "reason required" };
  }
  if (decision === "fresh_approach") {
    const hint = parsed["approachHint"];
    if (typeof hint !== "string" || hint.trim().length === 0) {
      return { ok: false, error: "fresh_approach requires approachHint" };
    }
    return {
      ok: true,
      decision: {
        culpritLeafId,
        decision,
        reason: reason.trim(),
        approachHint: hint.trim(),
      },
    };
  }
  // decompose — borrow Phase 7a's sub-leaf shape via a light parse.
  const subRaw = parsed["subLeaves"];
  if (!Array.isArray(subRaw) || subRaw.length < 2 || subRaw.length > 5) {
    return {
      ok: false,
      error: "decompose requires subLeaves array of length 2-5",
    };
  }
  const subLeaves: SubLeafSpec[] = [];
  for (let i = 0; i < subRaw.length; i++) {
    const v = parseSubLeafLight(subRaw[i], i);
    if (!v.ok) return { ok: false, error: v.error };
    subLeaves.push(v.value);
  }
  return {
    ok: true,
    decision: {
      culpritLeafId,
      decision: "decompose",
      reason: reason.trim(),
      subLeaves,
    },
  };
}

function parseSubLeafLight(
  raw: unknown,
  i: number,
): { ok: true; value: SubLeafSpec } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: `subLeaves[${i}]: not an object` };
  const name = raw["name"];
  if (typeof name !== "string" || !/^[a-z][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, error: `subLeaves[${i}].name camelCase` };
  }
  const description = raw["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, error: `subLeaves[${i}].description required` };
  }
  const kind = raw["kind"];
  if (kind !== "function" && kind !== "method") {
    return { ok: false, error: `subLeaves[${i}].kind` };
  }
  const ownerClassName = raw["ownerClassName"];
  if (kind === "method" && (typeof ownerClassName !== "string" || ownerClassName.length === 0)) {
    return {
      ok: false,
      error: `subLeaves[${i}].ownerClassName required for methods`,
    };
  }
  const exported = raw["exported"];
  const isStatic = raw["isStatic"];
  if (typeof exported !== "boolean" || typeof isStatic !== "boolean") {
    return {
      ok: false,
      error: `subLeaves[${i}].exported / isStatic required boolean`,
    };
  }
  const sig = raw["signature"];
  if (!isObject(sig)) {
    return { ok: false, error: `subLeaves[${i}].signature object` };
  }
  const paramsRaw = sig["params"];
  const returnType = sig["returnType"];
  const isAsync = sig["isAsync"];
  if (!Array.isArray(paramsRaw)) {
    return { ok: false, error: `subLeaves[${i}].signature.params array` };
  }
  if (typeof returnType !== "string" || returnType.length === 0) {
    return { ok: false, error: `subLeaves[${i}].signature.returnType` };
  }
  if (typeof isAsync !== "boolean") {
    return { ok: false, error: `subLeaves[${i}].signature.isAsync` };
  }
  const params: SubLeafSpec["signature"]["params"] = [];
  for (let j = 0; j < paramsRaw.length; j++) {
    const p = paramsRaw[j];
    if (!isObject(p)) return { ok: false, error: `subLeaves[${i}].params[${j}]` };
    const pname = p["name"];
    const ptype = p["type"];
    if (typeof pname !== "string" || typeof ptype !== "string") {
      return { ok: false, error: `subLeaves[${i}].params[${j}] name+type` };
    }
    params.push({ name: pname, type: ptype });
  }
  return {
    ok: true,
    value: {
      name,
      description: description.trim(),
      signature: { params, returnType, isAsync },
      kind,
      ownerClassName: kind === "method" ? (ownerClassName as string) : null,
      isStatic,
      exported,
    },
  };
}

// ── Recovery apply ───────────────────────────────────────────────────

interface ApplyRecoveryInput {
  culpritLeaf: {
    capability: CapabilityNode;
    interface: PlannedInterface;
    hostFilePath: string;
  };
  decision: BlameDecision;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
  workDir: string;
  maxAttempts?: number;
  testTimeoutMs?: number;
  temperature?: number;
}

async function applyRecoveryToLeaf(
  client: LLMClient,
  rpg: RPG,
  input: ApplyRecoveryInput,
): Promise<{ ok: boolean; error?: string }> {
  const leafId = input.culpritLeaf.capability.id;
  const hostFile = rpg.nodes[input.culpritLeaf.capability.mappedToId!];
  if (!hostFile || !isFile(hostFile)) {
    return { ok: false, error: `host file for leaf ${leafId} missing` };
  }

  if (input.decision.decision === "decompose") {
    // Apply the architect's pre-validated decision directly — no LLM
    // round-trip needed. The shared helper validates structure and
    // surfaces specific errors when the spec is malformed.
    const req: DecomposeRequest = {
      leaf: input.culpritLeaf.interface,
      hostFile,
      rpg,
      testSource: input.testsByLeafId.get(leafId) ?? "",
      lastBody: input.bodyByLeafId.get(leafId) ?? "",
      lastFailure: input.decision.reason,
      attemptsExhausted: 0,
      decompositionDepth: input.culpritLeaf.capability.decompositionDepth,
    };
    const r = applyPresetDecomposition(req, input.decision.subLeaves!);
    if (!r.ok) {
      return {
        ok: false,
        error: `architect's decompose spec failed validation: ${r.error}`,
      };
    }
    // Implement the new sub-leaves first, then re-implement the
    // assembly. We delete the assembly's prior body so it gets
    // re-authored to call the helpers.
    input.bodyByLeafId.delete(leafId);
    for (const newId of r.newCapabilityIds) {
      const newEntry = hostFile.interfacePlan!.entries.find(
        (e) => e.leafCapabilityId === newId,
      );
      if (!newEntry) continue;
      const sub = await implementLeaf(client, {
        leaf: newEntry,
        hostFile,
        rpg,
        bodyByLeafId: input.bodyByLeafId,
        testsByLeafId: input.testsByLeafId,
        workDir: input.workDir,
        maxAttempts: input.maxAttempts,
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        ...(input.testTimeoutMs !== undefined
          ? { testTimeoutMs: input.testTimeoutMs }
          : {}),
      });
      if (!sub.ok) {
        return {
          ok: false,
          error: `sub-leaf ${newEntry.name} failed unit tests: ${sub.fatal ?? sub.lastFailure?.failureMessage ?? "?"}`,
        };
      }
    }
    const assembly = await implementLeaf(client, {
      leaf: input.culpritLeaf.interface,
      hostFile,
      rpg,
      bodyByLeafId: input.bodyByLeafId,
      testsByLeafId: input.testsByLeafId,
      workDir: input.workDir,
      maxAttempts: input.maxAttempts,
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(input.testTimeoutMs !== undefined
        ? { testTimeoutMs: input.testTimeoutMs }
        : {}),
    });
    if (!assembly.ok) {
      return {
        ok: false,
        error: `assembly ${input.culpritLeaf.interface.name} failed: ${assembly.fatal ?? assembly.lastFailure?.failureMessage ?? "?"}`,
      };
    }
    return { ok: true };
  }

  // fresh_approach — re-author body with the architect's hint.
  input.bodyByLeafId.delete(leafId);
  const r = await implementLeaf(client, {
    leaf: input.culpritLeaf.interface,
    hostFile,
    rpg,
    bodyByLeafId: input.bodyByLeafId,
    testsByLeafId: input.testsByLeafId,
    workDir: input.workDir,
    maxAttempts: input.maxAttempts,
    approachHint: input.decision.approachHint!,
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.testTimeoutMs !== undefined
      ? { testTimeoutMs: input.testTimeoutMs }
      : {}),
  });
  if (!r.ok) {
    return {
      ok: false,
      error: `culprit ${input.culpritLeaf.interface.name} failed unit tests after fresh_approach: ${r.fatal ?? r.lastFailure?.failureMessage ?? "?"}`,
    };
  }
  return { ok: true };
}

// ── Local helpers (duplicated from decompose.ts to keep the module
// self-contained; small helpers, not worth a shared file yet) ───────

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
