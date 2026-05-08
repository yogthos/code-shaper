/**
 * §D.1 localization agent — multi-step tool-using loop.
 *
 * The agent receives a natural-language task ("find the leaf
 * causing this branch test failure", "where should this new
 * feature live?") plus the RPG. It iteratively calls the four
 * data-tools (view_file_interface_feature_map, get_interface_content,
 * expand_leaf_node_info, search_interface_by_functionality) to
 * navigate the graph, then terminates with a structured ranked list
 * of the interfaces that should be edited.
 *
 * Budget: §5.3 specifies "20 localization attempts" per failing
 * function. We honor that as the default `maxIterations`.
 *
 * The loop maintains a single chat conversation across iterations:
 * each tool call is appended as a tool-call assistant message + a
 * tool-result message the next round sees as context. The model
 * accumulates state in its own context window; the loop just routes
 * data between the model and the tool implementations.
 */

import {
  expandLeafNodeInfo,
  getInterfaceContent,
  searchInterfaceByFunctionality,
  viewFileInterfaceFeatureMap,
  type FileInterfaceMap,
  type FunctionalitySearchResult,
  type InterfaceContent,
  type LeafNodeExpansion,
} from "./localization-tools.js";
import type {
  ChatMessage,
  ChatOptions,
  LLMClient,
  LLMResponse,
} from "../llm/types.js";
import { isFile, isFolder, type RPG } from "../rpg/types.js";

export interface LocalizationInput {
  rpg: RPG;
  /** Natural-language task description. Examples: "fix the failing
   *  branch test that says expected 5 got 4 in TodoStore.add",
   *  "where should I add a 'undo' feature?". */
  task: string;
  /** Optional initial hint surfaced in the user prompt — e.g.
   *  "the test mentions TodoStore.getAll" or "the failure happened
   *  in src/store.ts". The agent isn't bound by it. */
  hint?: string;
  /** Per-failure attempt budget; default 20 per RPG §5.3. */
  maxIterations?: number;
  temperature?: number;
}

export interface LocatedInterface {
  filePath: string;
  /** "function: foo" / "class: Foo" / "method: Foo.bar" — the §D.1
   *  Terminate format. */
  interface: string;
}

