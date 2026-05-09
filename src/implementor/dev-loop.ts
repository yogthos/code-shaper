/**
 * Step 5 of the dev-loop refactor: runLeafDevLoop.
 *
 * Multi-turn agent harness for per-leaf TDD. Replaces (or runs
 * alongside, gated by `useDevLoop`) the §D.2-only edit author
 * with the canonical Claude-Code-style toolset:
 *
 *   read   list_files, read_file
 *   edit   edit_file (string-replace anywhere)
 *   probe  typecheck, run_test
 *   npm    add_dependency, remove_dependency, npm_run
 *   end    Terminate
 *
 * Why all of these and not just three: ampcode's canonical agent
 * is `read_file`, `list_files`, `edit_file`. We add probes
 * (typecheck, run_test) because the test loop needs them; we keep
 * the §D.2 surgical tools because they're useful for AST-strict
 * edits and the model can choose. Terminate is the model's commit
 * signal — the orchestrator's outer loop runs the test once more
 * to verify before recording the leaf as green.
 *
 * One-call-per-turn discipline matches our other multi-turn loops
 * (env-fix, edit-author). On rejection the failure goes back as a
 * tool message; the model gets a chance to correct itself.
 */

import { extractTopLevelImports } from "./edit-tools.js";
import {
  listFilesTool,
  readFileTool,
  editFileTool,
  typecheckTool,
  runTestTool,
} from "./dev-loop-tools.js";
import {
  listSymbolsInFile,
  findDefinition,
  findCallers,
  findImportsOf,
} from "./ast-queries.js";
import {
  addDependency,
  removeDependency,
  npmRun,
} from "../architect/npm-tools.js";
import type {
  ChatMessage,
  ChatOptions,
  LLMClient,
  LLMResponse,
} from "../llm/types.js";
import type { FileNode, PlannedInterface, RPG } from "../rpg/types.js";

export interface DevLoopInput {
  leaf: PlannedInterface;
  hostFile: FileNode;
  rpg: RPG;
  bodyByLeafId: Map<string, string>;
  testsByLeafId: Map<string, string>;
  /** Harness work directory for run_test. */
  workDir: string;
  /** Project directory for typecheck + npm tools. When omitted,
   *  typecheck short-circuits to ran:false and npm tools return a
   *  clean error pointing the model at the missing config. */
  outDir?: string;
  /** Override the npm binary used by add_dependency / npm_run.
   *  Defaults to "npm". Tests use a stub. */
  npmBinary?: string;
  /** Skip the npm install re-run inside add_dependency /
   *  remove_dependency (tests). Has no effect on set_script,
   *  which never installs. */
  skipNpmInstall?: boolean;
  /** Optional failure context from a prior leaf attempt — when
   *  set, the user prompt's "Previous failure" block surfaces
   *  it. */
  failureMessage?: string;
  maxIterations?: number;
  /** Wall-clock cap forwarded to runTestTool. */
  testTimeoutMs?: number;
  temperature?: number;
}

export interface DevLoopTrailEntry {
  iteration: number;
  /** Tool name, or `_invalid` for pre-apply rejections (unknown
   *  tool, JSON parse, multi-call turn). */
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Set on failure paths. */
  error?: string;
  /** Short summary of what happened — useful in the
   *  body-attempt summary the orchestrator writes back into
   *  retry prompts. */
  summary?: string;
}

