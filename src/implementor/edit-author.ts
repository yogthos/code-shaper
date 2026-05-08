/**
 * Tool-using edit author — RPG paper §D.2 wired through OpenAI's
 * function-tool API.
 *
 * The agent receives:
 *   - the current file source (rendered with stubs + prior bodies)
 *   - the leaf description (what to implement / fix)
 *   - the failing test source (when the call is a retry)
 *   - the failure message (when the call is a retry)
 *
 * It picks ONE of the four §D.2 edit tools, emits its args as a
 * structured tool call, and we apply the tool to the file source.
 * Returns the new file source on success, or an error describing
 * what went wrong (the LLM picked an unknown tool, the args didn't
 * parse, the underlying edit refused).
 *
 * Multi-turn (audit issue #4): on tree-sitter rejection, arg
 * validation failure, or disallowed-tool pick, the failure is
 * sent back as a `tool` message and the loop continues — the
 * model can self-correct within the same chat session instead of
 * losing the assistant's tool-call history to a fresh chat on the
 * next body-author attempt. Bounded by `maxIterations` (default 3).
 *
 * Multi-step COMPOSITION (e.g., add an import THEN edit a
 * function) is still not implemented: one successful tool call
 * ends the session. Multiple-edit attempts compose naturally with
 * the existing per-leaf retry loop.
 */

import {
  editFunctionInFile,
  editMethodOfClassInFile,
  editWholeClassInFile,
  editImportsAndAssignmentsInFile,
  type EditResult,
} from "./edit-tools.js";
import type { LLMClient, ChatOptions } from "../llm/types.js";

export interface EditAuthorInput {
  /** Current file source. The agent sees this verbatim and decides
   *  which scope to edit. */
  fileSource: string;
  /** Path of the file being edited; included in tool descriptions
   *  so the agent has the right mental model when it reads its
   *  own tool calls back. */
  filePath: string;
  /** Plain-language description of what should be implemented or
   *  fixed (the leaf's contract from the RPG). */
  taskDescription: string;
  /** Optional test source — the contract the agent's edit must
   *  satisfy. */
  testSource?: string;
  /** Optional failure feedback when this call is a retry. */
  failureMessage?: string;
  /** Constrain which tool(s) the agent may use. Default: all four
   *  §D.2 tools available. The leaf-level wiring will narrow this
   *  to the single tool that fits the leaf's kind (function vs
   *  method) so the agent doesn't accidentally restructure the
   *  surrounding class. */
  allowedTools?: ToolName[];
  /** Audit issue #4: the loop is multi-turn. On a tree-sitter or
   *  arg-validation rejection we send the failure back as a tool
   *  message and let the model retry within the same chat session.
   *  Default 3 — tight to keep the per-attempt cost bounded; the
   *  outer leaf retry loop still composes for harder failures. */
  maxIterations?: number;
  temperature?: number;
}

export type ToolName =
  | "edit_function_in_file"
  | "edit_whole_class_in_file"
  | "edit_method_of_class_in_file"
  | "edit_imports_and_assignments_in_file";

export interface EditAuthorResult {
  ok: boolean;
  /** New file source after the edit, on success. */
  source?: string;
  /** Which tool the agent picked (when known). The most recent
   *  tool, in the multi-turn case. */
  tool?: ToolName;
  /** Args the agent supplied to that tool. The most recent. */
  args?: Record<string, unknown>;
  /** On failure, the most recent rejection reason. On success,
   *  unset. */
  error?: string;
  /** Audit issue #4: how many turns the multi-turn loop ran. 1 =
   *  single-shot success or single-rejection bail-out (e.g., no
   *  tool call). Higher = the model self-corrected. */
  iterations?: number;
  /** Per-iteration outcome trail. Each entry records (tool, args,
   *  ok, error) so callers can render a useful summary into the
   *  next body-author retry prompt when the loop exhausted. */
  trail?: Array<EditAuthorTrailEntry>;
}

export interface EditAuthorTrailEntry {
  iteration: number;
  /** Set when the agent emitted a recognizable tool call. Unset
   *  when the agent returned prose or an unknown tool. */
  tool?: ToolName | string;
  args?: Record<string, unknown>;
  ok: boolean;
  /** Rejection reason. Set whenever ok is false. */
  error?: string;
}

/** Audit issue #7: per-tool description blocks. Composed
 *  dynamically by `buildSystemPrompt` so the model only reads
 *  about tools the caller actually allows. Previously the prompt
 *  enumerated all four — when leaf.ts narrowed `allowedTools` to
 *  one (e.g., `edit_method_of_class_in_file` for a method leaf),
 *  the model still saw the other descriptions and sometimes
 *  picked a blocked tool, burning an iteration on the rejection. */
