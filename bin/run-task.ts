#!/usr/bin/env tsx
/**
 * Child-process entry point.
 *
 * Forked by the server's runner module. Receives args:
 *   --project-dir <abs path>
 *   --task <free-text task description>
 *   --mode <auto|greenfield|extend|fix|feature>
 *   --result-path <abs path to write final result JSON>
 *
 * Runs the full pipeline (proposal → structure → interfaces →
 * refactor → implementation → integration) against the configured
 * default LLM provider. Streams milestones to stdout (the parent
 * captures these line-by-line into the task's log file). On exit,
 * writes a TaskResult JSON to `--result-path` regardless of
 * success/failure so the parent's `task_result` call has something
 * to read.
 *
 * Process exit codes:
 *   0  — pipeline completed; task succeeded
 *   1  — pipeline completed; task failed (e.g., a leaf stayed red)
 *   2  — invalid args or no provider configured
 *   3  — uncaught error mid-pipeline (top-level catch fires)
 */

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import {
  emptyRPG,
  isCapability,
  isFile,
  loadRepo,
  materializeRPG,
} from "../src/rpg/index.js";
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
import type { TaskMode, TaskResult } from "../src/server/types.js";

interface ParsedArgs {
  projectDir: string;
  task: string;
  mode: TaskMode;
  resultPath: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: Partial<ParsedArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--project-dir") {
      out.projectDir = value;
      i++;
    } else if (flag === "--task") {
      out.task = value;
      i++;
    } else if (flag === "--mode") {
      out.mode = value as TaskMode;
      i++;
    } else if (flag === "--result-path") {
      out.resultPath = value;
      i++;
    }
  }
  if (!out.projectDir || !out.task || !out.mode || !out.resultPath) {
    throw new Error(
      `missing required args; got ${JSON.stringify(out)}. Required: --project-dir --task --mode --result-path`,
    );
  }
  return out as ParsedArgs;
}

async function isEmpty(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const fs = await import("node:fs/promises");
    const items = await fs.readdir(dir);
    return items.filter((n) => !n.startsWith(".")).length === 0;
  } catch {
    return true; // doesn't exist yet → effectively empty
  }
}

function startedAt(): { log: (msg: string) => void } {
  const t0 = Date.now();
  return {
    log(msg: string): void {
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      // The parent's runner captures stdout line-by-line. The format
      // here mirrors `bin/build-todomvc.ts` for log-tail consumers.
      process.stdout.write(`[+${t}s] ${msg}\n`);
    },
  };
}

async function writeResult(
  resultPath: string,
  result: TaskResult,
): Promise<void> {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2), "utf-8");
}

