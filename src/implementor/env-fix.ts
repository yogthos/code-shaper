/**
 * Stage C of feature #5 — env-fix author (multi-turn).
 *
 * Fires when `diagnoseFailure` returns category=`environment`. The
 * model gets the failure context and a tool surface (the four
 * npm-mutation primitives + Terminate). It can call tools in
 * sequence — `add_dependency` THEN `npm_run` to verify, etc. —
 * until it terminates explicitly or the iteration budget runs out.
 *
 * Audit gap #4: previously single-shot. Tool-arg validation errors
 * (bad JSON, lifecycle-hook script names, path-traversing package
 * names) returned an EnvFixResult with `ok: false` and the model
 * never got a chance to retry. Now a tool refusal is sent back as
 * a tool-error message and the next iteration lets the model
 * correct itself.
 *
 * Audit gap #16: previously `npm_run` captured stdout/stderr but
 * the model never saw them. Now each tool result (including
 * `npm_run`'s exit code + truncated stdout/stderr tail) lands in
 * the conversation as a tool message, so the model can decide
 * what to do next based on actual evidence.
 *
 * Mirrors the multi-turn pattern of `localize` (src/architect/
 * localization.ts): toolChoice "required" forces the model to
 * either pick a tool or call Terminate; one-call-per-turn enforced;
 * budget exhausts → return with a graceful error.
 */

import {
  addDependency,
  removeDependency,
  setScript,
  npmRun,
  type NpmOpResult,
} from "../architect/npm-tools.js";
import type {
  ChatMessage,
  ChatOptions,
  LLMClient,
  LLMResponse,
} from "../llm/types.js";

export interface EnvFixInput {
  /** Project directory (outDir) — where package.json + node_modules
   *  live. */
  projectDir: string;
  /** Plain-language hint from the diagnostic agent describing what
   *  env condition needs fixing (e.g., "the test imports zod but
   *  it isn't in package.json"). */
  envPatchHint: string;
  /** Failure output that triggered the diagnostic. */
  failureMessage: string;
  /** The current body source under test. */
  bodySource: string;
  /** The test source whose run failed. */
  testSource: string;
  /** Per-call iteration budget. Default 5 — the paper's §5.3 spec
   *  ("20 remediation attempts for test or environment errors") is
   *  per-leaf, not per env-fix-session. We aggregate over multiple
   *  env-fix sessions; each session is bounded smaller so a
   *  single round doesn't burn the whole budget. */
  maxIterations?: number;
  /** Override the npm binary (tests). Defaults to "npm". */
  npmBinary?: string;
  /** Skip actual npm install — useful in tests where mocking the
   *  registry isn't worth the effort. The package.json mutation
   *  still happens. */
  skipNpmInstall?: boolean;
  temperature?: number;
}

export type EnvToolName =
  | "add_dependency"
  | "remove_dependency"
  | "set_script"
  | "npm_run"
  | "Terminate";

export interface EnvFixTrailEntry {
  iteration: number;
  /** Audit issue #5: the actual tool name the model emitted, OR
   *  the synthetic tag `_invalid` when the call was rejected
   *  pre-apply (multi-call turn, unknown tool, JSON parse).
   *  Previously these rejections were recorded as
   *  `tool: "Terminate"` which misled summarizeEnvFix into
   *  rendering them as a clean termination. */
  tool: EnvToolName | "_invalid";
  /** Args the model supplied. May be empty for Terminate. */
  args: Record<string, unknown>;
  /** Underlying npm-tool result, when applicable. */
  npmResult?: NpmOpResult & { exitCode?: number | null };
  /** Tool-validation or apply error, when the call didn't reach
   *  the underlying primitive cleanly. */
  error?: string;
}

