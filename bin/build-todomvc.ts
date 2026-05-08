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
  runRefactorPass,
} from "../src/architect/index.js";
import {
  buildImplementations,
  discoverBranches,
  renderPlannedFiles,
  runIntegrationTests,
} from "../src/implementor/index.js";

const DESCRIPTION = `Build a TypeScript TodoMVC core library — the data + operation layer only, NO UI rendering or DOM code:

  - A Todo type: { id: string; text: string; completed: boolean }
  - A TodoStore class that maintains an in-memory list of todos.
  - Operations:
      addTodo(text: string): Todo
        — appends a new active todo with a fresh unique id; returns the new todo.
        — throws if text is empty or whitespace-only.

      toggleTodo(id: string): Todo
        — flips the completed flag; returns the updated todo.
        — throws if id is unknown.

      removeTodo(id: string): boolean
        — removes the todo by id; returns true if removed, false if id unknown.

      editTodo(id: string, text: string): Todo
        — replaces the text; returns the updated todo.
        — throws if id unknown OR text is empty.

      clearCompleted(): number
        — removes every completed todo; returns the number removed.

      getAll(): readonly Todo[]
      getActive(): readonly Todo[]
      getCompleted(): readonly Todo[]
        — return the current list as a frozen array; no mutation observable.

  - Pure logic, no I/O, no async. Each operation is independently testable.
  - Use crypto.randomUUID() for ids.
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

  // 2. Pipeline
  const rpg = emptyRPG();
  const outDir = path.resolve("demo");
  await rm(outDir, { recursive: true, force: true });

  /** Render plan-bearing files + materialize the RPG to outDir.
   *  Called after each architect phase so demo/ tracks the current
   *  state on disk. */
  const persist = async (): Promise<void> => {
    renderPlannedFiles(rpg);
    await materializeRPG(rpg, outDir);
  };

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
  const build = await buildImplementations(client, rpg, {
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
    useEditTools: true,
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
