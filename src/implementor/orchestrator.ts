/**
 * Phase 6 orchestrator — leaf-up topological TDD build.
 *
 * Walks every file with an `interfacePlan`, collects the leaf
 * capability ids in dependency order (data-flow producers before
 * consumers; class methods grouped together), runs the per-leaf TDD
 * loop, materializes the final RPG.
 *
 * Phase 6 is intentionally linear — when a leaf can't be implemented
 * after `maxAttempts`, the orchestrator marks it failed and moves
 * on. Phase 7 introduces the recursive split-or-implement decision
 * that asks the architect to decompose a stuck leaf instead of
 * giving up.
 */

import { rm } from "node:fs/promises";

import type { LLMClient } from "../llm/types.js";
import { materializeRPG } from "../rpg/materialize.js";
import {
  isCapability,
  isFile,
  type FileNode,
  type NodeId,
  type PlannedInterface,
  type RPG,
} from "../rpg/types.js";
import {
  decomposeStuckLeaf,
  MAX_DECOMPOSE_DEPTH,
  type DecomposeDecision,
} from "./decompose.js";
import { implementLeaf, type LeafImplementResult } from "./leaf.js";
import {
  createHarnessDir,
  linkHostNodeModules,
  resolveNodeModulesSource,
  runTests,
  type TestRunResult,
} from "./test-harness.js";
import { renderTypeScriptFile } from "./render.js";

export interface BuildInput {
  /** Number of body-author retries per leaf. Defaults to 3. */
  maxAttemptsPerLeaf?: number;
  /** Optional LLM temperature override for both author calls. */
  temperature?: number;
  /** When set, the orchestrator writes the rendered repo to this
   *  directory **incrementally** — once before the leaf-loop starts
   *  (so empty files appear with the planned structure), then after
   *  every successful leaf so the on-disk source tracks live progress.
   *  A final materialize at the end captures the cross-file rendered
   *  state. */
  outDir?: string;
  /** When true, leaves the harness work directory in place after the
   *  run for debugging. Defaults to false. */
  preserveHarness?: boolean;
  /** Host whose node_modules the harness symlinks for vitest +
   *  the model's deps. Default resolution (`resolveNodeModulesSource`):
   *  prefer outDir/node_modules when it has vitest installed
   *  (post phase-0 happy path — env-fix changes propagate); fall
   *  back to `process.cwd()` otherwise (dev / unit-test path).
   *  Pass an explicit value here only when neither default fits. */
  hostRepo?: string;
  /** Wall-clock timeout for the FINAL cross-file test run (after every
   *  leaf has attempted). Larger than the per-leaf timeout because the
   *  final pass runs every test in the harness. Defaults to 300s. */
  finalRunTimeoutMs?: number;
  /** Wall-clock timeout for each per-leaf test run. The harness'
   *  default is 120s — generous for small suites. Override here when
   *  you have leaves whose tests are expected to take longer. */
  perLeafTimeoutMs?: number;
  /** Failure-diagnosis settings forwarded to every implementLeaf
   *  call. See `LeafImplementInput.diagnosis`. The orchestrator
   *  doesn't transform these — they pass through verbatim. */
  diagnosis?: {
    enabled?: boolean;
    rounds?: number;
    afterFailures?: number;
  };
  /** Per-leaf budget for test-rewrite remediations triggered by the
   *  `test_brittleness` diagnostic. Forwarded to implementLeaf. */
  maxTestRewrites?: number;
  /** Switch the per-leaf body author to the §D.2 tool-using edit
   *  author. Forwarded to implementLeaf. Default false; production
   *  drivers (build-todomvc.ts, run-task.ts) opt in. */
  useEditTools?: boolean;
  /** Enable env-fix on `environment` diagnostic verdicts. Forwarded
   *  to implementLeaf as `enableEnvFix`. Requires `outDir` (which
   *  the orchestrator passes through as `projectDir` to leaf). */
  enableEnvFix?: boolean;
  /** Per-leaf env-fix budget. Forwarded to implementLeaf. */
  maxEnvPatches?: number;
}