export interface DevLoopResult {
  /** True when the agent terminated cleanly (Terminate tool
   *  called) and at least one edit landed a body for the active
   *  leaf. */
  ok: boolean;
  /** Final body for the active leaf, when one was produced. */
  body?: string;
  /** Per-iteration trail. */
  trail: DevLoopTrailEntry[];
  iterations: number;
  /** Loop-level error: budget exhausted, chat threw, etc. NOT
   *  set when individual tool calls failed but the agent
   *  recovered. */
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 15;
const TOOL_RESULT_OUTPUT_CAP = 4000;

export async function runLeafDevLoop(
  client: LLMClient,
  input: DevLoopInput,
): Promise<DevLoopResult> {
  const maxIterations = Math.max(1, input.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) },
  ];
  const opts: ChatOptions = {
    tools: TOOL_DEFS,
    toolChoice: "required",
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
  const trail: DevLoopTrailEntry[] = [];

  for (let i = 0; i < maxIterations; i++) {
    let response: LLMResponse;
    try {
      response = await client.chat(messages, opts);
    } catch (e) {
      const err = `dev-loop chat failed at iteration ${i + 1}: ${e instanceof Error ? e.message : String(e)}`;
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        ok: false,
        error: err,
      });
      return {
        ok: false,
        trail,
        iterations: i + 1,
        error: err,
        ...(input.bodyByLeafId.has(input.leaf.leafCapabilityId)
          ? { body: input.bodyByLeafId.get(input.leaf.leafCapabilityId)! }
          : {}),
      };
    }
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      // Without a tool call ID we can't push a tool message and
      // continue — bail out. With toolChoice: "required" this
      // shouldn't happen, but defensive.
      const err = "agent did not emit a tool call (response was prose-only)";
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        ok: false,
        error: err,
      });
      return {
        ok: false,
        trail,
        iterations: i + 1,
        error: err,
        ...(input.bodyByLeafId.has(input.leaf.leafCapabilityId)
          ? { body: input.bodyByLeafId.get(input.leaf.leafCapabilityId)! }
          : {}),
      };
    }
    if (toolCalls.length > 1) {
      // Multi-call turn — reject with one tool-error per call so
      // the OpenAI protocol stays consistent.
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      for (const c of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify({
            error:
              "Emit exactly ONE tool call per turn. Pick one, see the result, then decide.",
          }),
        });
      }
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        ok: false,
        error: "rejected: multi-tool-call turn",
      });
      continue;
    }
    const call = toolCalls[0]!;
    const toolName = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch (e) {
      const err = `arguments did not parse as JSON: ${e instanceof Error ? e.message : String(e)}`;
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ error: err }),
      });
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        ok: false,
        error: `${toolName}: ${err}`,
      });
      continue;
    }

    if (toolName === "Terminate") {
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ ok: true }),
      });
      trail.push({
        iteration: i + 1,
        tool: "Terminate",
        args,
        ok: true,
      });
      const body = input.bodyByLeafId.get(input.leaf.leafCapabilityId);
      return {
        // Termination is "successful" iff the active leaf has a
        // body the orchestrator can run a final test against.
        // No body = the model terminated without making the
        // edit; not a real success.
        ok: body !== undefined,
        ...(body !== undefined ? { body } : {}),
        trail,
        iterations: i + 1,
        ...(body === undefined
          ? { error: "terminated without producing an implementation for the task" }
          : {}),
      };
    }

    // Apply the tool. Each branch returns { result: object, ok:
    // bool, summary?: string }, then we both push the result back
    // to the model and record on the trail.
    const applied = await applyTool(toolName, args, input);
    trail.push({
      iteration: i + 1,
      tool: toolName,
      args,
      ok: applied.ok,
      ...(applied.error ? { error: applied.error } : {}),
      ...(applied.summary ? { summary: applied.summary } : {}),
    });
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: toolCalls,
    });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(applied.toolResult),
    });
  }

  // Budget exhausted without Terminate.
  const body = input.bodyByLeafId.get(input.leaf.leafCapabilityId);
  return {
    ok: false,
    ...(body !== undefined ? { body } : {}),
    trail,
    iterations: maxIterations,
    error: `dev loop exhausted ${maxIterations} iterations without Terminate`,
  };
}

interface AppliedTool {
  ok: boolean;
  /** What we send back to the model as the tool message. */
  toolResult: Record<string, unknown>;
  /** Trail-only error, when applicable. */
  error?: string;
  /** Trail-only short summary. */
  summary?: string;
}

