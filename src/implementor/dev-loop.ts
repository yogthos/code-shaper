/**
 * Step 5 of the dev-loop refactor: runLeafDevLoop.
 *
 * Multi-turn agent harness for per-leaf TDD. Replaces (or runs
 * alongside, gated by `useDevLoop`) the §D.2-only edit author
 * with the canonical Claude-Code-style toolset:
 *
 *   read   list_files, read_file
 *   edit   edit_file (string-replace), edit_function_in_file,
 *          edit_method_of_class_in_file, edit_whole_class_in_file,
 *          edit_imports_and_assignments_in_file
 *   probe  typecheck, run_test
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

import {
  editFunctionInFile,
  editMethodOfClassInFile,
  editWholeClassInFile,
  editImportsAndAssignmentsInFile,
  extractFunctionBody,
  extractMethodBody,
  extractTopLevelImports,
  checkTypescriptSyntax,
  type EditResult,
} from "./edit-tools.js";
import {
  listFilesTool,
  readFileTool,
  editFileTool,
  typecheckTool,
  runTestTool,
} from "./dev-loop-tools.js";
import {
  addDependency,
  removeDependency,
  setScript,
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
  /** Step S5: per-loop budget for rewrite_test calls. The
   *  test contract is mutable but bounded — without a cap, the
   *  model could trivially game its way to "passing" by
   *  rewriting the test until it matches its (broken) body.
   *  Default 3. The body still has to satisfy whatever rewrite
   *  the model authors. */
  maxRewriteTests?: number;
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
  // Step S5: rewrite_test budget. Tracks count locally; the
  // applyTool dispatch enforces the cap.
  const maxRewriteTests = input.maxRewriteTests ?? 3;
  const rewriteTestCounter = { count: 0, max: maxRewriteTests };

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
          ? { error: "agent terminated without producing a body for the active leaf" }
          : {}),
      };
    }

    // Apply the tool. Each branch returns { result: object, ok:
    // bool, summary?: string }, then we both push the result back
    // to the model and record on the trail.
    const applied = await applyTool(toolName, args, input, rewriteTestCounter);
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

interface RewriteTestCounter {
  count: number;
  max: number;
}