export interface LocalizationResult {
  ok: boolean;
  /** Final ranked list emitted by Terminate. */
  result: LocatedInterface[];
  /** Per-iteration trace (tool name + args summary + truncated
   *  output) for observability. Useful when something fishy went
   *  wrong and we need to replay. */
  trail: Array<{
    iteration: number;
    tool: string;
    /** Arguments the agent supplied. May be a parsed object or the
     *  raw JSON string when parsing failed. */
    args: unknown;
    /** Output sent back to the model. Truncated to keep the trail
     *  small; full data is reconstructable from the args + RPG. */
    output: unknown;
  }>;
  iterations: number;
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 20;
/** Per-tool-result truncation cap. Without this, a single
 *  `get_interface_content` returning a 50 KB file body lands in
 *  the conversation verbatim — and stays there for every
 *  subsequent iteration. Review fix #3. */
const TOOL_RESULT_MAX_BYTES = 4_000;
/** Max files + folders rendered in the initial repo skeleton.
 *  Review fix #4. Beyond this, the skeleton is truncated and the
 *  agent is told to use search_interface_by_functionality. */
const REPO_SKELETON_MAX_ENTRIES = 200;

const SYSTEM_PROMPT = `You are a Localization agent in the RPG-guided code-generation pipeline (§D.1).

Your job is to map a natural-language task onto specific interfaces in the repository — functions, classes, or methods — by navigating the Repository Planning Graph (RPG) using a small toolset.

Available tools:

  view_file_interface_feature_map(file_path)
    Lists every function/class/method in a file, with the design-level feature tags they support. Use to inspect what's in a file.

  get_interface_content(spec)
    Returns the source code of a single function, class, or method. \`spec\` is "<file_path>:<entity>" — entity is "name" for free-standing functions and classes, "Class.method" for methods. Use after you've located a candidate and want to read its implementation.

  expand_leaf_node_info(feature_path)
    Slash-separated capability path → list of interfaces under it. Use when the task is described in capability/feature language.

  search_interface_by_functionality(keywords)
    Fuzzy search across all interfaces by keyword overlap. Returns up to 5 candidates. Use when you don't know where to start.

  Terminate(result)
    Final tool. Pass the ranked list of located interfaces. The schema is:
      [{ "file_path": "src/foo.ts", "interface": "method: Foo.bar" },
       { "file_path": "src/baz.ts", "interface": "function: baz" },
       …]
    Each interface string starts with one of "function:", "class:", "method:" followed by the entity name (or "Class.method" for methods). Order by confidence — most-likely-relevant first.

Strategy:
  - Begin with the broadest tool that matches the task. If you have a precise file path, use view_file_interface_feature_map. If you have keywords, use search_interface_by_functionality.
  - Read implementations with get_interface_content only when the structural metadata isn't enough.
  - Don't call the same tool with the same arguments twice.
  - Terminate as soon as you have a confident ranked list — usually 1 to 5 entries. Don't over-explore.

Output exactly one tool call per turn. The harness will run the tool and feed the result back as a tool message; you continue from there.`;

const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "view_file_interface_feature_map",
      description:
        "Inspect a single file: list its functions/classes/methods with feature tags.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Repo-relative file path." },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_interface_content",
      description:
        "Retrieve source code for one entity. spec format: \"<file_path>:<entity>\" where entity is a name or Class.method.",
      parameters: {
        type: "object",
        properties: {
          spec: {
            type: "string",
            description: 'Fully qualified spec, e.g. "src/foo.ts:Bar.baz".',
          },
        },
        required: ["spec"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "expand_leaf_node_info",
      description:
        "Expand a slash-separated capability path into the interfaces mapped under it.",
      parameters: {
        type: "object",
        properties: {
          feature_path: {
            type: "string",
            description:
              'Slash-separated path, e.g. "TodoStore/Mutations/addTodo".',
          },
        },
        required: ["feature_path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_interface_by_functionality",
      description:
        "Fuzzy keyword search across all interfaces. Returns up to top-5 candidates.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Keywords to search for.",
          },
        },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Terminate",
      description:
        "End the localization. Pass the ranked list of located interfaces.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file_path: { type: "string" },
                interface: {
                  type: "string",
                  description:
                    'Format: "function: foo" / "class: Bar" / "method: Bar.baz".',
                },
              },
              required: ["file_path", "interface"],
            },
            description:
              "Ranked list, most-likely-relevant first. Usually 1-5 entries.",
          },
        },
        required: ["result"],
      },
    },
  },
];

