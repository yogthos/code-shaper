/**
 * Phase 6 integration test — full pipeline against a real LLM.
 *
 * Pipes Phase 3 → 4 → 5 → refactor → 6 on a tiny target (a "math
 * utilities" library), asserts:
 *   - every leaf got a body and its tests passed;
 *   - the final cross-file vitest run is green;
 *   - the materialized files contain plausible TypeScript.
 *
 * Skipped when no API key is resolved.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import { emptyRPG, isFile } from "../src/rpg/index.js";
import {
  designInterfaces,
  encodeFileStructure,
  proposeFunctionalityGraph,
  runRefactorPass,
} from "../src/architect/index.js";
import {
  buildImplementations,
  discoverBranches,
  runIntegrationTests,
} from "../src/implementor/index.js";

const config = await loadConfig();
const providerName =
  config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
const cfg = providerName ? config.value.providers[providerName] : undefined;
const apiKeyResolved = !!cfg && !!cfg.apiKey && cfg.apiKey.length > 0;

describe("Phase 6 implementor — full pipeline (real LLM)", () => {
  if (!apiKeyResolved) {
    const missing =
      providerName !== undefined
        ? missingForPath(config, `providers.${providerName}`)
            .map((m) => m.name)
            .join(", ")
        : "?";
    it.skip(
      `skipped — no API key resolved (missing env: ${missing || "?"})`,
      () => {},
    );
    return;
  }

  it(
    "proposes, plans, implements, and runs branch-level integration tests",
    { timeout: 1_800_000 },
    async () => {
      const description = `Build a tiny TypeScript math-utilities library:
        - clamp(value, lo, hi) → number
        - lerp(a, b, t) → number  (linear interpolation, t in [0,1])
        - mean(xs: number[]) → number  (returns 0 for empty input)
        Three pure functions, no I/O, no async.`;

      const client = createClient(providerName!, cfg!);
      const rpg = emptyRPG();

      const proposal = await proposeFunctionalityGraph(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(proposal.ok, proposal.error ?? "").toBe(true);

      const structure = await encodeFileStructure(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(structure.ok, structure.error ?? "").toBe(true);

      const interfaces = await designInterfaces(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(interfaces.ok, interfaces.error ?? "").toBe(true);

      const refactor = await runRefactorPass(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(refactor.ok, refactor.error ?? "").toBe(true);

      const outDir = await mkdtemp(path.join(tmpdir(), "phase6-int-"));
      try {
        const build = await buildImplementations(client, rpg, {
          maxAttemptsPerLeaf: 3,
          outDir,
          // Keep the harness work dir alive so Phase 7b can run on
          // top of the same materialized state.
          preserveHarness: true,
        });
        expect(
          build.ok,
          `build failed; failed leaves: ${build.leafResults
            .filter((r) => !r.ok)
            .map(
              (r) =>
                `${r.leafId}: ${r.fatal ?? r.lastFailure?.failureMessage ?? "?"}`,
            )
            .join("; ")}`,
        ).toBe(true);
        expect(build.finalTestRun?.ok).toBe(true);

        // Inspect: there should be at least one materialized .ts file
        // with a non-trivial body.
        let foundBody = false;
        for (const node of Object.values(rpg.nodes)) {
          if (!isFile(node)) continue;
          if (node.path.endsWith(".test.ts")) continue;
          if (!node.interfacePlan) continue;
          if (node.content.length < 50) continue;
          if (
            !node.content.includes("not implemented") &&
            node.content.match(/return /)
          ) {
            foundBody = true;
            break;
          }
        }
        expect(foundBody, "no file with a real body").toBe(true);

        // Phase 7b: branch-level integration tests on top of the
        // already-passing leaves. Reconstruct the body/test maps
        // from the build's leafResults.
        const buildWorkDir = build.workDir!;
        try {
          const bodyByLeafId = new Map<string, string>();
          const testsByLeafId = new Map<string, string>();
          for (const lr of build.leafResults) {
            if (lr.ok) {
              bodyByLeafId.set(lr.leafId, lr.body);
              testsByLeafId.set(lr.leafId, lr.testSource);
            }
          }
          const branches = discoverBranches(rpg);
          // The math-utilities target has 3 standalone leaves; the
          // proposal stage typically groups them under one root
          // capability, producing a single branch with 3 leaves.
          // Some targets won't produce any branches (every leaf is
          // its own subtree); the assertion below tolerates both.
          if (branches.length > 0) {
            const integration = await runIntegrationTests(client, rpg, {
              bodyByLeafId,
              testsByLeafId,
              workDir: buildWorkDir,
              maxAttemptsPerLeaf: 2,
            });
            expect(
              integration.ok,
              `integration failed: ${integration.error ?? integration.failingBranchIds.join(",")}`,
            ).toBe(true);
            expect(integration.testsByBranchId.size).toBe(branches.length);
          }
        } finally {
          await rm(buildWorkDir, { recursive: true, force: true });
        }
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
  );
});