async function applyTool(
  toolName: string,
  args: Record<string, unknown>,
  input: DevLoopInput,
): Promise<AppliedTool> {
  switch (toolName) {
    case "list_files": {
      const r = listFilesTool({ rpg: input.rpg });
      return {
        ok: true,
        toolResult: { files: r.files },
        summary: `${r.files.length} files`,
      };
    }
    case "read_file": {
      const p = args["path"];
      if (typeof p !== "string") {
        return {
          ok: false,
          toolResult: { error: "path must be a string" },
          error: "path must be a string",
        };
      }
      const r = readFileTool({
        rpg: input.rpg,
        bodyByLeafId: input.bodyByLeafId,
        testsByLeafId: input.testsByLeafId,
        path: p,
        ...(input.outDir !== undefined ? { outDir: input.outDir } : {}),
      });
      return {
        ok: r.ok,
        toolResult: r.ok ? { content: r.content } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok ? { summary: `read ${p} (${(r.content ?? "").length} chars)` } : {}),
      };
    }
    case "list_symbols_in_file": {
      const p = args["path"];
      if (typeof p !== "string") {
        return {
          ok: false,
          toolResult: { error: "path must be a string" },
          error: "path must be a string",
        };
      }
      if (!input.outDir) {
        return {
          ok: false,
          toolResult: { error: "list_symbols_in_file requires outDir" },
          error: "outDir not configured",
        };
      }
      const r = await listSymbolsInFile({ outDir: input.outDir, path: p });
      return {
        ok: r.ok,
        toolResult: r.ok ? { symbols: r.symbols } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok
          ? { summary: `${r.symbols!.length} symbols in ${p}` }
          : {}),
      };
    }
    case "find_definition": {
      const name = args["name"];
      if (typeof name !== "string") {
        return {
          ok: false,
          toolResult: { error: "name must be a string" },
          error: "name must be a string",
        };
      }
      if (!input.outDir) {
        return {
          ok: false,
          toolResult: { error: "find_definition requires outDir" },
          error: "outDir not configured",
        };
      }
      const r = await findDefinition({ outDir: input.outDir, name });
      return {
        ok: r.ok,
        toolResult: r.ok ? { matches: r.matches } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok
          ? {
              summary: `find_definition ${name} → ${r.matches!.length} match(es)`,
            }
          : {}),
      };
    }
    case "find_callers": {
      const name = args["name"];
      if (typeof name !== "string") {
        return {
          ok: false,
          toolResult: { error: "name must be a string" },
          error: "name must be a string",
        };
      }
      if (!input.outDir) {
        return {
          ok: false,
          toolResult: { error: "find_callers requires outDir" },
          error: "outDir not configured",
        };
      }
      const r = await findCallers({ outDir: input.outDir, name });
      return {
        ok: r.ok,
        toolResult: r.ok ? { matches: r.matches } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok
          ? {
              summary: `find_callers ${name} → ${r.matches!.length} caller(s)`,
            }
          : {}),
      };
    }
    case "find_imports_of": {
      const modulePath = args["module_path"];
      if (typeof modulePath !== "string") {
        return {
          ok: false,
          toolResult: { error: "module_path must be a string" },
          error: "module_path must be a string",
        };
      }
      if (!input.outDir) {
        return {
          ok: false,
          toolResult: { error: "find_imports_of requires outDir" },
          error: "outDir not configured",
        };
      }
      const r = await findImportsOf({
        outDir: input.outDir,
        modulePath,
      });
      return {
        ok: r.ok,
        toolResult: r.ok ? { matches: r.matches } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok
          ? {
              summary: `find_imports_of ${modulePath} → ${r.matches!.length} importer(s)`,
            }
          : {}),
      };
    }
    case "edit_file": {
      const p = args["path"];
      const oldStr = args["old_str"];
      const newStr = args["new_str"];
      if (
        typeof p !== "string" ||
        typeof oldStr !== "string" ||
        typeof newStr !== "string"
      ) {
        return {
          ok: false,
          toolResult: {
            error: "path, old_str, new_str must all be strings",
          },
          error: "path, old_str, new_str must all be strings",
        };
      }
      const r = await editFileTool({
        rpg: input.rpg,
        bodyByLeafId: input.bodyByLeafId,
        testsByLeafId: input.testsByLeafId,
        activeFilePath: input.hostFile.path,
        activeLeafId: input.leaf.leafCapabilityId,
        path: p,
        old_str: oldStr,
        new_str: newStr,
        ...(input.outDir !== undefined ? { outDir: input.outDir } : {}),
      });
      if (r.ok && r.newContent !== undefined && r.kind !== "infra") {
        // Mirror the model's imports back into FileNode.rawImports
        // so subsequent renders preserve them. Infra-file edits
        // (package.json, tsconfig.json, etc.) bypass this — they
        // don't affect the renderer's import emission for src
        // files.
        syncImportsFromSource(input, r.newContent);
      }
      return {
        ok: r.ok,
        toolResult: r.ok ? { ok: true } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok
          ? {
              summary: `edit_file ${p} applied${r.kind === "infra" ? " (infra)" : ""}`,
            }
          : {}),
      };
    }
    case "typecheck": {
      if (!input.outDir) {
        return {
          ok: true,
          toolResult: {
            ran: false,
            ok: true,
            note: "outDir not configured for this leaf — typecheck skipped",
          },
          summary: "typecheck skipped (no outDir)",
        };
      }
      const r = await typecheckTool({
        outDir: input.outDir,
        activeFilePath: input.hostFile.path,
      });
      return {
        ok: r.ok,
        toolResult: {
          ran: r.ran,
          ok: r.ok,
          ...(r.diagnostics.length > 0
            ? { diagnostics: tailTruncateLines(r.diagnostics, TOOL_RESULT_OUTPUT_CAP) }
            : {}),
        },
        summary: r.ran
          ? r.ok
            ? "typecheck clean"
            : `typecheck ${r.diagnostics.length} diagnostic(s)`
          : "typecheck not run",
      };
    }
    case "run_test": {
      if (!input.outDir) {
        return {
          ok: false,
          toolResult: {
            error: "run_test requires outDir. The harness was started without one.",
          },
          error: "run_test: outDir not configured",
        };
      }
      const r = await runTestTool({
        outDir: input.outDir,
        ...(input.testTimeoutMs !== undefined ? { timeoutMs: input.testTimeoutMs } : {}),
      });
      return {
        ok: r.ok,
        toolResult: {
          ok: r.ok,
          ...(r.output ? { output: tailTruncate(r.output, TOOL_RESULT_OUTPUT_CAP) } : {}),
        },
        summary: r.ok ? "all tests passed" : "tests failed",
      };
    }
    case "add_dependency":
    case "remove_dependency":
    case "npm_run": {
      return applyNpmTool(toolName, args, input);
    }
    default:
      return {
        ok: false,
        toolResult: {
          error: `unknown tool ${JSON.stringify(toolName)}. Valid: list_files, read_file, list_symbols_in_file, find_definition, find_callers, find_imports_of, edit_file, typecheck, run_test, add_dependency, remove_dependency, npm_run, Terminate.`,
        },
        error: `unknown tool: ${toolName}`,
      };
  }
}

