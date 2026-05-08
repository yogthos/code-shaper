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
 * Multi-step editing (the agent making several tool calls in one
 * attempt — e.g., add an import THEN edit a function) is not
 * implemented in this first pass: we do one tool call per author
 * attempt. Multiple-edit attempts compose naturally with the
 * existing per-leaf retry loop.
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
  /** Which tool the agent picked (when known). */
  tool?: ToolName;
  /** Args the agent supplied to that tool. */
  args?: Record<string, unknown>;
  error?: string;
}

const SYSTEM_PROMPT = `You are an Implementor agent applying surgical edits to a TypeScript source file using a small, scope-bounded set of tools (RPG paper §D.2).

For each task you receive:
  - The current file source (post-render, may contain throwing stubs for unimplemented members, real bodies for implemented members, or earlier failed attempts)
  - A natural-language description of what the agent must implement or fix
  - Optionally, the failing test source — your edit MUST make this test pass
  - Optionally, a failure message from the prior attempt

Pick exactly ONE tool that matches the scope of the change:

  edit_function_in_file
    Replace a top-level function. Output the FULL function definition (signature + body + any docstring), not just the body. Use when the target is a free-standing function.

  edit_whole_class_in_file
    Replace the entire class declaration. Output every method the class should expose. Use when most of the class needs rewriting.

  edit_method_of_class_in_file
    Replace ONE method on a class. Output a class block containing ONLY the target method — no sibling methods, even if you need to reference them. The harness will splice your method back into the existing class body verbatim, so other methods are preserved automatically.

  edit_imports_and_assignments_in_file
    Replace the file's imports + top-level assignments. Output ONLY imports and top-level const/let/var statements — no functions or classes. Do not remove existing imports unless they are demonstrably wrong (typo, non-existent module).

Rules:
  - Output exactly ONE tool call. Pick the smallest-scope tool that lets you make the edit.
  - The new source you provide must declare the SAME named entity (function name, class name, method name) the harness asked you to edit.
  - For method edits, the class block you emit must contain ONLY the target method.
  - The new source must parse as TypeScript. Don't elide imports your code uses.
  - If you can't decide which tool to use, prefer edit_function_in_file or edit_method_of_class_in_file over edit_whole_class_in_file (smaller scope = lower risk).

Return only the tool call. No prose.`;

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
 * Make one editing call. The agent picks a tool, emits args, we
 * apply. Returns the new file source on success.
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
  // Audit issue #1: localize and applyEnvFixViaTools both wrap
  // their chat() call in try/catch — a transient 5xx or socket
  // error must not kill the entire leaf loop. Mirror that here so
  // the caller falls through to retry on the next attempt.
  let response;
  try {
    response = await client.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      opts,
    );
  } catch (e) {
    return {
      ok: false,
      error: `edit chat failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const toolCalls = response.toolCalls ?? [];
  if (toolCalls.length === 0) {
    return {
      ok: false,
      error:
        "agent did not emit a tool call (response was prose-only or empty)",
    };
  }
  // Use only the FIRST tool call. Multi-tool composition would
  // require sending each result back as a tool message and
  // continuing the loop; not in this first pass.
  const call = toolCalls[0]!;
  const toolName = call.function.name as ToolName;
  if (!isToolName(toolName) || !allowed.includes(toolName)) {
    return {
      ok: false,
      error: `agent picked unknown or disallowed tool "${call.function.name}"`,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      tool: toolName,
      error: `tool arguments did not parse as JSON: ${(e as Error).message}`,
    };
  }
  const result = applyTool(input.fileSource, toolName, args);
  return {
    ok: result.ok,
    ...(result.ok ? { source: result.source! } : {}),
    tool: toolName,
    args,
    ...(result.ok ? {} : { error: result.error ?? "tool returned no error" }),
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

function applyTool(
  fileSource: string,
  tool: ToolName,
  args: Record<string, unknown>,
): EditResult {
  switch (tool) {
    case "edit_function_in_file": {
      const name = args["function_name"];
      const src = args["new_source"];
      if (typeof name !== "string" || typeof src !== "string") {
        return {
          ok: false,
          error:
            "edit_function_in_file: function_name and new_source must be strings",
        };
      }
      return editFunctionInFile(fileSource, name, src);
    }
    case "edit_whole_class_in_file": {
      const name = args["class_name"];
      const src = args["new_source"];
      if (typeof name !== "string" || typeof src !== "string") {
        return {
          ok: false,
          error:
            "edit_whole_class_in_file: class_name and new_source must be strings",
        };
      }
      return editWholeClassInFile(fileSource, name, src);
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
          error:
            "edit_method_of_class_in_file: class_name, method_name, new_source must be strings",
        };
      }
      return editMethodOfClassInFile(fileSource, className, methodName, src);
    }
    case "edit_imports_and_assignments_in_file": {
      const src = args["new_source"];
      if (typeof src !== "string") {
        return {
          ok: false,
          error:
            "edit_imports_and_assignments_in_file: new_source must be a string",
        };
      }
      return editImportsAndAssignmentsInFile(fileSource, src);
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