async function applyTool(
  toolName: string,
  args: Record<string, unknown>,
  input: DevLoopInput,
  rewriteTestCounter: RewriteTestCounter,
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
      const r = await runTestTool({
        rpg: input.rpg,
        bodyByLeafId: input.bodyByLeafId,
        testsByLeafId: input.testsByLeafId,
        activeLeafId: input.leaf.leafCapabilityId,
        workDir: input.workDir,
        ...(input.testTimeoutMs !== undefined ? { timeoutMs: input.testTimeoutMs } : {}),
      });
      return {
        ok: r.ok,
        toolResult: {
          ok: r.ok,
          ...(r.output ? { output: tailTruncate(r.output, TOOL_RESULT_OUTPUT_CAP) } : {}),
        },
        summary: r.ok ? "test passed" : "test failed",
      };
    }
    case "rewrite_test": {
      // Step S5: the model can rewrite the active leaf's test
      // when the existing test contract is unwinnable (jsdom-
      // only browser code, async WASM init, etc.). Bounded by a
      // budget so the model can't trivially game its way to
      // passing.
      if (rewriteTestCounter.count >= rewriteTestCounter.max) {
        return {
          ok: false,
          toolResult: {
            error: `rewrite_test budget exhausted (${rewriteTestCounter.max} rewrites used). Either make the body satisfy the current test, or call Terminate / skip_with_smoke_test.`,
          },
          error: "rewrite_test budget exhausted",
        };
      }
      const newSource = args["new_source"];
      if (typeof newSource !== "string" || newSource.length === 0) {
        return {
          ok: false,
          toolResult: { error: "rewrite_test: new_source must be a non-empty string" },
          error: "arg validation failed",
        };
      }
      const parse = checkTypescriptSyntax(newSource);
      if (!parse.ok) {
        return {
          ok: false,
          toolResult: {
            error: `rewrite_test: new_source does not parse as TypeScript. ${parse.error}`,
          },
          error: "rewrite_test: parse failure",
        };
      }
      // Commit: replace the leaf's test in testsByLeafId.
      // bodyByLeafId is unchanged — the model still has to
      // satisfy whatever the new test asserts.
      input.testsByLeafId.set(input.leaf.leafCapabilityId, newSource);
      rewriteTestCounter.count++;
      return {
        ok: true,
        toolResult: {
          ok: true,
          rewrites_used: rewriteTestCounter.count,
          rewrites_remaining: rewriteTestCounter.max - rewriteTestCounter.count,
        },
        summary: `rewrite_test (${rewriteTestCounter.count}/${rewriteTestCounter.max})`,
      };
    }
    case "skip_with_smoke_test": {
      // Step S6: shorthand for rewrite_test that generates a
      // trivial shape-check test for the active leaf. Use when
      // the original test contract is genuinely unwinnable
      // (browser-only code with no jsdom, async WASM init that
      // can't be mocked cheaply, env-dependent classes).
      // Consumes one slot of the rewrite_test budget — the
      // model can't run away with skips.
      if (rewriteTestCounter.count >= rewriteTestCounter.max) {
        return {
          ok: false,
          toolResult: {
            error: `skip_with_smoke_test: rewrite budget exhausted (${rewriteTestCounter.max} used). The leaf must satisfy its current test.`,
          },
          error: "skip budget exhausted",
        };
      }
      const reason = args["reason"];
      if (typeof reason !== "string" || reason.trim().length === 0) {
        const msg = "skip_with_smoke_test: reason must be a non-empty string explaining why the leaf is genuinely untestable in isolation";
        return {
          ok: false,
          toolResult: { error: msg },
          error: msg,
        };
      }
      const smokeSource = buildSmokeTest(input.leaf, input.hostFile, reason);
      input.testsByLeafId.set(input.leaf.leafCapabilityId, smokeSource);
      rewriteTestCounter.count++;
      return {
        ok: true,
        toolResult: {
          ok: true,
          smoke_test_installed: true,
          rewrites_used: rewriteTestCounter.count,
          rewrites_remaining: rewriteTestCounter.max - rewriteTestCounter.count,
        },
        summary: `skip_with_smoke_test (${rewriteTestCounter.count}/${rewriteTestCounter.max}): ${reason.slice(0, 80)}`,
      };
    }
    case "edit_function_in_file":
    case "edit_whole_class_in_file":
    case "edit_method_of_class_in_file":
    case "edit_imports_and_assignments_in_file": {
      return applySurgicalEdit(toolName, args, input);
    }
    case "add_dependency":
    case "remove_dependency":
    case "set_script":
    case "npm_run": {
      return applyNpmTool(toolName, args, input);
    }
    default:
      return {
        ok: false,
        toolResult: {
          error: `unknown tool ${JSON.stringify(toolName)}. Valid: list_files, read_file, edit_file, rewrite_test, skip_with_smoke_test, typecheck, run_test, edit_function_in_file, edit_whole_class_in_file, edit_method_of_class_in_file, edit_imports_and_assignments_in_file, add_dependency, remove_dependency, set_script, npm_run, Terminate.`,
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
    case "set_script": {
      const name = args["name"];
      const command = args["command"];
      if (typeof name !== "string" || typeof command !== "string") {
        return {
          ok: false,
          toolResult: {
            error: "set_script: name and command must be strings",
          },
          error: "arg validation failed",
        };
      }
      const r = await setScript({
        outDir: input.outDir,
        name,
        command,
        skipNpmInstall: true,
      });
      return {
        ok: r.ok,
        toolResult: serializeNpmResult(r, "set_script"),
        ...(r.error ? { error: r.error } : {}),
        summary: r.ok
          ? r.changed
            ? `set_script ${name}`
            : `set_script ${name} (unchanged)`
          : `set_script ${name} failed`,
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

function applySurgicalEdit(
  toolName: string,
  args: Record<string, unknown>,
  input: DevLoopInput,
): AppliedTool {
  // Render the host file with the current body map so we apply
  // the §D.2 edit to the SAME view the model is reasoning over.
  const currentSource = renderHost(input);
  let result: EditResult;
  switch (toolName) {
    case "edit_function_in_file": {
      const name = args["function_name"];
      const src = args["new_source"];
      if (typeof name !== "string" || typeof src !== "string") {
        return {
          ok: false,
          toolResult: {
            error:
              "edit_function_in_file: function_name and new_source must be strings",
          },
          error: "arg validation failed",
        };
      }
      result = editFunctionInFile(currentSource, name, src);
      break;
    }
    case "edit_whole_class_in_file": {
      const name = args["class_name"];
      const src = args["new_source"];
      if (typeof name !== "string" || typeof src !== "string") {
        return {
          ok: false,
          toolResult: {
            error: "edit_whole_class_in_file: class_name and new_source must be strings",
          },
          error: "arg validation failed",
        };
      }
      result = editWholeClassInFile(currentSource, name, src);
      break;
    }
    case "edit_method_of_class_in_file": {
      const className = args["class_name"];
      const methodName = args["method_name"];
      const src = args["new_source"];
      if (
        typeof className !== "string" ||
        typeof methodName !== "string" ||
        typeof src !== "string"
      ) {
        return {
          ok: false,
          toolResult: {
            error:
              "edit_method_of_class_in_file: class_name, method_name, new_source must be strings",
          },
          error: "arg validation failed",
        };
      }
      result = editMethodOfClassInFile(currentSource, className, methodName, src);
      break;
    }
    case "edit_imports_and_assignments_in_file": {
      const src = args["new_source"];
      if (typeof src !== "string") {
        return {
          ok: false,
          toolResult: {
            error: "edit_imports_and_assignments_in_file: new_source must be a string",
          },
          error: "arg validation failed",
        };
      }
      result = editImportsAndAssignmentsInFile(currentSource, src);
      break;
    }
    default:
      // Unreachable — applyTool already filtered.
      return {
        ok: false,
        toolResult: { error: `unknown surgical tool ${toolName}` },
      };
  }
  if (!result.ok) {
    return {
      ok: false,
      toolResult: { error: result.error ?? "(no error)" },
      error: result.error,
    };
  }
  // Re-extract the leaf body from the edited source. If the
  // model's edit broke the body extractor's invariant (renamed
  // the function, removed the method), surface that explicitly
  // instead of silently advancing.
  const body = extractBodyForActiveLeaf(result.source!, input.leaf);
  if (body === null) {
    return {
      ok: false,
      toolResult: {
        error: `edit succeeded but the body for ${input.leaf.kind === "method" ? `${input.leaf.ownerClassName}.${input.leaf.name}` : input.leaf.name} could not be re-extracted from the resulting source. Don't rename or remove the active leaf's declaration.`,
      },
      error: "body extraction failed after edit",
    };
  }
  input.bodyByLeafId.set(input.leaf.leafCapabilityId, body);
  // Mirror imports — the §D.2 edit_imports_and_assignments_in_file
  // path most obviously needs this; the function/class/method
  // edits leave imports unchanged but syncing is idempotent and
  // keeps the rule consistent.
  syncImportsFromSource(input, result.source!);
  return {
    ok: true,
    toolResult: { ok: true },
    summary: `${toolName} applied`,
  };
}

function renderHost(input: DevLoopInput): string {
  // Use the read tool's rendering path to keep a single source
  // of truth. The active leaf's body comes from bodyByLeafId
  // (or renders as a stub when absent).
  const r = readFileTool({
    rpg: input.rpg,
    bodyByLeafId: input.bodyByLeafId,
    testsByLeafId: input.testsByLeafId,
    path: input.hostFile.path,
  });
  if (!r.ok) {
    // Shouldn't happen — input.hostFile.path comes from the RPG.
    return input.hostFile.content;
  }
  return r.content!;
}

function extractBodyForActiveLeaf(
  source: string,
  leaf: PlannedInterface,
): string | null {
  if (leaf.kind === "method") {
    if (!leaf.ownerClassName) return null;
    return extractMethodBody(source, leaf.ownerClassName, leaf.name);
  }
  return extractFunctionBody(source, leaf.name);
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
/** Step S6: synthesize a trivial shape-check test for the
 *  active leaf. The shape varies by leaf kind:
 *    - function: `expect(typeof <name>).toBe("function")`
 *    - method:   `expect(<Class>.prototype.<method>).toBeDefined()`
 *  The test imports from the host file using the same
 *  relative-import convention the test author uses. */
function buildSmokeTest(
  leaf: PlannedInterface,
  hostFile: FileNode,
  reason: string,
): string {
  // Test files live at tests/leaves/<slug>.test.ts. Their
  // imports use ../../<src-relative path> with .js extension.
  const relPath = `../../${stripExt(hostFile.path)}.js`;
  const lines: string[] = [];
  lines.push(`// Smoke test — leaf marked unwinnable for full unit test.`);
  lines.push(`// Reason: ${reason.replace(/\n/g, " ").slice(0, 200)}`);
  lines.push(`import { describe, it, expect } from "vitest";`);
  if (leaf.kind === "function") {
    lines.push(`import { ${leaf.name} } from ${JSON.stringify(relPath)};`);
    lines.push(``);
    lines.push(`describe(${JSON.stringify(leaf.name + " (smoke)")}, () => {`);
    lines.push(`  it("is callable", () => {`);
    lines.push(`    expect(typeof ${leaf.name}).toBe("function");`);
    lines.push(`  });`);
    lines.push(`});`);
  } else {
    // method: assert prototype carries the method.
    const cls = leaf.ownerClassName ?? "AnonClass";
    lines.push(`import { ${cls} } from ${JSON.stringify(relPath)};`);
    lines.push(``);
    lines.push(`describe(${JSON.stringify(`${cls}.${leaf.name} (smoke)`)}, () => {`);
    lines.push(`  it("exists on the prototype", () => {`);
    lines.push(`    expect(typeof (${cls}.prototype as Record<string, unknown>)[${JSON.stringify(leaf.name)}]).toBe("function");`);
    lines.push(`  });`);
    lines.push(`});`);
  }
  return lines.join("\n") + "\n";
}

/** Strip the file extension from a POSIX-style path. The dot
 *  must be in the BASENAME (after the last "/") — otherwise a
 *  path like ".gitkeep/host" or "foo.bar/baz" would be wrongly
 *  truncated at the directory dot. */
function stripExt(p: string): string {
  const slash = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  if (dot < 0 || dot < slash) return p;
  return p.slice(0, dot);
}

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

const SYSTEM_PROMPT = `You are an Implementor agent working on a TypeScript project. You have tools to explore the project, edit one specific file, type-check, and run tests. Your goal: make the active leaf's test pass.

Work the way a developer would: read what you don't know before changing it. When a test fails, look at the error, decide whether the body is wrong or whether you're missing context (an import, a type, a sibling helper), and act accordingly.

Tools:
  list_files                      List every file in the project. No args. Use first to see what exists.
  read_file(path)                 Read one file's current source. Use to inspect siblings before importing or referencing them.
  edit_file(path, old_str, new_str)
                                  String replacement on the active file. old_str must match exactly once. Use the file's CURRENT content (re-read after each edit). You can ONLY edit the active leaf's file; other files are read-only.
  typecheck                       Run tsc --noEmit on the project. Returns diagnostics scoped to the active file. Useful after a non-trivial edit before running tests.
  run_test                        Run the active leaf's test. Returns ok=true or the failing assertion.
  rewrite_test(new_source)        Replace the leaf's test source. Use when the existing test contract is unwinnable (e.g. browser-only code that needs jsdom, async WASM init, environment-dependent classes) — write a smoke test or restructure the assertions. Bounded by a small budget; the body still has to satisfy whatever the rewrite asserts.
  skip_with_smoke_test(reason)    Replace the leaf's test with a harness-generated trivial shape check (e.g. expect(typeof fn).toBe("function")). For leaves that genuinely have no meaningful unit test (Preact hooks, WASM init, env-dependent singletons). Consumes ONE rewrite_test budget slot. Provide a clear reason string; that goes into the test as a comment for traceability.
  edit_function_in_file(function_name, new_source)
                                  AST-aware: replace a top-level function. Stricter than edit_file but reliable for whole-function rewrites.
  edit_method_of_class_in_file(class_name, method_name, new_source)
                                  AST-aware: replace ONE method of a class. new_source must be a class block containing only the target method.
  edit_whole_class_in_file(class_name, new_source)
                                  AST-aware: replace an entire class.
  edit_imports_and_assignments_in_file(new_source)
                                  AST-aware: replace the file's imports + top-level assignments region.
  add_dependency(name, version, which)
                                  Install a runtime ("which":"runtime") or dev ("which":"dev") dependency. Use when run_test fails with "Cannot find module X" — pick a working binding. If a chosen binding doesn't compile (gyp / node-gyp errors), use remove_dependency + add_dependency to swap to an alternative.
  remove_dependency(name)
                                  Strip a package from package.json + re-install. Useful before swapping bindings.
  set_script(name, command)       Add or update an npm script. Cannot overwrite scripts.test with a non-vitest command.
  npm_run(script)                 Run an existing npm script (npm run <name>). Returns exit code + stdout/stderr. Use to verify a remediation worked before terminating.
  Terminate(reason)               End the session. Call when you believe the active leaf is done. The orchestrator will run the test once more to verify.

Pick exactly ONE tool per turn.`;

function buildUserPrompt(input: DevLoopInput): string {
  const lines: string[] = [];
  lines.push(`# Active leaf`);
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
  const testSrc = input.testsByLeafId.get(input.leaf.leafCapabilityId);
  if (testSrc) {
    lines.push("# Test that must pass");
    lines.push("");
    lines.push("```typescript");
    lines.push(testSrc);
    lines.push("```");
    lines.push("");
  }
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
      name: "edit_file",
      description:
        'Replace a single occurrence of old_str with new_str. Allowed paths: (1) the active leaf\'s host file (source code), (2) project infra files: package.json, tsconfig.json, vitest.config.{ts,mts,js}, .env. Use infra edits to fix test environment issues — e.g. set environment: "jsdom" in vitest.config.ts, add path aliases to tsconfig.json. old_str must match the file\'s CURRENT content exactly once.',
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path of the active leaf's file OR an infra file." },
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
      description: "Run tsc --noEmit. Returns diagnostics scoped to the active file.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run the active leaf's test. Returns ok or the failing assertion.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "rewrite_test",
      description:
        "Replace the active leaf's test source. Use when the existing test contract is unwinnable (browser-only code needing jsdom, async WASM init, env-dependent classes) — author a smoke test or restructure the assertions. Bounded by a small budget. The body still has to satisfy whatever the rewrite asserts.",
      parameters: {
        type: "object",
        properties: {
          new_source: {
            type: "string",
            description: "Full TypeScript source for the replacement test file.",
          },
        },
        required: ["new_source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skip_with_smoke_test",
      description:
        'Replace the leaf\'s test with a harness-generated shape check (e.g. expect(typeof fn).toBe("function")). For leaves that genuinely have no meaningful unit test (Preact hooks, WASM init, env-dependent singletons). Consumes ONE rewrite_test budget slot. Provide a clear reason string explaining why the leaf is untestable in isolation — gets logged in the smoke test as a comment.',
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why this leaf is genuinely untestable in isolation.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_function_in_file",
      description: "AST-aware: replace a top-level function. Output the FULL function definition.",
      parameters: {
        type: "object",
        properties: {
          function_name: { type: "string" },
          new_source: { type: "string" },
        },
        required: ["function_name", "new_source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_whole_class_in_file",
      description: "AST-aware: replace an entire class declaration.",
      parameters: {
        type: "object",
        properties: {
          class_name: { type: "string" },
          new_source: { type: "string" },
        },
        required: ["class_name", "new_source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_method_of_class_in_file",
      description:
        "AST-aware: replace ONE method on a class. new_source must be a class block containing ONLY the target method.",
      parameters: {
        type: "object",
        properties: {
          class_name: { type: "string" },
          method_name: { type: "string" },
          new_source: { type: "string" },
        },
        required: ["class_name", "method_name", "new_source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_imports_and_assignments_in_file",
      description: "AST-aware: replace the file's imports + top-level assignments region.",
      parameters: {
        type: "object",
        properties: { new_source: { type: "string" } },
        required: ["new_source"],
      },
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
      name: "set_script",
      description: "Add or update an npm script. Cannot overwrite scripts.test with a non-vitest command.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          command: { type: "string" },
        },
        required: ["name", "command"],
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