const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  edit_function_in_file: `  edit_function_in_file
    Replace a top-level function. Output the FULL function definition (signature + body + any docstring), not just the body. Use when the target is a free-standing function.`,
  edit_whole_class_in_file: `  edit_whole_class_in_file
    Replace the entire class declaration. Output every method the class should expose. Use when most of the class needs rewriting.`,
  edit_method_of_class_in_file: `  edit_method_of_class_in_file
    Replace ONE method on a class. Output a class block containing ONLY the target method — no sibling methods, even if you need to reference them. The harness will splice your method back into the existing class body verbatim, so other methods are preserved automatically.`,
  edit_imports_and_assignments_in_file: `  edit_imports_and_assignments_in_file
    Replace the file's imports + top-level assignments. Output ONLY imports and top-level const/let/var statements — no functions or classes. Do not remove existing imports unless they are demonstrably wrong (typo, non-existent module).`,
};

function buildSystemPrompt(allowed: ToolName[]): string {
  const toolBlocks = allowed.map((t) => TOOL_DESCRIPTIONS[t]).join("\n\n");
  // Tailor the "Rules" preamble: the smallest-scope rule only
  // makes sense when more than one tool is on offer.
  const fallbackRule =
    allowed.length > 1
      ? `\n  - If you can't decide which tool to use, prefer edit_function_in_file or edit_method_of_class_in_file over edit_whole_class_in_file (smaller scope = lower risk).`
      : "";
  return `You are an Implementor agent applying surgical edits to a TypeScript source file using a small, scope-bounded set of tools (RPG paper §D.2).

For each task you receive:
  - The current file source (post-render, may contain throwing stubs for unimplemented members, real bodies for implemented members, or earlier failed attempts)
  - A natural-language description of what the agent must implement or fix
  - Optionally, the failing test source — your edit MUST make this test pass
  - Optionally, a failure message from the prior attempt

Pick exactly ONE tool that matches the scope of the change:

${toolBlocks}

Rules:
  - Output exactly ONE tool call. Pick the smallest-scope tool that lets you make the edit.
  - The new source you provide must declare the SAME named entity (function name, class name, method name) the harness asked you to edit.
  - For method edits, the class block you emit must contain ONLY the target method.
  - The new source must parse as TypeScript. Don't elide imports your code uses.${fallbackRule}

Return only the tool call. No prose.`;
}

const TOOL_DEFS = {
  edit_function_in_file: {
    type: "function" as const,
    function: {
      name: "edit_function_in_file",
      description:
        "Replace a top-level function declaration. The new_source argument must contain the full function definition (signature + body + docstring) and must declare a function with the given function_name.",
      parameters: {
        type: "object",
        properties: {
          function_name: {
            type: "string",
            description: "Name of the function to replace.",
          },
          new_source: {
            type: "string",
            description:
              "Full TypeScript source for the replacement function declaration.",
          },
        },
        required: ["function_name", "new_source"],
      },
    },
  },
  edit_whole_class_in_file: {
    type: "function" as const,
    function: {
      name: "edit_whole_class_in_file",
      description:
        "Replace an entire class declaration. The new_source argument must contain the full class definition with every method the class should expose.",
      parameters: {
        type: "object",
        properties: {
          class_name: {
            type: "string",
            description: "Name of the class to replace.",
          },
          new_source: {
            type: "string",
            description: "Full TypeScript source for the replacement class.",
          },
        },
        required: ["class_name", "new_source"],
      },
    },
  },
  edit_method_of_class_in_file: {
    type: "function" as const,
    function: {
      name: "edit_method_of_class_in_file",
      description:
        "Replace ONE method on a class. The new_source argument must be a class block (`class ClassName { … }`) containing ONLY the target method — sibling methods on the existing class are preserved automatically.",
      parameters: {
        type: "object",
        properties: {
          class_name: {
            type: "string",
            description: "Name of the class containing the method.",
          },
          method_name: {
            type: "string",
            description: "Name of the method to replace.",
          },
          new_source: {
            type: "string",
            description:
              "Class block containing only the target method, e.g. `class Foo { bar(): void { … } }`.",
          },
        },
        required: ["class_name", "method_name", "new_source"],
      },
    },
  },
  edit_imports_and_assignments_in_file: {
    type: "function" as const,
    function: {
      name: "edit_imports_and_assignments_in_file",
      description:
        "Replace the file's imports + top-level assignments. The new_source argument must contain ONLY import statements and top-level const/let/var declarations — no functions or classes.",
      parameters: {
        type: "object",
        properties: {
          new_source: {
            type: "string",
            description:
              "TypeScript source containing ONLY imports + top-level assignments.",
          },
        },
        required: ["new_source"],
      },
    },
  },
} as const;

