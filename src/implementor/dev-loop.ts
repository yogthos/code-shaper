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
  type EditResult,
} from "./edit-tools.js";
import {
  listFilesTool,
  readFileTool,
  editFileTool,
  typecheckTool,
  runTestTool,
} from "./dev-loop-tools.js";
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
  /** Project directory for typecheck. When omitted, typecheck
   *  short-circuits to ran:false. */
  outDir?: string;
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
          ? { error: "agent terminated without producing a body for the active leaf" }
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
      const r = editFileTool({
        rpg: input.rpg,
        bodyByLeafId: input.bodyByLeafId,
        testsByLeafId: input.testsByLeafId,
        activeFilePath: input.hostFile.path,
        activeLeafId: input.leaf.leafCapabilityId,
        path: p,
        old_str: oldStr,
        new_str: newStr,
      });
      return {
        ok: r.ok,
        toolResult: r.ok ? { ok: true } : { error: r.error },
        ...(r.error ? { error: r.error } : {}),
        ...(r.ok ? { summary: `edit_file ${p} applied` } : {}),
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
    case "edit_function_in_file":
    case "edit_whole_class_in_file":
    case "edit_method_of_class_in_file":
    case "edit_imports_and_assignments_in_file": {
      return applySurgicalEdit(toolName, args, input);
    }
    default:
      return {
        ok: false,
        toolResult: {
          error: `unknown tool ${JSON.stringify(toolName)}. Valid: list_files, read_file, edit_file, typecheck, run_test, edit_function_in_file, edit_whole_class_in_file, edit_method_of_class_in_file, edit_imports_and_assignments_in_file, Terminate.`,
        },
        error: `unknown tool: ${toolName}`,
      };
  }
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
  edit_function_in_file(function_name, new_source)
                                  AST-aware: replace a top-level function. Stricter than edit_file but reliable for whole-function rewrites.
  edit_method_of_class_in_file(class_name, method_name, new_source)
                                  AST-aware: replace ONE method of a class. new_source must be a class block containing only the target method.
  edit_whole_class_in_file(class_name, new_source)
                                  AST-aware: replace an entire class.
  edit_imports_and_assignments_in_file(new_source)
                                  AST-aware: replace the file's imports + top-level assignments region.
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
      description: "Read the current rendered source of one file.",
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
        "Replace a single occurrence of old_str with new_str in the active file. old_str must match the file's CURRENT content exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path of the active leaf's file." },
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