export interface EnvFixResult {
  /** True iff at least ONE tool call landed a real disk mutation
   *  (installRan or set_script). The leaf retry loop uses this to
   *  decide whether to re-run the test. */
  ok: boolean;
  /** Per-iteration trace. Always non-empty when `iterations > 0`. */
  trail: EnvFixTrailEntry[];
  iterations: number;
  /** Whether the agent called Terminate explicitly. */
  terminatedExplicitly: boolean;
  /** Convenience: most recent (tool, args, npmResult) — what
   *  callers most often want to summarize. */
  lastTool?: EnvToolName;
  lastArgs?: Record<string, unknown>;
  lastNpmResult?: NpmOpResult & { exitCode?: number | null };
  /** Top-level error when the loop exited badly (budget exhausted,
   *  client threw, etc.). NOT set when individual tool calls
   *  failed but the agent recovered. */
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 5;
/** How much of each tool result's stdout/stderr we send back to
 *  the model as a tool message. Tail-truncated. */
const TOOL_RESULT_OUTPUT_CAP = 2000;

const SYSTEM_PROMPT = `You are an Implementor agent applying environment-level fixes to a TypeScript project. A failing test was diagnosed as an ENVIRONMENT issue (missing dependency, wrong script, version mismatch, etc.) — NOT an implementation bug — by a 5-round majority-vote LLM judge.

Your job is to fix the project's environment so the SAME body and SAME test will produce a passing run. You operate in a multi-turn loop: each turn pick exactly ONE tool. Tools available:

  add_dependency
    Add a runtime or dev dependency to package.json + run npm install. Use when the test imports a module that isn't declared.

  remove_dependency
    Strip a package from both buckets + run npm install. Use when a dep is causing a version conflict and the project doesn't actually need it. Useful AFTER a failed install: try a different binding instead.

  set_script
    Add or change an npm script. The harness REFUSES edits that overwrite scripts.test with anything not invoking vitest, and rejects npm lifecycle hook names (preinstall/postinstall/prepare/...).

  npm_run
    Run an existing script (e.g., npm run build, npm run typecheck) to validate the fix. Output (stdout, stderr, exit code) comes back to you on the next turn so you can verify your remediation worked.

  Terminate
    End the env-fix session. Call this when you believe the environment is fixed and the leaf's test should be re-run. Pass an empty args object or a short reason.

Decision principles:
  - Be CONSERVATIVE. The diagnostic vouches that the BODY is plausibly correct; don't restructure the project.
  - When add_dependency fails (install error in stderr), READ THE STDERR. If the dep doesn't compile (V8 API change, gyp failure, etc.), don't keep retrying the same dep — remove it and pick a different binding.
  - For sqlite specifically: better-sqlite3 requires a native build that breaks on newer node V8 sometimes. Alternatives: the built-in node:sqlite module (node 22+), libsql (pure JS), or sqlite3 (pre-built binaries).
  - When add_dependency succeeds (installRan: true, exitCode: 0), call Terminate next — there's no point doing more.
  - When the hint mentions a specific package name AND that package is reasonable, use it. When the hint is vague, propose what fits the failure.

Output exactly ONE tool call per turn. Don't write prose.`;

const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "add_dependency",
      description:
        "Add a package to package.json (dependencies if which=runtime, devDependencies if which=dev) and re-run npm install. Returns ok / installRan / installOk / exitCode / stdout / stderr.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "npm package name." },
          version: {
            type: "string",
            description: 'Version specifier, e.g., "^3.22.0".',
          },
          which: {
            type: "string",
            enum: ["runtime", "dev"],
            description: "Dependency bucket.",
          },
        },
        required: ["name", "version", "which"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_dependency",
      description:
        "Strip a package from both runtime and dev buckets and re-run npm install. Use to swap bindings — remove a broken one before adding the alternative.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "npm package name." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_script",
      description:
        "Set an npm script. Refuses overwriting scripts.test with anything that doesn't invoke vitest, and rejects npm lifecycle hook names (preinstall, postinstall, prepare, etc.).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Script name." },
          command: {
            type: "string",
            description: "Command line to run for this script.",
          },
        },
        required: ["name", "command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "npm_run",
      description:
        "Run an existing npm script and report exit code, stdout, stderr. Use to verify a remediation worked before terminating.",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "Script name (must exist in package.json).",
          },
        },
        required: ["script"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Terminate",
      description:
        "End the env-fix session. Call when you believe the environment is fixed (or no further action makes sense).",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Brief note on why you're terminating.",
          },
        },
      },
    },
  },
];