/**
 * Multi-turn editing call (audit issue #4). The agent picks a
 * tool, emits args; we apply. On rejection (tree-sitter parse
 * error, name mismatch, disallowed tool, malformed JSON, missing
 * required arg) the rejection text is sent back as a `tool`
 * message and the loop continues — so the model can self-correct
 * within the same chat session instead of losing the assistant's
 * tool-call history to a fresh chat on the next body-author
 * attempt. Bounded by `maxIterations` (default 3).
 *
 * Returns the new file source on success, or the most recent
 * rejection reason + a trail of attempts on failure.
 */
export async function editLeafViaTools(
  client: LLMClient,
  input: EditAuthorInput,
): Promise<EditAuthorResult> {
  const allowed: ToolName[] =
    input.allowedTools ??
    ([
      "edit_function_in_file",
      "edit_method_of_class_in_file",
      "edit_imports_and_assignments_in_file",
      "edit_whole_class_in_file",
    ] as ToolName[]);
  const tools = allowed.map((name) => TOOL_DEFS[name]);
  const userPrompt = buildUserPrompt(input);
  const opts: ChatOptions = {
    tools,
    // `required` forces the agent to call SOME tool — without it,
    // models occasionally just write prose, which is useless to us.
    toolChoice: "required",
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
  };
  const maxIterations = Math.max(1, input.maxIterations ?? 3);
  const messages: Array<import("../llm/types.js").ChatMessage> = [
    { role: "system", content: buildSystemPrompt(allowed) },
    { role: "user", content: userPrompt },
  ];
  const trail: EditAuthorTrailEntry[] = [];
  let lastTool: ToolName | undefined;
  let lastArgs: Record<string, unknown> | undefined;
  let lastError: string | undefined;

  for (let i = 0; i < maxIterations; i++) {
    // Audit issue #1: wrap chat in try/catch so transient API
    // errors don't fatal the leaf loop.
    let response;
    try {
      response = await client.chat(messages, opts);
    } catch (e) {
      const err = `edit chat failed: ${e instanceof Error ? e.message : String(e)}`;
      trail.push({ iteration: i + 1, ok: false, error: err });
      return {
        ok: false,
        error: err,
        iterations: i + 1,
        trail,
        ...(lastTool ? { tool: lastTool } : {}),
        ...(lastArgs ? { args: lastArgs } : {}),
      };
    }
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      // No tool_calls IDs to ack, so we can't push a tool
      // message and retry — bail out with the rejection.
      const err =
        "agent did not emit a tool call (response was prose-only or empty)";
      trail.push({ iteration: i + 1, ok: false, error: err });
      return {
        ok: false,
        error: err,
        iterations: i + 1,
        trail,
        ...(lastTool ? { tool: lastTool } : {}),
        ...(lastArgs ? { args: lastArgs } : {}),
      };
    }
    // One tool call per turn — protocol-correct, and matches the
    // localize / env-fix loops. Multi-call turns are rejected
    // back to the model.
    if (toolCalls.length > 1) {
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
      lastError = "agent emitted multiple tool calls in one turn";
      trail.push({ iteration: i + 1, ok: false, error: lastError });
      continue;
    }
    const call = toolCalls[0]!;
    const toolNameRaw = call.function.name;
    const toolName = toolNameRaw as ToolName;

    // Helper: when an attempt fails, push assistant + tool error
    // messages and let the loop continue.
    const pushFailureToolMessage = (errText: string) => {
      messages.push({
        role: "assistant",
        content: response!.content ?? "",
        tool_calls: toolCalls,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ error: errText }),
      });
    };

    if (!isToolName(toolName) || !allowed.includes(toolName)) {
      const allowedList = allowed.join(", ");
      lastError = `agent picked unknown or disallowed tool "${toolNameRaw}". Allowed tools: ${allowedList}`;
      trail.push({
        iteration: i + 1,
        tool: toolNameRaw,
        ok: false,
        error: lastError,
      });
      pushFailureToolMessage(lastError);
      continue;
    }
    lastTool = toolName;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch (e) {
      lastError = `tool arguments did not parse as JSON: ${(e as Error).message}. Arguments must be a valid JSON object.`;
      trail.push({
        iteration: i + 1,
        tool: toolName,
        ok: false,
        error: lastError,
      });
      pushFailureToolMessage(lastError);
      continue;
    }
    lastArgs = args;
    const result = applyTool(input.fileSource, toolName, args);
    if (result.ok) {
      trail.push({ iteration: i + 1, tool: toolName, args, ok: true });
      return {
        ok: true,
        source: result.source!,
        tool: toolName,
        args,
        iterations: i + 1,
        trail,
      };
    }
    lastError = result.error ?? "tool returned no error";
    trail.push({
      iteration: i + 1,
      tool: toolName,
      args,
      ok: false,
      error: lastError,
    });
    pushFailureToolMessage(lastError);
  }

  // Budget exhausted without a successful edit.
  return {
    ok: false,
    error: lastError ?? `editLeafViaTools exhausted ${maxIterations} iterations`,
    iterations: maxIterations,
    trail,
    ...(lastTool ? { tool: lastTool } : {}),
    ...(lastArgs ? { args: lastArgs } : {}),
  };
}