export interface BuildResult {
  ok: boolean;
  /** Per-leaf attempts in chronological order. A leaf that went
   *  through decompose+retry appears MULTIPLE times — once per
   *  attempt round. To check final status per leaf, group by
   *  `leafId` and take the last entry. The `ok` field at the top
   *  level already reflects this aggregation. */
  leafResults: LeafImplementResult[];
  /** Decompose decisions taken during the build, in the order they
   *  were applied. Useful for inspecting the recovery trail when a
   *  build hits the depth limit. */
  decomposeDecisions: Array<{ originLeafId: string; decision: DecomposeDecision }>;
  /** Final cross-file vitest run, executed after every leaf has
   *  attempted. Useful as a high-level smoke check. */
  finalTestRun?: TestRunResult;
  /** Working directory the harness wrote to. Empty when none was
   *  needed (no leaves). */
  workDir?: string;
}

export async function buildImplementations(
  client: LLMClient,
  rpg: RPG,
  input: BuildInput = {},
): Promise<BuildResult> {
  const leaves = collectOrderedLeaves(rpg);
  if (leaves.length === 0) {
    return { ok: true, leafResults: [], decomposeDecisions: [] };
  }

  const workDir = await createHarnessDir();
  await linkHostNodeModules(
    workDir,
    resolveNodeModulesSource(input.outDir, input.hostRepo),
  );

  const bodyByLeafId = new Map<string, string>();
  const testsByLeafId = new Map<string, string>();
  // Snapshot of the original test source for each leaf, populated
  // by `implementLeaf` the first time the diagnostic rewrites a
  // brittle test. Used by the recovery paths below to restore the
  // original contract before re-implementing — without this, a
  // rewrite would silently weaken the contract for every subsequent
  // retry of the same leaf, hiding regressions on body changes.
  const originalTestsByLeafId = new Map<string, string>();
  const leafResults: LeafImplementResult[] = [];
  const decomposeDecisions: BuildResult["decomposeDecisions"] = [];

  try {
    // Pre-leaf materialize: write the planned folder/file skeleton
    // to disk before any leaf has implemented. New files get rendered
    // with throwing stubs, so the user can `tree demo/` and see the
    // shape immediately. Subsequent per-leaf materializes overwrite
    // bodies as they land.
    if (input.outDir) {
      renderPlannedFiles(rpg, bodyByLeafId);
      await materializeRPG(rpg, input.outDir);
    }

    // Work queue. Decompose-recovery prepends sub-leaves AND re-queues
    // the original leaf so it implements after its children. Each
    // entry tracks an `attemptCount` so we don't re-run a leaf
    // forever.
    interface QueueEntry {
      leaf: PlannedInterface;
      hostFile: FileNode;
      /** Set when the entry was re-queued after a `fresh_approach`
       *  recovery so the next implementLeaf call surfaces the hint. */
      approachHint?: string;
    }
    const queue: QueueEntry[] = leaves.map(({ leaf, hostFile }) => ({
      leaf,
      hostFile,
    }));
    /** Per-leaf cap on decomposition rounds, on top of the per-leaf
     *  TDD attempts. Avoids infinite back-and-forth where the
     *  architect keeps proposing fresh approaches that don't help. */
    const decomposeRoundsByLeaf = new Map<string, number>();

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const { leaf, hostFile, approachHint } = entry;

      const result = await implementLeaf(client, {
        leaf,
        hostFile,
        rpg,
        bodyByLeafId,
        testsByLeafId,
        originalTestsByLeafId,
        workDir,
        maxAttempts: input.maxAttemptsPerLeaf,
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        ...(input.perLeafTimeoutMs !== undefined
          ? { testTimeoutMs: input.perLeafTimeoutMs }
          : {}),
        ...(approachHint !== undefined ? { approachHint } : {}),
        ...(input.diagnosis !== undefined
          ? { diagnosis: input.diagnosis }
          : {}),
        ...(input.maxTestRewrites !== undefined
          ? { maxTestRewrites: input.maxTestRewrites }
          : {}),
        ...(input.useEditTools !== undefined
          ? { useEditTools: input.useEditTools }
          : {}),
        ...(input.enableEnvFix && input.outDir
          ? {
              enableEnvFix: true,
              projectDir: input.outDir,
              ...(input.maxEnvPatches !== undefined
                ? { maxEnvPatches: input.maxEnvPatches }
                : {}),
            }
          : {}),
      });
      leafResults.push(result);

      // After every leaf attempt — successful or not — re-render the
      // affected file and persist to disk if the caller is watching
      // an outDir. The user can tail the tree as code lands.
      //
      // Why we don't free `hostFile.content` after the write:
      //   `materializeRPG` writes `node.content` for EVERY file in
      //   the graph, not just the one we just touched. If we cleared
      //   the just-rendered file's content, the next leaf's
      //   materialize (running in a different file) would see this
      //   one as empty and clobber it on disk. Keeping the rendered
      //   string cached scales fine — it's at most one rendered file
      //   per node, and rendered TS for a typical leaf-heavy file
      //   stays in the kilobytes.
      if (input.outDir) {
        hostFile.content = renderTypeScriptFile({
          file: hostFile,
          bodyByLeafId,
          rpg,
        });
        await materializeRPG(rpg, input.outDir);
      }

      if (result.ok) continue;

      // Failed leaf — try to recover via decomposition or fresh
      // approach. Hard-fail when the recovery itself fails.
      const recovery = await runDecomposeRecovery({
        client,
        leaf,
        hostFile,
        rpg,
        result,
        bodyByLeafId,
        testsByLeafId,
        decomposeRoundsByLeaf,
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
      });
      if (!recovery.ok || !recovery.decision) {
        // Architect couldn't produce a decision — leave the build
        // marked failed; the surrounding pipeline reports it.
        continue;
      }
      decomposeDecisions.push({
        originLeafId: leaf.leafCapabilityId,
        decision: recovery.decision,
      });
      if (recovery.decision.kind === "depth_exhausted") {
        continue;
      }
      if (recovery.decision.kind === "fresh_approach") {
        // Discard ONLY the prior body. The test source IS the
        // contract — fresh_approach is about the implementation
        // strategy, not the contract; re-authoring the test would
        // throw away assertions the architect didn't ask to change.
        bodyByLeafId.delete(leaf.leafCapabilityId);
        // Restore the ORIGINAL test if a brittleness rewrite
        // weakened it earlier. Otherwise the fresh-approach body
        // would be measured against a contract that was tailored
        // to the previous (failed) body, hiding bugs.
        restoreOriginalTest(
          leaf.leafCapabilityId,
          testsByLeafId,
          originalTestsByLeafId,
        );
        queue.unshift({
          leaf,
          hostFile,
          approachHint: recovery.decision.approachHint,
        });
        continue;
      }
      // decompose: enqueue the new sub-leaves first (so they
      // implement before the assembly), then re-queue the original.
      const subLeaves: QueueEntry[] = [];
      for (const id of recovery.decision.newCapabilityIds) {
        const newLeafEntry = hostFile.interfacePlan?.entries.find(
          (e) => e.leafCapabilityId === id,
        );
        if (newLeafEntry) {
          subLeaves.push({ leaf: newLeafEntry, hostFile });
        }
      }
      // Drop the original leaf's prior body — it will be rewritten as
      // an assembly that calls the new helpers. Tests stay in place;
      // the assembly satisfies the same contract by composition.
      // Same as fresh_approach: restore the original test if it was
      // rewritten under brittleness, since the assembly will be
      // measured against the original contract.
      bodyByLeafId.delete(leaf.leafCapabilityId);
      restoreOriginalTest(
        leaf.leafCapabilityId,
        testsByLeafId,
        originalTestsByLeafId,
      );
      queue.unshift({ leaf, hostFile });
      queue.unshift(...subLeaves);
    }

    // Final pass: render each file's content into the in-memory RPG so
    // `materializeRPG` writes the same source the harness saw. Dedup
    // by file id — `leaves` is one entry per leaf, so a file with N
    // leaves would otherwise re-render N times.
    const seenFiles = new Set<NodeId>();
    for (const { hostFile } of leaves) {
      if (seenFiles.has(hostFile.id)) continue;
      seenFiles.add(hostFile.id);
      hostFile.content = renderTypeScriptFile({
        file: hostFile,
        bodyByLeafId,
        rpg,
      });
    }

    const finalTestRun = await runTests(rpg, {
      bodyByLeafId,
      testsByLeafId,
      workDir,
      timeoutMs: input.finalRunTimeoutMs ?? 300_000,
    });

    if (input.outDir) {
      await materializeRPG(rpg, input.outDir);
    }

    const ok =
      // Every leaf must have produced a passing implementation. A
      // leaf may appear in `leafResults` multiple times (once per
      // attempt round); we look at the LAST result for each.
      lastResultByLeafIsOk(leafResults) && finalTestRun.ok;
    return {
      ok,
      leafResults,
      decomposeDecisions,
      finalTestRun,
      workDir,
    };
  } finally {
    if (!input.preserveHarness) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

interface OrderedLeaf {
  leaf: PlannedInterface;
  hostFile: FileNode;
}

/**
 * If the leaf's test was rewritten under brittleness diagnosis, put
 * the original back. The recovery paths (fresh_approach, decompose)
 * change the body strategy, so they need to measure new bodies
 * against the original contract — not against a contract tailored
 * to the body that just failed.
 *
 * No-op when the snapshot map is empty for this leaf (the common
 * case — most leaves never trigger a rewrite).
 */
function restoreOriginalTest(
  leafId: string,
  testsByLeafId: Map<string, string>,
  originalTestsByLeafId: Map<string, string>,
): void {
  const original = originalTestsByLeafId.get(leafId);
  if (original !== undefined) {
    testsByLeafId.set(leafId, original);
  }
}

/** Pre-render every plan-bearing file's `content` from the architect's
 *  interfacePlan + whatever bodies exist in `bodyByLeafId` so that a
 *  subsequent `materializeRPG` call writes a coherent skeleton (with
 *  throwing stubs for unimplemented leaves) rather than the
 *  empty-string placeholders Phase 2 left behind.
 *
 *  Exported so build-script drivers can materialize incrementally
 *  between architect phases — call this, then `materializeRPG`. */
export function renderPlannedFiles(
  rpg: RPG,
  bodyByLeafId: Map<string, string> = new Map(),
): void {
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    if (!node.interfacePlan) continue;
    node.content = renderTypeScriptFile({
      file: node,
      bodyByLeafId,
      rpg,
    });
  }
}