async function applyNpmTool(
  toolName: string,
  args: Record<string, unknown>,
  input: DevLoopInput,
): Promise<AppliedTool> {
  if (!input.outDir) {
    return {
      ok: false,
      toolResult: {
        error: `${toolName} requires the project directory (outDir). The harness was started without one — npm tools are unavailable for this leaf. Edit code only.`,
      },
      error: `${toolName}: outDir not configured`,
    };
  }
  const npmBinary = input.npmBinary ?? "npm";
  const skipNpmInstall = input.skipNpmInstall ?? false;
  switch (toolName) {
    case "add_dependency": {
      const name = args["name"];
      const version = args["version"];
      const which = args["which"];
      if (
        typeof name !== "string" ||
        typeof version !== "string" ||
        (which !== "runtime" && which !== "dev")
      ) {
        return {
          ok: false,
          toolResult: {
            error:
              "add_dependency: name and version must be strings; which must be \"runtime\" or \"dev\"",
          },
          error: "arg validation failed",
        };
      }
      const r = await addDependency({
        outDir: input.outDir,
        name,
        version,
        which,
        npmBinary,
        skipNpmInstall,
      });
      return {
        ok: r.ok,
        toolResult: serializeNpmResult(r, "add_dependency"),
        ...(r.error ? { error: r.error } : {}),
        summary: r.ok
          ? r.changed
            ? `add_dependency ${name}@${version} (${which})`
            : `add_dependency ${name} already at ${version}`
          : `add_dependency ${name} failed`,
      };
    }
    case "remove_dependency": {
      const name = args["name"];
      if (typeof name !== "string") {
        return {
          ok: false,
          toolResult: { error: "remove_dependency: name must be a string" },
          error: "arg validation failed",
        };
      }
      const r = await removeDependency({
        outDir: input.outDir,
        name,
        npmBinary,
        skipNpmInstall,
      });
      return {
        ok: r.ok,
        toolResult: serializeNpmResult(r, "remove_dependency"),
        ...(r.error ? { error: r.error } : {}),
        summary: r.ok
          ? r.changed
            ? `remove_dependency ${name}`
            : `remove_dependency ${name} (already absent)`
          : `remove_dependency ${name} failed`,
      };
    }
    case "npm_run": {
      const script = args["script"];
      if (typeof script !== "string") {
        return {
          ok: false,
          toolResult: { error: "npm_run: script must be a string" },
          error: "arg validation failed",
        };
      }
      const r = await npmRun({
        outDir: input.outDir,
        script,
        npmBinary,
      });
      return {
        ok: r.ok,
        toolResult: serializeNpmResult(r, "npm_run"),
        ...(r.error ? { error: r.error } : {}),
        summary: r.ok ? `npm_run ${script} passed` : `npm_run ${script} failed`,
      };
    }
    default:
      return {
        ok: false,
        toolResult: { error: `unknown npm tool ${toolName}` },
        error: "unreachable",
      };
  }
}