export async function localize(
  client: LLMClient,
  input: LocalizationInput,
): Promise<LocalizationResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildInitialUserPrompt(input) },
  ];
  const trail: LocalizationResult["trail"] = [];

  for (let i = 0; i < maxIterations; i++) {
    const opts: ChatOptions = {
      tools: TOOL_DEFS,
      toolChoice: "required",
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
    };
    let response: LLMResponse;
    try {
      response = await client.chat(messages, opts);
    } catch (e) {
      return {
        ok: false,
        result: [],
        trail,
        iterations: i,
        error: `localization chat failed at iteration ${i + 1}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return {
        ok: false,
        result: [],
        trail,
        iterations: i + 1,
        error: "agent did not emit a tool call (must Terminate or use a data tool)",
      };
    }
    // Review fix #6: §D.1 specifies one-call-per-turn. The previous
    // implementation processed all calls but counted the whole
    // batch as one iteration — a model emitting 5 calls/turn got
    // effectively 100 invocations against a 20-budget. Worse, if
    // Terminate appeared mid-batch alongside other calls, the
    // earlier calls' tool_call_ids were left unanswered (causing
    // OpenAI-protocol errors on a retry). Enforce the contract:
    // exactly one tool call per turn.
    if (toolCalls.length > 1) {
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      // Answer EVERY tool_call_id (protocol requirement) with the
      // same error so the model is told to retry with one call.
      for (const call of toolCalls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error:
              "Emit exactly ONE tool call per turn. The harness processes one call at a time and feeds the result back to you for the next decision.",
          }),
        });
      }
      trail.push({
        iteration: i + 1,
        tool: "[multi-call rejected]",
        args: toolCalls.map((c) => c.function.name),
        output: "rejected: one call per turn",
      });
      continue;
    }
    // Append the assistant turn so the model sees its own state on
    // the next round. The OpenAI tool-message protocol requires
    // the assistant tool-call message to precede tool-result messages.
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: toolCalls,
    });
    // Single call (post-validation).
    for (const call of toolCalls) {
      const toolName = call.function.name;
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(call.function.arguments);
      } catch {
        // Send a tool error back so the model can retry. Do NOT
        // bail — JSON parse errors are recoverable.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error: `arguments did not parse as JSON: ${call.function.arguments.slice(0, 200)}`,
          }),
        });
        trail.push({
          iteration: i + 1,
          tool: toolName,
          args: call.function.arguments,
          output: "[parse error]",
        });
        continue;
      }
      if (toolName === "Terminate") {
        const result = validateTerminateResult(parsedArgs);
        if (!result.ok) {
          // Surface the schema error and let the model retry.
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: result.error }),
          });
          trail.push({
            iteration: i + 1,
            tool: "Terminate",
            args: parsedArgs,
            output: { error: result.error },
          });
          continue;
        }
        trail.push({
          iteration: i + 1,
          tool: "Terminate",
          args: parsedArgs,
          output: result.list,
        });
        return {
          ok: true,
          result: result.list,
          trail,
          iterations: i + 1,
        };
      }
      const dataResult = runDataTool(input.rpg, toolName, parsedArgs);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: capToolResult(
          JSON.stringify(dataResult.payload ?? { error: dataResult.error }),
        ),
      });
      trail.push({
        iteration: i + 1,
        tool: toolName,
        args: parsedArgs,
        output: summarizeForTrail(dataResult.payload ?? dataResult.error),
      });
    }
  }
  return {
    ok: false,
    result: [],
    trail,
    iterations: maxIterations,
    error: `localization exhausted ${maxIterations} iterations without Terminate`,
  };
}

// ── Internals ────────────────────────────────────────────────────────

function buildInitialUserPrompt(input: LocalizationInput): string {
  const lines: string[] = [];
  lines.push("# Task");
  lines.push("");
  lines.push(input.task.trim());
  lines.push("");
  if (input.hint) {
    lines.push("# Hint");
    lines.push("");
    lines.push(input.hint.trim());
    lines.push("");
  }
  lines.push("# Repository structure");
  lines.push("");
  lines.push(renderRepoSkeleton(input.rpg));
  lines.push("");
  lines.push(
    "Use the tools to navigate. Terminate as soon as you have a confident ranked list.",
  );
  return lines.join("\n");
}

/**
 * Compact list of files and folders in the RPG. Capped at
 * REPO_SKELETON_MAX_ENTRIES (review fix #4) — beyond that we tell
 * the agent to use search_interface_by_functionality. Without the
 * cap, a 1000-file repo dumped tens of KB into the prompt before
 * the agent even started navigating.
 */
function renderRepoSkeleton(rpg: RPG): string {
  const folders: string[] = [];
  const files: string[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFolder(node) && node.path) folders.push(`${node.path}/`);
    else if (isFile(node)) files.push(node.path);
  }
  folders.sort();
  files.sort();
  const total = folders.length + files.length;

  // Audit issue #14: when total > REPO_SKELETON_MAX_ENTRIES, the
  // previous code listed folders FIRST and consumed budget
  // greedily. On a repo with ~250 folders and ~100 files the
  // model saw 200 folders and zero files — it couldn't pick
  // view_file_interface_feature_map because no file paths were
  // visible. Reserve at least half the budget for files so the
  // model sees a usable mix.
  const fileBudget =
    total <= REPO_SKELETON_MAX_ENTRIES
      ? files.length
      : Math.min(files.length, Math.ceil(REPO_SKELETON_MAX_ENTRIES / 2));
  const folderBudget = REPO_SKELETON_MAX_ENTRIES - fileBudget;

  const lines: string[] = [];
  if (folders.length > 0) {
    lines.push("Folders:");
    const shown = folders.slice(0, folderBudget);
    for (const f of shown) lines.push(`  ${f}`);
  }
  if (files.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Files:");
    const shown = files.slice(0, fileBudget);
    for (const f of shown) lines.push(`  ${f}`);
  }
  if (total > REPO_SKELETON_MAX_ENTRIES) {
    lines.push("");
    lines.push(
      `… (${total - REPO_SKELETON_MAX_ENTRIES} more entries truncated; use search_interface_by_functionality to find what you need)`,
    );
  }
  return lines.length === 0 ? "(empty repo)" : lines.join("\n");
}

/**
 * Truncate a tool-result JSON string to TOOL_RESULT_MAX_BYTES
 * before it lands in the conversation. Review fix #3: at 20
 * iterations a single big file fetched twice would otherwise
 * accumulate in the conversation indefinitely. We trim past the
 * cap and append an explicit "truncated" marker so the model
 * knows it's seeing a partial view and can re-query if needed.
 */
function capToolResult(json: string): string {
  if (json.length <= TOOL_RESULT_MAX_BYTES) return json;
  return (
    json.slice(0, TOOL_RESULT_MAX_BYTES) +
    `… [truncated: ${json.length - TOOL_RESULT_MAX_BYTES} more bytes; re-query with narrower args if you need detail]`
  );
}

interface DataToolPayload {
  payload?:
    | FileInterfaceMap
    | InterfaceContent
    | LeafNodeExpansion
    | FunctionalitySearchResult
    | { error: string };
  error?: string;
}

function runDataTool(
  rpg: RPG,
  name: string,
  args: unknown,
): DataToolPayload {
  if (typeof args !== "object" || args === null) {
    return { error: `${name}: arguments must be an object` };
  }
  const a = args as Record<string, unknown>;
  if (name === "view_file_interface_feature_map") {
    const fp = a["file_path"];
    if (typeof fp !== "string") {
      return { error: "file_path must be a string" };
    }
    const map = viewFileInterfaceFeatureMap(rpg, fp);
    return { payload: map ?? { error: `file "${fp}" not in RPG` } };
  }
  if (name === "get_interface_content") {
    const spec = a["spec"];
    if (typeof spec !== "string") {
      return { error: "spec must be a string" };
    }
    return { payload: getInterfaceContent(rpg, spec) };
  }
  if (name === "expand_leaf_node_info") {
    const fp = a["feature_path"];
    if (typeof fp !== "string") {
      return { error: "feature_path must be a string" };
    }
    return { payload: expandLeafNodeInfo(rpg, fp) };
  }
  if (name === "search_interface_by_functionality") {
    const kw = a["keywords"];
    if (!Array.isArray(kw) || !kw.every((s) => typeof s === "string")) {
      return { error: "keywords must be an array of strings" };
    }
    return { payload: searchInterfaceByFunctionality(rpg, kw as string[]) };
  }
  return { error: `unknown tool "${name}"` };
}

function validateTerminateResult(
  args: unknown,
):
  | { ok: true; list: LocatedInterface[] }
  | { ok: false; error: string } {
  if (typeof args !== "object" || args === null) {
    return { ok: false, error: "Terminate expects an object with a `result` field" };
  }
  const list = (args as Record<string, unknown>)["result"];
  if (!Array.isArray(list)) {
    return { ok: false, error: "Terminate.result must be an array" };
  }
  const out: LocatedInterface[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (typeof item !== "object" || item === null) {
      return {
        ok: false,
        error: `Terminate.result[${i}] is not an object`,
      };
    }
    const fp = (item as Record<string, unknown>)["file_path"];
    const iface = (item as Record<string, unknown>)["interface"];
    if (typeof fp !== "string" || typeof iface !== "string") {
      // Audit issue #12: include the offending entry so the model
      // can see exactly what it sent (typo'd field name, wrong
      // type, etc.) and correct.
      let dump: string;
      try {
        const j = JSON.stringify(item);
        dump = j.length > 200 ? j.slice(0, 200) + "…" : j;
      } catch {
        dump = String(item);
      }
      return {
        ok: false,
        error: `Terminate.result[${i}] requires file_path:string + interface:string. Got: ${dump}`,
      };
    }
    // Strict format: "function: name" / "class: Name" / "method: Class.method"
    // — exact prefix + space + non-empty entity. Review fix #1: the
    // previous startsWith check accepted "functionality:" /
    // "classification:" etc., which the harness then can't act on.
    if (!/^(function|class|method):\s+\S/.test(iface)) {
      // Audit issue #8: surface a positive example alongside the
      // regex so the model can correlate. Models tend to re-emit
      // the same near-miss when shown only the regex.
      return {
        ok: false,
        error: `Terminate.result[${i}].interface must match /^(function|class|method):\\s+\\S/ (got "${iface}"). Examples: "function: handleClick", "class: UserService", "method: UserService.findById".`,
      };
    }
    out.push({ filePath: fp, interface: iface });
  }
  return { ok: true, list: out };
}

/**
 * Trim tool output for the trail so we don't carry full file
 * contents in the result. The model still sees the full output via
 * the tool message; this is purely for the operator-facing trail.
 */
function summarizeForTrail(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["source"] === "string" && (obj["source"] as string).length > 200) {
    return { ...obj, source: (obj["source"] as string).slice(0, 200) + "…" };
  }
  return obj;
}
