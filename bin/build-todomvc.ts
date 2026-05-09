#!/usr/bin/env tsx
/**
 * End-to-end driver: TodoMVC core library.
 *
 * Runs Phase 3 → 4 → 5 → refactor → 6 → 7b against the configured
 * default provider, materializes to `./demo`. Prints a milestone log
 * per phase so the run is followable from the terminal.
 *
 * Scope is the data + operation layer only — no UI rendering, no DOM.
 * The harness today only outputs TypeScript modules with vitest tests;
 * a TodoMVC frontend is a follow-up once the renderer learns
 * frameworks.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import { emptyRPG, isCapability, isFile, materializeRPG } from "../src/rpg/index.js";
import {
  designInterfaces,
  encodeFileStructure,
  proposeFunctionalityGraph,
  proposeStack,
  runRefactorPass,
} from "../src/architect/index.js";
import {
  buildImplementations,
  discoverBranches,
  renderPlannedFiles,
  runIntegrationTests,
} from "../src/implementor/index.js";

const DESCRIPTION = `Build a working TodoMVC web application that I can open in a browser, type into, and use end-to-end. TypeScript end to end.

REQUIREMENTS — these MUST be present:

  Functionality (the canonical TodoMVC feature set):
    - Add a todo by typing in the input and pressing Enter
    - Mark a todo complete / incomplete via a checkbox
    - Edit a todo by double-clicking it (Enter to save, Escape to cancel)
    - Delete an individual todo via a hover-revealed × button
    - Toggle-all checkbox that marks every todo complete (or active if all are already complete)
    - Filter view: All / Active / Completed (URL-routed via hash, e.g. #/active)
    - "X items left" counter (only counts active todos)
    - "Clear completed" button (only visible when at least one todo is completed)
    - Empty input rejects (don't add blank todos)

  Persistence:
    - SQLite (better-sqlite3 or your preferred sqlite binding). Todos survive a page refresh AND a server restart.
    - Schema: at minimum (id TEXT PRIMARY KEY, text TEXT, completed INTEGER, created_at INTEGER). Add columns if your design needs them.

  Server:
    - HTTP server exposing whatever endpoints the frontend needs (REST or otherwise — your call).
    - Serves the frontend assets too. ONE process, ONE port. \`npm start\` launches it; the README tells me which URL to open.

  Tests:
    - Unit tests for the storage / business logic layer (the parts that don't need a DOM).
    - Integration tests for the HTTP API (a fetch-based test that hits real endpoints against a temp database).
    - All tests run via \`npm test\` and pass cleanly.

  Quality bar:
    - Clean module boundaries: storage, business logic, HTTP, frontend each isolated.
    - Errors are real Error subclasses, not strings — server returns sensible HTTP codes, frontend doesn't crash on a 4xx.
    - Frontend is responsive and matches the canonical TodoMVC visual style closely enough that a TodoMVC fan recognizes it.

DECISIONS LEFT TO YOU:
  - UI: vanilla DOM, Lit, Preact, React, Vue, Solid, vanilla + a templating lib — your call. Pick what gives the best result with the least dependency surface for a project this size.
  - HTTP framework: hono, express, fastify, raw node http, etc.
  - SQLite binding: better-sqlite3, node-sqlite3, drizzle, kysely — pick one.
  - Build / bundle: vite, esbuild, tsx + plain script tags, no-bundler — your call. Keep it minimal.
  - File / folder layout: lay it out the way you'd organize a real codebase. Don't flatten just because it's small; don't over-nest just because of habit.

DON'T:
  - Don't add features the requirements list doesn't ask for (no auth, no themes, no multi-user, no drag-and-drop reordering — keep it focused).
  - Don't depend on global state or singletons that the tests can't isolate.
  - Don't ship debug \`console.log\`s in production paths.

I want a project where \`git clone … && npm install && npm test && npm start\` produces a working app I can interact with.
`;

async function main(): Promise<number> {
  const startedAt = Date.now();
  const log = (msg: string): void => {
    const t = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[+${t}s] ${msg}`);
  };

  // 1. Provider
  const config = await loadConfig();
  const providerName =
    config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
  const cfg = providerName ? config.value.providers[providerName] : undefined;
  if (!providerName || !cfg || !cfg.apiKey) {
    const missing =
      providerName !== undefined
        ? missingForPath(config, `providers.${providerName}`)
            .map((m) => m.name)
            .join(", ") || "?"
        : "(no provider)";
    console.error(
      `[fatal] no API key resolved for default provider; missing env: ${missing}`,
    );
    return 2;
  }
  const client = createClient(providerName, cfg);
  log(`provider=${providerName} model=${cfg.model}`);

  // 2. Pipeline. demo/todomvc-harness/ is the harness side of the
  //    baseline-vs-harness comparison; demo/todomvc-baseline/
  //    holds the one-shot baseline output from bin/baseline-todomvc.ts.
  const rpg = emptyRPG();
  const outDir = path.resolve("demo/todomvc-harness");
  await rm(outDir, { recursive: true, force: true });

  /** Render plan-bearing files + materialize the RPG to outDir.
   *  Called after each architect phase so demo/ tracks the current
   *  state on disk. */
  const persist = async (): Promise<void> => {
    renderPlannedFiles(rpg);
    await materializeRPG(rpg, outDir);
  };

  // Phase 0 — stack & dependencies (TS-specific addition).
  log("phase 0 — stack");
  const stack = await proposeStack(client, {
    description: DESCRIPTION,
    outDir,
    maxAttempts: 2,
  });
  // The stack phase now retries with install-error feedback
  // until npm install actually succeeds (or attempts exhaust).
  // We refuse to proceed with a half-installed project: planning
  // around broken deps just pushes the failure into every leaf
  // that imports them.
  if (!stack.ok) {
    if (!stack.packageJson) {
      console.error(`[fatal] stack phase failed (invalid package.json): ${stack.error}`);
    } else {
      console.error(
        `[fatal] stack phase failed: npm install never succeeded after ${stack.attempts} attempt(s). ${stack.error ?? "(no detail)"}`,
      );
    }
    return 2;
  }
  log(
    `  ${Object.keys(stack.packageJson?.dependencies ?? {}).length} deps + ${
      Object.keys(stack.packageJson?.devDependencies ?? {}).length
    } devDeps; npm install ok (attempts: ${stack.attempts})`,
  );


  log("phase 3 — proposal");
  const proposal = await proposeFunctionalityGraph(client, rpg, {
    description: DESCRIPTION,
    maxAttempts: 2,
  });
  if (!proposal.ok) {
    console.error(`[fatal] proposal failed: ${proposal.error}`);
    return 3;
  }
  log(`  ${proposal.totalNodesAdded} capabilities planned`);
  await persist();

  log("phase 4 — file structure");
  const structure = await encodeFileStructure(client, rpg, {
    description: DESCRIPTION,
    maxAttempts: 2,
  });
  if (!structure.ok) {
    console.error(`[fatal] structure failed: ${structure.error}`);
    return 4;
  }
  log(`  ${structure.mappings.length} folder/file mappings`);
  await persist();

  log("phase 5 — interfaces");
  const interfaces = await designInterfaces(client, rpg, {
    description: DESCRIPTION,
    maxAttempts: 2,
    // Fan out per ancestor group when there's more than one. Keeps
    // each LLM prompt small enough that GLM doesn't stall on
    // large whole-project requests.
    parallelism: 4,
  });
  if (!interfaces.ok) {
    console.error(`[fatal] interfaces failed: ${interfaces.error}`);
    return 5;
  }
  log(
    `  ${interfaces.entries.length} interface entries; ${interfaces.classes.length} classes; ${interfaces.dataFlow.length} data-flow edges`,
  );
  await persist();

  log("refactor pass");
  const refactor = await runRefactorPass(client, rpg, {
    description: DESCRIPTION,
    maxAttempts: 2,
  });
  if (!refactor.ok) {
    console.error(`[fatal] refactor failed: ${refactor.error}`);
    return 6;
  }
  log(`  ${refactor.operations.length} restructuring operations`);
  await persist();

  // 3. Phase 6 — incremental materialize is built into the
  //    orchestrator now; demo/ updates after each leaf lands.
  log("phase 6 — implementor (per-leaf TDD)");
  const leafStartedAt = new Map<string, number>();
  const build = await buildImplementations(client, rpg, {
    onLeafProgress: (e) => {
      if (e.phase === "start") {
        leafStartedAt.set(e.leafCapabilityId, Date.now());
        log(`  [${e.index}/${e.total}] ${e.leafName} — start`);
      } else {
        const ms = Date.now() - (leafStartedAt.get(e.leafCapabilityId) ?? Date.now());
        const secs = (ms / 1000).toFixed(1);
        const mark = e.ok ? "✓" : "✗";
        const meta = `${e.attempts ?? "?"} attempts${
          e.testRewrites && e.testRewrites > 0 ? `, ${e.testRewrites} test rewrites` : ""
        }`;
        if (e.ok) {
          log(`  [${e.index}/${e.total}] ${e.leafName} ${mark} (${meta}, ${secs}s)`);
        } else {
          log(
            `  [${e.index}/${e.total}] ${e.leafName} ${mark} (${meta}, ${secs}s) — ${e.failureSummary ?? "failed"}`,
          );
        }
      }
    },
    // Matches §5.3 of the RPG paper: "each function allows up to 8
    // debugging iterations." Was 3.
    maxAttemptsPerLeaf: 8,
    outDir,
    preserveHarness: true,
    // 5-round MV diagnostic + auto test-rewrite (§5.3, Algorithm 4).
    // Each leaf failure is classified; brittle tests are auto-fixed
    // without consuming body-debug budget.
    // afterFailures: 1 — skip the diagnostic on the very first
    // body-author miss. Most first failures are real implementation
    // bugs the body author can fix on its own retry; running the
    // 5-round MV judge on every miss roughly doubles diagnostic
    // calls for limited additional value.
    diagnosis: { enabled: true, rounds: 5, afterFailures: 1 },
    maxTestRewrites: 20,
    // §D.2 tool-using edit author replaces the streaming body
    // author. The LLM picks a scope (edit_function_in_file or
    // edit_method_of_class_in_file) and emits structured args; the
    // harness applies the tool with AST-aware splicing.
    // Dev-loop author: full multi-turn agent (read/edit/probe +
    // §D.2 surgical edits + Terminate). Subsumes useEditTools.
    // The model can now `list_files` / `read_file` to discover
    // siblings before referencing them — fixes the cross-file
    // failure mode (e.g. `TodoValidationError is not defined`)
    // that wedged previous runs.
    useDevLoop: true,
    devLoopMaxIterations: 15,
    // Parallel worker pool. 3 keeps GLM rate limits comfortable
    // while still cutting wall-clock time roughly in half on
    // file-independent leaves. Bump on local models or higher
    // rate-limit tiers.
    maxConcurrentLeaves: 3,
    // Q4-D: per-leaf wall-clock cap. Cap a single leaf at 8 min
    // — well past a normal 60-90s leaf, but bounded so a
    // pathological one (stuck dev loop, network stall) can't
    // hold a worker for 19 min like in the prior run.
    maxLeafWallMs: 8 * 60 * 1000,
    // Stage C: when the diagnostic says environment, the model can
    // call add_dependency / remove_dependency / set_script /
    // npm_run via a structured tool call. The harness applies the
    // change to outDir/package.json + node_modules.
    enableEnvFix: true,
  });
  const failedLeaves = build.leafResults.filter((r) => !r.ok);
  log(
    `  ${build.leafResults.filter((r) => r.ok).length} leaves green / ${build.leafResults.length} attempts; ${build.decomposeDecisions.length} decompose decisions`,
  );
  if (!build.ok) {
    console.error(
      `[fatal] build failed; ${failedLeaves.length} leaves still red:\n${failedLeaves
        .map(
          (r) =>
            `  ${r.leafId}: ${r.fatal ?? r.lastFailure?.failureMessage ?? "?"}`,
        )
        .join("\n")}`,
    );
    if (build.workDir) {
      await rm(build.workDir, { recursive: true, force: true });
    }
    return 7;
  }

  // 4. Phase 7b — branch integration
  if (build.workDir) {
    const branches = discoverBranches(rpg);
    log(`phase 7b — integration (${branches.length} branches)`);
    if (branches.length > 0) {
      const bodyByLeafId = new Map<string, string>();
      const testsByLeafId = new Map<string, string>();
      for (const lr of build.leafResults) {
        if (lr.ok) {
          bodyByLeafId.set(lr.leafId, lr.body);
          testsByLeafId.set(lr.leafId, lr.testSource);
        }
      }
      const integration = await runIntegrationTests(client, rpg, {
        bodyByLeafId,
        testsByLeafId,
        workDir: build.workDir,
        // Matches §5.3 of the RPG paper: "each function allows up to 8
        // debugging iterations." Was 3.
        maxAttemptsPerLeaf: 8,
        // §D.1 graph-guided localization runs before each blame
        // attribution; the ranked hits seed the blame prompt as
        // extra context. Default budget = 20 (§5.3).
        useLocalization: true,
      });
      log(
        `  rounds=${integration.rounds}; recoveries=${integration.recoveries.length}; ok=${integration.ok}`,
      );
      if (!integration.ok) {
        console.error(
          `[fatal] integration failed: ${integration.error ?? integration.failingBranchIds.join(", ")}`,
        );
        await rm(build.workDir, { recursive: true, force: true });
        return 8;
      }
    }
    await rm(build.workDir, { recursive: true, force: true });
  }

  // 5. Summary
  let fileCount = 0;
  let leafCount = 0;
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node) && node.interfacePlan) fileCount++;
    if (isCapability(node) && node.isLeaf) leafCount++;
  }
  log(`done. ${fileCount} files, ${leafCount} leaves materialized to ${outDir}`);
  return 0;
}

/**
 * Top-level catch: any thrown error (most commonly an LLM AbortError
 * after MAX_RETRIES, or a JSON-parse failure on a malformed response)
 * lands here. We surface it with a clear header, persist whatever
 * partial RPG we have so demo/ reflects the last good state, and
 * exit non-zero — but never let a bare stack trace look like the
 * pipeline crashed catastrophically when it didn't.
 */
try {
  const code = await main();
  process.exit(code);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n[fatal] uncaught: ${msg}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(1, 6).join("\n"));
  }
  process.exit(99);
}