/** Multi-turn env-fix. Returns the trail of tool calls + a summary
 *  of whether at least one mutation landed on disk (the leaf
 *  retry loop's signal that the test should be re-run). */
export async function applyEnvFixViaTools(
  client: LLMClient,
  input: EnvFixInput,
): Promise<EnvFixResult> {
  const maxIterations = Math.max(1, input.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildInitialUserPrompt(input) },
  ];
  const trail: EnvFixTrailEntry[] = [];
  let landedRealMutation = false;
  let lastTool: EnvToolName | undefined;
  let lastArgs: Record<string, unknown> | undefined;
  let lastNpmResult:
    | (NpmOpResult & { exitCode?: number | null })
    | undefined;

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
      // Audit issue #6: report iterations: i + 1 (a chat call was
      // attempted on this iteration), matching every other return
      // path in this loop. Previously off-by-one: chat-fail on the
      // first iteration reported iterations: 0.
      return {
        ok: landedRealMutation,
        trail,
        iterations: i + 1,
        terminatedExplicitly: false,
        error: `env-fix chat failed at iteration ${i + 1}: ${e instanceof Error ? e.message : String(e)}`,
        ...(lastTool ? { lastTool } : {}),
        ...(lastArgs ? { lastArgs } : {}),
        ...(lastNpmResult ? { lastNpmResult } : {}),
      };
    }
    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return {
        ok: landedRealMutation,
        trail,
        iterations: i + 1,
        terminatedExplicitly: false,
        error: "agent did not emit a tool call (must Terminate or use a tool)",
        ...(lastTool ? { lastTool } : {}),
        ...(lastArgs ? { lastArgs } : {}),
        ...(lastNpmResult ? { lastNpmResult } : {}),
      };
    }
    // Enforce one-call-per-turn. Same rationale as localize.
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
      // Audit issue #5: tag pre-apply rejections as `_invalid`
      // (not "Terminate") so summarizeEnvFix renders them
      // accurately rather than implying clean termination.
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        error: "rejected: multi-tool-call turn",
      });
      continue;
    }
    const call = toolCalls[0]!;
    const toolName = call.function.name as EnvToolName;
    if (!isEnvToolName(toolName)) {
      // Unknown tool name — surface the rejection back to the
      // model and let it retry.
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          error: `unknown tool "${call.function.name}". Pick one of: add_dependency, remove_dependency, set_script, npm_run, Terminate.`,
        }),
      });
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        error: `unknown tool: ${call.function.name}`,
      });
      continue;
    }

    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch (e) {
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          error: `arguments did not parse as JSON: ${e instanceof Error ? e.message : String(e)}. The arguments field must be a valid JSON object.`,
        }),
      });
      trail.push({
        iteration: i + 1,
        tool: "_invalid",
        args: {},
        error: `JSON parse on ${toolName}: ${call.function.arguments.slice(0, 200)}`,
      });
      continue;
    }

    if (toolName === "Terminate") {
      messages.push({
        role: "assistant",
        content: response.content ?? "",
        tool_calls: toolCalls,
      });
      // Ack the Terminate so OpenAI doesn't complain about the
      // unanswered tool_call_id (some clients are strict).
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ ok: true }),
      });
      trail.push({
        iteration: i + 1,
        tool: "Terminate",
        args: parsedArgs,
      });
      // Audit issue #10: do NOT overwrite lastTool / lastArgs /
      // lastNpmResult — they should describe the most recent
      // SUBSTANTIVE step (e.g., the add_dependency that mutated
      // disk), not the Terminate that closed the session. The
      // `terminatedExplicitly` flag is the signal that termination
      // happened cleanly.
      return {
        ok: landedRealMutation,
        trail,
        iterations: i + 1,
        terminatedExplicitly: true,
        ...(lastTool ? { lastTool } : {}),
        ...(lastArgs ? { lastArgs } : {}),
        ...(lastNpmResult ? { lastNpmResult } : {}),
      };
    }

    // Apply the data tool.
    const npmResult = await runEnvTool(toolName, parsedArgs, input);
    lastTool = toolName;
    lastArgs = parsedArgs;
    lastNpmResult = npmResult;
    // "Real mutation" = a tool call that ACTUALLY changed
    // package.json on disk. Audit issue #9: rely on the npm
    // primitives' `changed` flag — false on idempotent re-pin,
    // missing-package removal, or set_script with the same
    // command. npm_run is a probe — never counts. Semantics
    // MUST mirror leaf.ts's realChange computation exactly.
    if (
      (toolName === "add_dependency" ||
        toolName === "remove_dependency" ||
        toolName === "set_script") &&
      npmResult.ok &&
      npmResult.changed === true
    ) {
      landedRealMutation = true;
    }

    trail.push({
      iteration: i + 1,
      tool: toolName,
      args: parsedArgs,
      npmResult,
      ...(npmResult.error ? { error: npmResult.error } : {}),
    });

    // Push assistant + tool messages so the model sees the result
    // on the next turn.
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: toolCalls,
    });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(serializeNpmResultForTool(npmResult, toolName)),
    });
  }

  // Budget exhausted without Terminate.
  return {
    ok: landedRealMutation,
    trail,
    iterations: maxIterations,
    terminatedExplicitly: false,
    error: `env-fix exhausted ${maxIterations} iterations without Terminate`,
    ...(lastTool ? { lastTool } : {}),
    ...(lastArgs ? { lastArgs } : {}),
    ...(lastNpmResult ? { lastNpmResult } : {}),
  };
}