async function run(args: ParsedArgs): Promise<number> {
  const { log } = startedAt();
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
    await writeResult(args.resultPath, {
      ok: false,
      summary: "no LLM provider configured",
      materializedTo: args.projectDir,
      leafResults: [],
      integrationOk: null,
      error: `no API key resolved for default provider; missing env: ${missing}`,
    });
    return 2;
  }
  const client = createClient(providerName, cfg);
  log(`provider=${providerName} model=${cfg.model}`);

  // Resolve mode = "auto"
  let mode: TaskMode = args.mode;
  if (mode === "auto") {
    const empty = await isEmpty(args.projectDir);
    mode = empty ? "greenfield" : "extend";
    log(`mode=auto resolved to ${mode}`);
  } else {
    log(`mode=${mode}`);
  }

  // Greenfield: clear the dir if it exists. Extend/fix/feature: leave it.
  const outDir = path.resolve(args.projectDir);
  if (mode === "greenfield") {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
  }

  // For non-greenfield modes, ANALYZE the existing folder before
  // telling the model anything. loadRepo walks every supported
  // source file with tree-sitter, populating an RPG with files,
  // classes, functions, methods, imports, exports, and inheritance
  // edges. The model then sees the existing code structure in
  // every architect prompt, so its proposals integrate with what's
  // there rather than reinvent it.
  let rpg = emptyRPG();
  if (mode !== "greenfield") {
    log("phase=analyze");
    rpg = await loadRepo(outDir);
    let fileCount = 0;
    let symbolCount = 0;
    for (const node of Object.values(rpg.nodes)) {
      if (isFile(node)) fileCount++;
      if (
        node.kind === "function" ||
        node.kind === "class" ||
        node.kind === "method"
      ) {
        symbolCount++;
      }
    }
    log(`  ${fileCount} files, ${symbolCount} symbols loaded`);
  }

  const persist = async (): Promise<void> => {
    renderPlannedFiles(rpg);
    await materializeRPG(rpg, outDir);
  };

  // Phase 0: stack & dependencies (TS-specific). Runs BEFORE
  // proposal so subsequent phases can rely on declared deps.
  log("phase=stack");
  const stack = await proposeStack(client, {
    description: args.task,
    outDir,
    mode: mode === "greenfield" ? "greenfield" : "extend",
    maxAttempts: 2,
  });
  if (!stack.ok) {
    await writeResult(args.resultPath, {
      ok: false,
      summary: "stack phase failed",
      materializedTo: outDir,
      leafResults: [],
      integrationOk: null,
      error: stack.error ?? "unknown",
    });
    return 1;
  }
  log(
    `  ${Object.keys(stack.packageJson?.dependencies ?? {}).length} deps + ${
      Object.keys(stack.packageJson?.devDependencies ?? {}).length
    } devDeps; npm install ${stack.installOk ? "ok" : "skipped/failed"}`,
  );

  // Phase 1: proposal
  log("phase=proposal");
  const proposal = await proposeFunctionalityGraph(client, rpg, {
    description: args.task,
    maxAttempts: 2,
  });
  if (!proposal.ok) {
    await writeResult(args.resultPath, {
      ok: false,
      summary: "proposal phase failed",
      materializedTo: outDir,
      leafResults: [],
      integrationOk: null,
      error: proposal.error ?? "unknown",
    });
    return 1;
  }
  log(`  ${proposal.totalNodesAdded} capabilities planned`);
  await persist();

  // Phase 2: structure
  log("phase=structure");
  const structure = await encodeFileStructure(client, rpg, {
    description: args.task,
    maxAttempts: 2,
  });
  if (!structure.ok) {
    await writeResult(args.resultPath, {
      ok: false,
      summary: "structure phase failed",
      materializedTo: outDir,
      leafResults: [],
      integrationOk: null,
      error: structure.error ?? "unknown",
    });
    return 1;
  }
  log(`  ${structure.mappings.length} folder/file mappings`);
  await persist();

  // Phase 3: interfaces
  log("phase=interfaces");
  const interfaces = await designInterfaces(client, rpg, {
    description: args.task,
    maxAttempts: 2,
    mode: mode === "greenfield" ? "greenfield" : "extend",
    parallelism: 4,
  });
  if (!interfaces.ok) {
    await writeResult(args.resultPath, {
      ok: false,
      summary: "interface phase failed",
      materializedTo: outDir,
      leafResults: [],
      integrationOk: null,
      error: interfaces.error ?? "unknown",
    });
    return 1;
  }
  log(
    `  ${interfaces.entries.length} entries; ${interfaces.classes.length} classes; ${interfaces.dataFlow.length} data flows`,
  );
  await persist();

  // Phase 4: refactor
  log("phase=refactor");
  const refactor = await runRefactorPass(client, rpg, {
    description: args.task,
    maxAttempts: 2,
  });
  if (!refactor.ok) {
    await writeResult(args.resultPath, {
      ok: false,
      summary: "refactor phase failed",
      materializedTo: outDir,
      leafResults: [],
      integrationOk: null,
      error: refactor.error ?? "unknown",
    });
    return 1;
  }
  log(`  ${refactor.operations.length} operations`);
  await persist();

  // Phase 5: implementation
  log("phase=implementation");
  const build = await buildImplementations(client, rpg, {
    // Matches §5.3 of the RPG paper: "each function allows up to 8
    // debugging iterations." Was 3.
    maxAttemptsPerLeaf: 8,
    outDir,
    preserveHarness: true,
    diagnosis: { enabled: true, rounds: 5, afterFailures: 1 },
    maxTestRewrites: 20,
    useEditTools: true,
  });
  const greenLeaves = build.leafResults.filter((r) => r.ok);
  const redLeaves = build.leafResults.filter((r) => !r.ok);
  log(`  ${greenLeaves.length}/${build.leafResults.length} leaves green`);

  if (!build.ok) {
    if (build.workDir) {
      await rm(build.workDir, { recursive: true, force: true });
    }
    await writeResult(args.resultPath, {
      ok: false,
      summary: `implementation phase failed; ${redLeaves.length} leaves red`,
      materializedTo: outDir,
      leafResults: build.leafResults.map((r) => ({
        leafId: r.leafId,
        ok: r.ok,
        ...(r.fatal !== undefined ? { reason: r.fatal } : {}),
      })),
      integrationOk: null,
      error: redLeaves
        .map(
          (r) =>
            `${r.leafId}: ${r.fatal ?? r.lastFailure?.failureMessage ?? "?"}`,
        )
        .join("; "),
    });
    return 1;
  }

  // Phase 6: integration
  let integrationOk: boolean | null = null;
  let integrationError: string | null = null;
  if (build.workDir) {
    const branches = discoverBranches(rpg);
    log(`phase=integration (${branches.length} branches)`);
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
        // Matches §5.3 of the RPG paper: "each function allows up
        // to 8 debugging iterations." Was 3.
        maxAttemptsPerLeaf: 8,
        useLocalization: true,
      });
      log(
        `  rounds=${integration.rounds}; recoveries=${integration.recoveries.length}; ok=${integration.ok}`,
      );
      integrationOk = integration.ok;
      if (!integration.ok) {
        integrationError =
          integration.error ?? integration.failingBranchIds.join(", ");
      }
    } else {
      integrationOk = true;
    }
    await rm(build.workDir, { recursive: true, force: true });
  }

  // Summary numbers
  let fileCount = 0;
  let leafCount = 0;
  for (const node of Object.values(rpg.nodes)) {
    if (isFile(node) && node.interfacePlan) fileCount++;
    if (isCapability(node) && node.isLeaf) leafCount++;
  }
  log(`done. ${fileCount} files, ${leafCount} leaves materialized to ${outDir}`);

  await writeResult(args.resultPath, {
    ok: integrationOk !== false,
    summary: `${fileCount} files, ${leafCount} leaves; integration=${integrationOk === null ? "skipped" : integrationOk ? "ok" : "failed"}`,
    materializedTo: outDir,
    leafResults: build.leafResults.map((r) => ({
      leafId: r.leafId,
      ok: r.ok,
    })),
    integrationOk,
    error: integrationError,
  });
  return integrationOk === false ? 1 : 0;
}

// Parse args ONCE at the top so the catch handler can use them
// without risking a second throw. If parseArgs itself fails, no
// result file can be written (we don't know its path) — exit 2 is
// the documented "invalid args" code.
let args: ParsedArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] arg parse: ${msg}`);
  process.exit(2);
}

try {
  const code = await run(args);
  process.exit(code);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] uncaught: ${msg}`);
  try {
    await writeResult(args.resultPath, {
      ok: false,
      summary: "uncaught error in child",
      materializedTo: args.projectDir,
      leafResults: [],
      integrationOk: null,
      error: msg,
    });
  } catch {
    /* swallow */
  }
  process.exit(3);
}