/** Tail-truncated, install-flag-pruned-for-probes serialization
 *  used by the npm-tool branches. Mirrors env-fix's serializer
 *  shape so the model sees a consistent format whether the tool
 *  was driven from the dev loop or the standalone env-fix
 *  session. */
function serializeNpmResult(
  npmResult: import("../architect/npm-tools.js").NpmOpResult & { exitCode?: number | null },
  toolName: string,
): Record<string, unknown> {
  const isProbe = toolName === "npm_run";
  const tail = (s: string | undefined, max: number): string | undefined =>
    s ? (s.length > max ? "...[truncated head]\n" + s.slice(s.length - max) : s) : s;
  return {
    ok: npmResult.ok,
    ...(isProbe
      ? {}
      : {
          installRan: npmResult.installRan,
          installOk: npmResult.installOk,
        }),
    ...(npmResult.changed !== undefined ? { changed: npmResult.changed } : {}),
    ...(("exitCode" in npmResult)
      ? { exitCode: (npmResult as { exitCode?: unknown }).exitCode }
      : {}),
    ...(npmResult.error ? { error: npmResult.error } : {}),
    ...(npmResult.installStdout
      ? { stdout: tail(npmResult.installStdout, TOOL_RESULT_OUTPUT_CAP) }
      : {}),
    ...(npmResult.installStderr
      ? { stderr: tail(npmResult.installStderr, TOOL_RESULT_OUTPUT_CAP) }
      : {}),
  };
}

/** Mirror imports the model added during this edit back into
 *  `hostFile.rawImports`. The renderer emits imports from
 *  rawImports, so without this every render after the edit
 *  would strip the model's new imports — leaf bodies that
 *  reference imported symbols would then become unresolved on
 *  the next read_file / run_test. We REPLACE rather than merge
 *  because removing an obsolete import is a legitimate edit;
 *  the model controls the import set as long as the dev loop
 *  is active. */

function syncImportsFromSource(input: DevLoopInput, newSource: string): void {
  input.hostFile.rawImports = extractTopLevelImports(newSource).map((i) => ({
    name: i.name,
    source: i.source,
    isDefault: i.isDefault,
  }));
}

function tailTruncate(s: string, cap: number): string {
  return s.length > cap ? "...[truncated head]\n" + s.slice(s.length - cap) : s;
}

function tailTruncateLines(lines: string[], cap: number): string[] {
  const joined = lines.join("\n");
  if (joined.length <= cap) return lines;
  return tailTruncate(joined, cap).split("\n");
}

// ── System prompt + user prompt + tool defs ──────────────────────────

const SYSTEM_PROMPT = `You are a software engineer implementing a feature in a TypeScript project, using test-driven development. You have tools to explore the project, edit any file, type-check, and run tests.

Workflow (TDD):
  1. Read the task description carefully.
  2. Write a test (or several) that capture the contract — meaningful behavior, not just a smoke check. Place the test next to the source file or under a tests/ folder, per the project's existing convention.
  3. Run the tests. They should fail (the implementation isn't there yet).
  4. Implement the body until tests pass.
  5. Use typecheck to catch type errors before running tests.
  6. Iterate — read what you don't know before changing it. When a test fails, decide whether the implementation is wrong or your test contract was off.
  7. Call Terminate when the tests you wrote pass and you're confident the feature is correctly implemented.

Tools:
  list_files                      List every file in the project. Use first to see what exists.
  read_file(path)                 Read one file's current source. Use to inspect siblings before importing them.
  list_symbols_in_file(path)      Top-level exports (function/class/const/type/interface) with kinds + line numbers. Cheaper than read_file when you only want the surface.
  find_definition(name)           AST-exact: where is a function/class/const with this name declared? Returns matches across all .ts files.
  find_callers(name)              AST-exact: which files reference this name as an identifier? Skips comments and string contents. Excludes the definition site.
  find_imports_of(module_path)    AST-exact: which files import from this module path?
  edit_file(path, old_str, new_str)
                                  String replacement on ANY file in the project (source, tests, package.json, vitest.config.ts, tsconfig.json, etc.). old_str must match the file's CURRENT content exactly once. Re-read after each edit.
  typecheck                       Run tsc --noEmit. Returns diagnostics. Run after non-trivial edits before running tests.
  run_test                        Run the project's tests (vitest run). Returns pass/fail + assertion output.
  add_dependency(name, version, which)
                                  Install a runtime ("which":"runtime") or dev ("which":"dev") dependency. Use when imports fail with "Cannot find module X".
  remove_dependency(name)         Strip a package + re-install. Useful before swapping bindings (e.g. broken native deps).
  npm_run(script)                 Run an existing npm script. Returns exit code + stdout/stderr.
  Terminate(reason)               End the session. Call when the tests you wrote pass and the feature is correctly implemented.

Pick exactly ONE tool per turn.`;

