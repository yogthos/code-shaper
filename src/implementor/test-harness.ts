/**
 * Vitest test harness for the implementor.
 *
 * Materializes the in-progress RPG to a temp directory + drops a
 * minimal package.json + vitest config + tsconfig, then spawns
 * `vitest run --reporter=json`. Parses pass/fail per test and collects
 * failure messages so the body retry loop has actionable feedback.
 *
 * Per-leaf granularity: `runTests({ leafIds })` filters the test run
 * to only those leaves' generated test files. Speeds up the
 * inner-loop iteration substantially — running every test on every
 * dispatch would be O(n²) on leaf count.
 *
 * The harness is stateless across calls — each invocation writes the
 * latest rendered files fresh and discards them when done. Phase 6's
 * orchestrator owns the temp directory lifetime.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isFile, type RPG } from "../rpg/types.js";
import { renderTypeScriptFile } from "./render.js";

export interface TestRunOptions {
  /** Per-leaf body source. Used by the renderer; missing leaves
   *  render as throwing stubs. */
  bodyByLeafId: Map<string, string>;
  /** Per-leaf test source. Each entry becomes a `<leafId>.test.ts`
   *  under `tests/leaves/`. */
  testsByLeafId: Map<string, string>;
  /** Per-branch integration test source. Each entry becomes a
   *  `<branchSlug>.test.ts` under `tests/integration/`. Phase 7b
   *  populates this; Phase 6 leaves it empty. */
  integrationTestsByBranchId?: Map<string, string>;
  /** Filter: only run tests for these leaves. When omitted, runs
   *  every test in the harness directory. */
  leafIds?: string[];
  /** Filter: only run integration tests for these branches. When
   *  omitted but `leafIds` is set, integration tests are skipped
   *  entirely (for per-leaf runs). When both are omitted, the run
   *  covers every test. */
  branchIds?: string[];
  /** Existing temp directory to reuse across runs. When omitted, the
   *  harness creates and disposes its own. */
  workDir?: string;
  /** When true, leave the work directory in place on success — useful
   *  for debugging or downstream materialization. Defaults to false
   *  (cleanup after the run). Has no effect when `workDir` is set;
   *  the caller owns the lifetime in that case. */
  preserve?: boolean;
  /** Wall-clock timeout per vitest run. The harness kills the spawned
   *  process when the deadline fires and surfaces the cause as
   *  `fatal`. Defaults to 120s — long enough for a multi-suite run on
   *  a slow machine, short enough that a hung body doesn't wedge the
   *  pipeline. */
  timeoutMs?: number;
  /** Override the npx binary. Used by tests to simulate spawn
   *  failures; production callers leave it default. */
  npxBinary?: string;
}

export interface TestRunResult {
  /** True when every test passed. */
  ok: boolean;
  /** Per-leaf outcome. Indexed by leaf id slug (use
   *  `outcomeForLeaf(result, leafId)` to look up by original id). */
  byLeaf: Map<string, LeafTestOutcome>;
  /** Per-branch integration outcome. Same slug-keyed scheme as
   *  `byLeaf`; use `outcomeForBranch(result, branchId)` to look up by
   *  the original capability id. */
  byBranch: Map<string, LeafTestOutcome>;
  /** Root-level diagnostics — vitest startup errors, tsc parse fails,
   *  package.json wiring problems. Empty when the run was clean. */
  fatal?: string;
  /** Path the harness wrote to. Useful for inspection when a run
   *  fails or `preserve: true` is set. */
  workDir: string;
}

export interface LeafTestOutcome {
  ok: boolean;
  /** Failing assertions / error messages, joined for easy inclusion
   *  in the LLM retry prompt. Empty when ok=true. */
  failureMessage: string;
  /** Number of assertions in the leaf's test file. */
  testCount: number;
}

/**
 * Slugify a leaf capability id so it's safe as a filename. The id
 * format is e.g. `cap:folder:src/http/routing/get@d3#0` — strip
 * non-identifier characters.
 */