/** Decompose-recovery: when implementLeaf returns failure, pull the
 *  failure context out of the latest result and ask the architect for
 *  a recovery plan. Returns the apply-side outcome plus any new
 *  capability ids the orchestrator should enqueue. */
async function runDecomposeRecovery(args: {
  client: LLMClient;
  leaf: PlannedInterface;
  hostFile: FileNode;
  rpg: RPG;
  result: LeafImplementResult;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
  decomposeRoundsByLeaf: Map<string, number>;
  temperature?: number;
}): Promise<{ ok: boolean; decision?: DecomposeDecision; error?: string }> {
  const cap = args.rpg.nodes[args.leaf.leafCapabilityId];
  const depth =
    cap && isCapability(cap) ? cap.decompositionDepth : 0;
  if (depth >= MAX_DECOMPOSE_DEPTH) {
    return {
      ok: true,
      decision: {
        kind: "depth_exhausted",
        reason: `decomposition depth budget (${MAX_DECOMPOSE_DEPTH}) exhausted`,
      },
    };
  }
  // Cap how many times we ask the architect for ANY decomposition on
  // a single leaf — even when each round is FRESH_APPROACH. Avoids
  // spinning when the architect's hints aren't unsticking the body
  // author either.
  const rounds = args.decomposeRoundsByLeaf.get(args.leaf.leafCapabilityId) ?? 0;
  if (rounds >= MAX_DECOMPOSE_DEPTH) {
    return {
      ok: true,
      decision: {
        kind: "depth_exhausted",
        reason: `architect-recovery rounds (${MAX_DECOMPOSE_DEPTH}) exhausted on this leaf`,
      },
    };
  }
  args.decomposeRoundsByLeaf.set(args.leaf.leafCapabilityId, rounds + 1);

  const testSource =
    args.testsByLeafId.get(args.leaf.leafCapabilityId) ?? args.result.testSource;
  const lastBody =
    args.bodyByLeafId.get(args.leaf.leafCapabilityId) ?? args.result.body;
  const lastFailure =
    args.result.lastFailure?.failureMessage ??
    args.result.fatal ??
    "(no failure message)";

  const decomp = await decomposeStuckLeaf(args.client, {
    leaf: args.leaf,
    hostFile: args.hostFile,
    rpg: args.rpg,
    testSource,
    lastBody,
    lastFailure,
    attemptsExhausted: args.result.attempts,
    decompositionDepth: depth,
    ...(args.temperature !== undefined
      ? { temperature: args.temperature }
      : {}),
  });
  if (!decomp.ok || !decomp.decision) {
    return { ok: false, error: decomp.error ?? "no decision" };
  }
  return { ok: true, decision: decomp.decision };
}