// ── Internals ────────────────────────────────────────────────────────

function isEnvToolName(s: string): s is EnvToolName {
  return (
    s === "add_dependency" ||
    s === "remove_dependency" ||
    s === "set_script" ||
    s === "npm_run" ||
    s === "Terminate"
  );
}

/** Audit issue #13: arg-type errors must name the offending arg
 *  and echo its actual type + value snippet so the model can see
 *  what it sent. Generic "must be strings" gives the model
 *  nothing to anchor on; it tends to repeat the same mistake. */
function describeOffendingArg(name: string, value: unknown): string {
  if (value === undefined) return `${name}: missing (must be a string)`;
  if (value === null) return `${name}: must be a string, got null`;
  const t = typeof value;
  if (t === "string") return "";
  let snippet: string;
  try {
    const j = JSON.stringify(value);
    snippet = j.length > 120 ? j.slice(0, 120) + "…" : j;
  } catch {
    snippet = String(value).slice(0, 120);
  }
  return `${name}: must be a string, got ${t} ${snippet}`;
}

function validateStringArgs(
  prefix: string,
  args: Record<string, unknown>,
  required: string[],
): string | null {
  const problems = required
    .map((k) => describeOffendingArg(k, args[k]))
    .filter((s) => s.length > 0);
  return problems.length === 0 ? null : `${prefix}: ${problems.join("; ")}`;
}

function argTypeError(prefix: string, msg: string): NpmOpResult {
  return {
    ok: false,
    installOk: false,
    installRan: false,
    error: `${prefix}: ${msg}`,
  };
}