export function leafToTestFilename(leafId: string): string {
  return leafId.replace(/[^a-zA-Z0-9_-]+/g, "_") + ".test.ts";
}

/** Same shape as `leafToTestFilename` but for branch capability ids.
 *  Branch tests live in a sibling directory (`tests/integration/`) so
 *  their results are easy to attribute and the per-leaf glob doesn't
 *  accidentally pick them up. */
export function branchToTestFilename(branchId: string): string {
  return branchId.replace(/[^a-zA-Z0-9_-]+/g, "_") + ".test.ts";
}

/** Build a filter regex usable as vitest's `--testNamePattern`. We
 *  match by file path glob via `--include` instead, which is more
 *  reliable when we generate the filenames ourselves. */
function leafGlobFor(leafIds: string[]): string[] {
  return leafIds.map((id) => `tests/leaves/${leafToTestFilename(id)}`);
}

function branchGlobFor(branchIds: string[]): string[] {
  return branchIds.map(
    (id) => `tests/integration/${branchToTestFilename(id)}`,
  );
}

const PACKAGE_JSON = JSON.stringify(
  {
    name: "harness-tmp",
    type: "module",
    private: true,
    scripts: {
      test: "vitest run",
    },
  },
  null,
  2,
);

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
      lib: ["ES2022"],
      types: ["node"],
    },
    include: ["src/**/*", "tests/**/*"],
  },
  null,
  2,
);

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
`;

/** Provision a fresh harness directory with the standard scaffolding.
 *  Returns the path; caller is responsible for `rm`-ing it. */
export async function createHarnessDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "implementor-"));
  await writeFile(path.join(dir, "package.json"), PACKAGE_JSON);
  await writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
  await writeFile(path.join(dir, "vitest.config.ts"), VITEST_CONFIG);
  // node_modules is symlinked from the host repo so vitest + its
  // transitive deps are available without re-installing every run.
  // Caller of `runTests` is expected to do this once via
  // `linkHostNodeModules`.
  return dir;
}

/** Symlink the host repo's node_modules into the harness dir so
 *  vitest + tsx + tree-sitter are reachable. Cheaper than `npm
 *  install` per run. */
export async function linkHostNodeModules(
  harnessDir: string,
  hostRepo: string,
): Promise<void> {
  const target = path.join(harnessDir, "node_modules");
  const source = path.join(hostRepo, "node_modules");
  // `symlink` may fail on Windows without admin; that's a Phase 6+
  // problem. POSIX hosts are the supported target.
  const fs = await import("node:fs/promises");
  try {
    await fs.symlink(source, target, "dir");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw err;
  }
}

/** Write the rendered source files + per-leaf test files into the
 *  harness directory. Leaves with no test entry get a placeholder
 *  test that vitest will ignore. */
async function materializeForRun(
  rpg: RPG,
  workDir: string,
  bodyByLeafId: Map<string, string>,
  testsByLeafId: Map<string, string>,
  integrationTestsByBranchId: Map<string, string> | undefined,
): Promise<void> {
  // Source files: render the in-progress RPG.
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    const dest = path.join(workDir, node.path);
    await mkdir(path.dirname(dest), { recursive: true });
    const source = node.interfacePlan
      ? renderTypeScriptFile({ file: node, bodyByLeafId, rpg })
      : node.content;
    await writeFile(dest, source, "utf-8");
  }
  // Per-leaf tests. Wipe the directory first so leaves removed since
  // the previous materialize don't leave behind a stale `.test.ts` —
  // vitest would otherwise run it against newer source and report a
  // misleading pass/fail.
  await replaceTestDir(
    path.join(workDir, "tests/leaves"),
    [...testsByLeafId.entries()].map(([id, src]) => ({
      filename: leafToTestFilename(id),
      source: src,
    })),
  );
  // Per-branch integration tests — same fresh-write semantics.
  await replaceTestDir(
    path.join(workDir, "tests/integration"),
    integrationTestsByBranchId
      ? [...integrationTestsByBranchId.entries()].map(([id, src]) => ({
          filename: branchToTestFilename(id),
          source: src,
        }))
      : [],
  );
}

/** Wipe `dir` and rewrite the supplied test files. Idempotent: if
 *  `entries` is empty, the directory ends up empty too. */
async function replaceTestDir(
  dir: string,
  entries: Array<{ filename: string; source: string }>,
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const { filename, source } of entries) {
    await writeFile(path.join(dir, filename), source, "utf-8");
  }
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** Time we wait between SIGTERM and SIGKILL when reaping a hung
 *  test process. Long enough for vitest to flush its stdout, short
 *  enough that a wedged process doesn't keep the orchestrator
 *  blocked. */
const KILL_GRACE_MS = 1_000;

/**
 * Spawn vitest and return the parsed JSON report. The vitest JSON
 * reporter writes its output to stdout; we capture and parse.
 *
 * Cleanup is wrapped in `try/finally`: if any internal step throws
 * (spawn rejection, JSON parse exception, etc.) the temp dir is still
 * removed when this call owned it.
 */
export async function runTests(
  rpg: RPG,
  options: TestRunOptions,
): Promise<TestRunResult> {
  const workDir = options.workDir ?? (await createHarnessDir());
  const ownsDir = options.workDir === undefined;

  const result: TestRunResult = {
    ok: false,
    byLeaf: new Map(),
    byBranch: new Map(),
    workDir,
  };

  try {
    if (ownsDir) {
      await linkHostNodeModules(workDir, process.cwd());
    }
    await materializeForRun(
      rpg,
      workDir,
      options.bodyByLeafId,
      options.testsByLeafId,
      options.integrationTestsByBranchId,
    );

    // Filter shape:
    //   - leafIds + branchIds → run only those globs
    //   - leafIds only        → leaf tests only (Phase 6 per-leaf path)
    //   - branchIds only      → integration tests only (Phase 7b
    //                           per-branch path)
    //   - neither             → run everything in the harness
    const include: string[] = [];
    if (options.leafIds && options.leafIds.length > 0) {
      include.push(...leafGlobFor(options.leafIds));
    }
    if (options.branchIds && options.branchIds.length > 0) {
      include.push(...branchGlobFor(options.branchIds));
    }

    const args = ["vitest", "run", "--reporter=json"];
    for (const glob of include) args.push(glob);

    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const proc = await spawnCollect(
      options.npxBinary ?? "npx",
      args,
      workDir,
      timeoutMs,
    );
    return finalizeResult(proc, result);
  } catch (e) {
    result.fatal = `runTests threw: ${(e as Error).message}`;
    return result;
  } finally {
    if (ownsDir && !options.preserve) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

function finalizeResult(
  proc: ProcOutput,
  result: TestRunResult,
): TestRunResult {
  const { stdout, stderr, exitCode, timedOut, timeoutMs } = proc;
  if (timedOut) {
    result.fatal = `vitest timed out after ${timeoutMs}ms (exit=${exitCode}). stderr (truncated):\n${stderr.slice(0, 2000)}`;
    return result;
  }

  // vitest's JSON reporter emits a single JSON object on stdout. Some
  // versions interleave warnings — we look for the first '{' through
  // matching closing brace.
  const jsonText = extractJsonObject(stdout);
  if (!jsonText) {
    result.fatal = `vitest produced no parseable JSON (exit=${exitCode}). stderr:\n${stderr.slice(0, 4000)}`;
    return result;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    result.fatal = `JSON.parse failed: ${(e as Error).message}\nbody: ${jsonText.slice(0, 1000)}`;
    return result;
  }

  const testResults: any[] = parsed.testResults ?? [];
  let allOk = true;
  for (const tr of testResults) {
    const file = String(tr.name ?? "");
    const slug = slugFromTestFile(file);
    if (!slug) continue;
    const isIntegration = file.includes("/tests/integration/");
    const assertions: any[] = tr.assertionResults ?? [];
    const failing = assertions.filter((a) => a.status !== "passed");
    let failureMessage = failing
      .map((a) => {
        const msgs = (a.failureMessages ?? []).join("\n");
        return `- ${a.fullName ?? a.title}: ${msgs}`;
      })
      .join("\n");
    const ok = failing.length === 0 && tr.status !== "failed";
    if (!ok && failureMessage.length === 0) {
      const suiteMsg =
        tr.message ??
        (Array.isArray(tr.failureMessages)
          ? tr.failureMessages.join("\n")
          : null) ??
        tr.failureMessage ??
        "(no assertion details — likely a file-load or compile error)";
      failureMessage = `[suite-level failure] ${suiteMsg}`;
    }
    if (!ok) allOk = false;
    const outcome: LeafTestOutcome = {
      ok,
      failureMessage,
      testCount: assertions.length,
    };
    if (isIntegration) {
      result.byBranch.set(slug, outcome);
    } else {
      result.byLeaf.set(slug, outcome);
    }
  }
  if (parsed.success === false) allOk = false;
  if (parsed.numFailedTestSuites > 0) allOk = false;
  result.ok = allOk;

  if (!result.ok && stderr.length > 0) {
    const trimmed = stderr.trim();
    if (trimmed.length > 0) result.fatal = trimmed.slice(0, 4000);
  }
  return result;
}

function slugFromTestFile(filePath: string): string | null {
  const base = path.basename(filePath);
  if (!base.endsWith(".test.ts")) return null;
  return base.slice(0, -".test.ts".length);
}

/** Per-leaf outcome lookup keyed by the original capability id —
 *  hides the slug detail from callers. Returns undefined when the
 *  leaf had no test file in the run (e.g. it was filtered out). */
export function outcomeForLeaf(
  result: TestRunResult,
  leafId: string,
): LeafTestOutcome | undefined {
  const slug = leafToTestFilename(leafId).replace(".test.ts", "");
  return result.byLeaf.get(slug);
}

/** Per-branch outcome lookup by original capability id. */
export function outcomeForBranch(
  result: TestRunResult,
  branchId: string,
): LeafTestOutcome | undefined {
  const slug = branchToTestFilename(branchId).replace(".test.ts", "");
  return result.byBranch.get(slug);
}

/**
 * Extract the first balanced JSON object from a possibly-noisy
 * string. Handles strings with escaped quotes (`"\"…"`) and escaped
 * backslashes (`"\\"`) — the inner-string state machine consumes one
 * character after `\` regardless of what it is, so an escaped `"`
 * doesn't terminate the string and an escaped `\` doesn't pair with
 * the next character. Exported so other callers can use it directly.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

interface ProcOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the deadline fired before the process exited cleanly.
   *  Caller treats this as a fatal-class failure regardless of any
   *  partial stdout/stderr content. */
  timedOut: boolean;
  /** The deadline used (ms). Null when no timeout was applied. */
  timeoutMs: number | null;
}

function spawnCollect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number | null,
): Promise<ProcOutput> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: process.env });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      timeoutMs !== null
        ? setTimeout(() => {
            timedOut = true;
            // SIGTERM first; if the child ignores it, SIGKILL after a
            // short grace period.
            try {
              child.kill("SIGTERM");
              setTimeout(() => {
                if (!child.killed) {
                  try {
                    child.kill("SIGKILL");
                  } catch {
                    /* swallow */
                  }
                }
              }, KILL_GRACE_MS).unref();
            } catch {
              /* swallow */
            }
          }, timeoutMs)
        : null;
    if (timer) timer.unref();
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, timeoutMs });
    });
  });
}