// ── Internals ────────────────────────────────────────────────────────

function isToolName(s: string): s is ToolName {
  return (
    s === "edit_function_in_file" ||
    s === "edit_whole_class_in_file" ||
    s === "edit_method_of_class_in_file" ||
    s === "edit_imports_and_assignments_in_file"
  );
}

/** Audit issue #13: report the offending arg's name, type, and a
 *  bounded value snippet so the model can see what it actually
 *  sent. Generic "must be strings" messages give the model no way
 *  to identify which arg was wrong; it tends to repeat the same
 *  mistake on retry. */
function describeOffendingArg(name: string, value: unknown): string {
  if (value === undefined) return `${name}: missing (must be a string)`;
  if (value === null) return `${name}: must be a string, got null`;
  const t = typeof value;
  if (t === "string") return ""; // not offending
  let snippet: string;
  try {
    const j = JSON.stringify(value);
    snippet = j.length > 120 ? j.slice(0, 120) + "…" : j;
  } catch {
    snippet = String(value).slice(0, 120);
  }
  return `${name}: must be a string, got ${t} ${snippet}`;
}

/** Build a validation error from the args; returns null when
 *  every required arg passes. */
function validateStringArgs(
  toolPrefix: string,
  args: Record<string, unknown>,
  required: string[],
): string | null {
  const problems = required
    .map((k) => describeOffendingArg(k, args[k]))
    .filter((s) => s.length > 0);
  if (problems.length === 0) return null;
  return `${toolPrefix}: ${problems.join("; ")}`;
}

function applyTool(
  fileSource: string,
  tool: ToolName,
  args: Record<string, unknown>,
): EditResult {
  switch (tool) {
    case "edit_function_in_file": {
      const err = validateStringArgs("edit_function_in_file", args, [
        "function_name",
        "new_source",
      ]);
      if (err) return { ok: false, error: err };
      return editFunctionInFile(
        fileSource,
        args["function_name"] as string,
        args["new_source"] as string,
      );
    }
    case "edit_whole_class_in_file": {
      const err = validateStringArgs("edit_whole_class_in_file", args, [
        "class_name",
        "new_source",
      ]);
      if (err) return { ok: false, error: err };
      return editWholeClassInFile(
        fileSource,
        args["class_name"] as string,
        args["new_source"] as string,
      );
    }
    case "edit_method_of_class_in_file": {
      const err = validateStringArgs("edit_method_of_class_in_file", args, [
        "class_name",
        "method_name",
        "new_source",
      ]);
      if (err) return { ok: false, error: err };
      return editMethodOfClassInFile(
        fileSource,
        args["class_name"] as string,
        args["method_name"] as string,
        args["new_source"] as string,
      );
    }
    case "edit_imports_and_assignments_in_file": {
      const err = validateStringArgs(
        "edit_imports_and_assignments_in_file",
        args,
        ["new_source"],
      );
      if (err) return { ok: false, error: err };
      return editImportsAndAssignmentsInFile(
        fileSource,
        args["new_source"] as string,
      );
    }
  }
}

function buildUserPrompt(input: EditAuthorInput): string {
  const lines: string[] = [];
  lines.push(`# File: ${input.filePath}`);
  lines.push("");
  lines.push("```typescript");
  lines.push(input.fileSource);
  lines.push("```");
  lines.push("");
  lines.push("# Task");
  lines.push("");
  lines.push(input.taskDescription.trim());
  lines.push("");
  if (input.testSource) {
    lines.push("# Test that must pass");
    lines.push("");
    lines.push("```typescript");
    lines.push(input.testSource);
    lines.push("```");
    lines.push("");
  }
  if (input.failureMessage) {
    const trimmed =
      input.failureMessage.length > 4000
        ? input.failureMessage.slice(0, 4000) + "\n... [truncated]"
        : input.failureMessage;
    lines.push("# Previous failure");
    lines.push("");
    lines.push("```");
    lines.push(trimmed);
    lines.push("```");
    lines.push("");
  }
  lines.push(
    "Pick one §D.2 tool and emit the structured tool call. Do not include prose.",
  );
  return lines.join("\n");
}