/** Group leafResults by leafId, return true iff every leaf's LAST
 *  attempt was ok=true. */
function lastResultByLeafIsOk(results: LeafImplementResult[]): boolean {
  const last = new Map<string, LeafImplementResult>();
  for (const r of results) last.set(r.leafId, r);
  for (const r of last.values()) if (!r.ok) return false;
  return true;
}

/**
 * Collect every leaf in build order:
 *
 *   - Group by host file (so methods of the same class build together).
 *   - Order files by inheritance + data-flow: a class with
 *     `extendsFromFile` waits for its base file; a leaf consuming
 *     another leaf's output waits for the producer's file.
 *   - Within a file, retain plan order.
 *
 * This is a topological sort over a small graph; cycles produce a
 * deterministic-but-arbitrary order rather than a hard error
 * (cyclic dataflow can be valid in user code, e.g. mutual recursion
 * across files), and the orchestrator's TDD loop tolerates it.
 */
function collectOrderedLeaves(rpg: RPG): OrderedLeaf[] {
  const filesWithPlan: FileNode[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node) && node.interfacePlan) filesWithPlan.push(node);
  }
  if (filesWithPlan.length === 0) return [];

  // Edges: file → file the file's plan depends on.
  const dependsOn = new Map<NodeId, Set<NodeId>>();
  for (const file of filesWithPlan) {
    dependsOn.set(file.id, new Set());
  }
  for (const file of filesWithPlan) {
    const set = dependsOn.get(file.id)!;
    // Cross-file extends.
    for (const cls of file.interfacePlan!.classes) {
      if (cls.extendsFromFile) {
        const baseId = `file:${cls.extendsFromFile}`;
        if (dependsOn.has(baseId) && baseId !== file.id) set.add(baseId);
      }
    }
    // Data-flow: a leaf consuming another leaf adds a file→file edge.
    for (const entry of file.interfacePlan!.entries) {
      const incoming = rpg.dataFlow.filter(
        (e) => e.toNode === entry.leafCapabilityId,
      );
      for (const edge of incoming) {
        const producer = rpg.nodes[edge.fromNode];
        if (!producer || !isCapability(producer)) continue;
        const producerFile = producer.mappedToId;
        if (
          producerFile &&
          dependsOn.has(producerFile) &&
          producerFile !== file.id
        ) {
          set.add(producerFile);
        }
      }
    }
  }

  // Kahn's algorithm. Files with no remaining deps go first; ties broken
  // by stable path order so output is deterministic.
  const remaining = new Map(dependsOn);
  const ordered: FileNode[] = [];
  const fileById = new Map(filesWithPlan.map((f) => [f.id, f]));

  while (remaining.size > 0) {
    const ready: FileNode[] = [];
    for (const [id, deps] of remaining) {
      if (deps.size === 0) {
        const file = fileById.get(id);
        if (file) ready.push(file);
      }
    }
    if (ready.length === 0) {
      // Cycle: pick the lexicographically first remaining file and
      // proceed. Real-world cycles are usually mutual recursion,
      // which Phase 6 tolerates; the implementor will produce stubs
      // that resolve at runtime regardless of build order.
      const fallback = [...remaining.keys()].sort()[0];
      if (!fallback) break;
      const file = fileById.get(fallback);
      if (!file) {
        remaining.delete(fallback);
        continue;
      }
      ready.push(file);
    }
    ready.sort((a, b) => a.path.localeCompare(b.path));
    for (const file of ready) {
      ordered.push(file);
      remaining.delete(file.id);
      for (const deps of remaining.values()) deps.delete(file.id);
    }
  }

  // Now flatten leaves in plan order per file.
  const out: OrderedLeaf[] = [];
  for (const file of ordered) {
    const plan = file.interfacePlan!;
    for (const entry of plan.entries) {
      out.push({ leaf: entry, hostFile: file });
    }
  }
  return out;
}