async function runEnvTool(
  tool: Exclude<EnvToolName, "Terminate">,
  args: Record<string, unknown>,
  input: EnvFixInput,
): Promise<NpmOpResult & { exitCode?: number | null }> {
  const npmBinary = input.npmBinary ?? "npm";
  const skipNpmInstall = input.skipNpmInstall ?? false;
  switch (tool) {
    case "add_dependency": {
      const stringErr = validateStringArgs("add_dependency", args, [
        "name",
        "version",
      ]);
      if (stringErr) {
        return { ok: false, installOk: false, installRan: false, error: stringErr };
      }
      const which = args["which"];
      if (which !== "runtime" && which !== "dev") {
        const j = which === undefined ? "missing" : JSON.stringify(which);
        return argTypeError(
          "add_dependency",
          `which must be "runtime" or "dev", got ${j}`,
        );
      }
      return await addDependency({
        outDir: input.projectDir,
        name: args["name"] as string,
        version: args["version"] as string,
        which,
        npmBinary,
        skipNpmInstall,
      });
    }
    case "remove_dependency": {
      const err = validateStringArgs("remove_dependency", args, ["name"]);
      if (err) {
        return { ok: false, installOk: false, installRan: false, error: err };
      }
      return await removeDependency({
        outDir: input.projectDir,
        name: args["name"] as string,
        npmBinary,
        skipNpmInstall,
      });
    }
    case "set_script": {
      const err = validateStringArgs("set_script", args, ["name", "command"]);
      if (err) {
        return { ok: false, installOk: false, installRan: false, error: err };
      }
      return await setScript({
        outDir: input.projectDir,
        name: args["name"] as string,
        command: args["command"] as string,
        skipNpmInstall: true,
      });
    }
    case "npm_run": {
      const err = validateStringArgs("npm_run", args, ["script"]);
      if (err) {
        return { ok: false, installOk: false, installRan: false, error: err };
      }
      return await npmRun({
        outDir: input.projectDir,
        script: args["script"] as string,
        npmBinary,
      });
    }
  }
}

/** Audit issue #11: npm_run returns installRan:false /
 *  installOk:false unconditionally — three of four flags read as
 *  failure even on a clean `npm run build`. Caller passes the
 *  TOOL NAME so we can prune install-* from npm_run's serialized
 *  result (it never installs). */
function serializeNpmResultForTool(
  npmResult: NpmOpResult & { exitCode?: number | null },
  toolName?: EnvToolName,
): Record<string, unknown> {
  // Tail-truncate stdout/stderr — the actionable diagnostic is at
  // the END (npm warnings precede; gyp init noise precedes).
  const tail = (s: string | undefined, max: number): string | undefined => {
    if (!s) return s;
    return s.length > max ? "...[truncated head]\n" + s.slice(s.length - max) : s;
  };
  // Audit issue #11: `npm_run` is a probe — it never installs.
  // Stripping install-* from its tool result avoids the
  // confusing "ok: true, installRan: false, installOk: false"
  // that read as failure on a clean build.
  const isProbe = toolName === "npm_run";
  return {
    ok: npmResult.ok,
    ...(isProbe
      ? {}
      : {
          installRan: npmResult.installRan,
          installOk: npmResult.installOk,
        }),
    // Audit issue #9: tell the model whether the call actually
    // mutated package.json. `changed: false` after `add_dependency`
    // means "already at this version" — useful signal for the
    // model to pick a different binding instead of re-trying.
    ...(npmResult.changed !== undefined
      ? { changed: npmResult.changed }
      : {}),
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

function buildInitialUserPrompt(input: EnvFixInput): string {
  const lines: string[] = [];
  lines.push("# Diagnostic envPatchHint");
  lines.push("");
  lines.push(input.envPatchHint.trim());
  lines.push("");
  lines.push("# Failure output");
  lines.push("");
  const trimmed =
    input.failureMessage.length > 3000
      ? "...[truncated head]\n" +
        input.failureMessage.slice(input.failureMessage.length - 3000)
      : input.failureMessage;
  lines.push("```");
  lines.push(trimmed);
  lines.push("```");
  lines.push("");
  lines.push("# Test source");
  lines.push("");
  lines.push("```typescript");
  lines.push(input.testSource);
  lines.push("```");
  lines.push("");
  lines.push("# Body source (vouched correct by the diagnostic)");
  lines.push("");
  lines.push("```typescript");
  lines.push(input.bodySource);
  lines.push("```");
  lines.push("");
  lines.push(
    "Fix the environment so the same body + test pass. Use the tools — multi-turn is allowed. Terminate when you believe it's fixed.",
  );
  return lines.join("\n");
}