function buildUserPrompt(input: DevLoopInput): string {
  const lines: string[] = [];
  lines.push(`# Task`);
  lines.push("");
  if (input.leaf.kind === "method" && input.leaf.ownerClassName) {
    lines.push(
      `Implement method \`${input.leaf.ownerClassName}.${input.leaf.name}\` in ${input.hostFile.path}.`,
    );
  } else {
    lines.push(
      `Implement function \`${input.leaf.name}\` in ${input.hostFile.path}.`,
    );
  }
  lines.push("");
  lines.push("Description:");
  lines.push(input.leaf.description.trim() || "(no description provided)");
  lines.push("");
  lines.push(
    "Approach: write tests that capture this behavior, then implement. Iterate until your tests pass.",
  );
  lines.push("");
  if (input.failureMessage) {
    lines.push("# Previous failure");
    lines.push("");
    lines.push("```");
    const cap = 3000;
    lines.push(
      input.failureMessage.length > cap
        ? "...[truncated head]\n" +
            input.failureMessage.slice(input.failureMessage.length - cap)
        : input.failureMessage,
    );
    lines.push("```");
    lines.push("");
  }
  lines.push(
    "Use the tools to explore, edit, run tests, then call Terminate. Don't write prose — pick a tool.",
  );
  return lines.join("\n");
}

const TOOL_DEFS: NonNullable<ChatOptions["tools"]> = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List every file in the project (paths + planned-leaf names + summary).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file's content. Tries the RPG first (rendered with current bodies); falls back to a disk read under outDir for project files outside the planned graph (vitest.config.ts, tsconfig.json, .env, node_modules/<dep>/...).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Repo-relative path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_symbols_in_file",
      description:
        "Return top-level exports of a file: function/class/method/const/type/interface declarations with their kinds + line numbers. Cheaper than read_file when you only need the surface.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_definition",
      description:
        "AST-exact lookup: which file + line declares the function/class/const/type/interface with this name? Returns all matches across the project.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Symbol name." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_callers",
      description:
        "AST-exact lookup: which files reference this symbol as an identifier? Skips comments and string contents (no false positives). Excludes the symbol's own declaration site.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Symbol name to find references for." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_imports_of",
      description:
        "AST-exact lookup: which files have an import statement from this module path? Useful before refactoring a module's exports.",
      parameters: {
        type: "object",
        properties: {
          module_path: {
            type: "string",
            description: "Module specifier as it appears in import (e.g. \"./errors.js\").",
          },
        },
        required: ["module_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "String replacement. Works on ANY file in the project — source, tests, package.json, vitest.config.ts, tsconfig.json, etc. old_str must match the file's CURRENT content exactly once. Use read_file to refresh your view after edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path of any file in the project." },
          old_str: { type: "string", description: "Existing snippet to replace. Must match exactly once." },
          new_str: { type: "string", description: "Replacement snippet." },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "typecheck",
      description: "Run tsc --noEmit on the project. Returns diagnostics for type errors.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run the project's tests (vitest run). Returns pass/fail + assertion output.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "add_dependency",
      description:
        'Install a runtime or dev dependency. Use when "Cannot find module X" appears — pick a working binding. If a chosen native dep fails to compile (gyp errors), remove + add an alternative (e.g. better-sqlite3 → libsql or node:sqlite).',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string", description: 'e.g. "^3.22.0"' },
          which: { type: "string", enum: ["runtime", "dev"] },
        },
        required: ["name", "version", "which"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_dependency",
      description: "Remove a package from both runtime and dev buckets and re-install. Useful before swapping bindings.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "npm_run",
      description: "Run an existing npm script. Returns exit code + stdout/stderr. Use to verify a remediation before terminating.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Terminate",
      description:
        "End the session. Call when you believe the leaf is done. The orchestrator runs the test once more to verify.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
    },
  },
];
