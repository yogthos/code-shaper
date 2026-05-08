/**
 * Stage C of feature #5 — env-fix author.
 *
 * Fires when `diagnoseFailure` returns category=`environment`. The
 * model picks one of four npm-mutation tools, the harness applies
 * it via the npm-tools primitives, and the leaf retry loop re-runs
 * the test against the same body. If the failure was indeed
 * env-related (missing dep, wrong script, etc.), the rerun
 * succeeds without burning body-author retries.
 *
 * Mirrors the pattern of editLeafViaTools (feature #3 stage B):
 * single OpenAI tool call per author session, structured args
 * validated against the underlying primitive's schema.
 *
 * Caveat: changes land in `outDir/package.json` + `outDir/node_modules`,
 * but the harness currently runs vitest against a separate workDir
 * that symlinks node_modules from the host repo. So a newly-added
 * dep won't be visible to vitest until the harness's node_modules
 * resolution is reworked. The primitive is still useful for: (a)
 * landing the right deps on disk for the user, (b) `set_script`
 * fixes that don't depend on node_modules, (c) `npm_run` invoking
 * the host's npm scripts (e.g., `npm run typecheck`).
 */

import {
  addDependency,
  removeDependency,
  setScript,
  npmRun,
  type NpmOpResult,
} from "../architect/npm-tools.js";
import type { LLMClient, ChatOptions } from "../llm/types.js";

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
  | "npm_run";

export interface EnvFixResult {
  ok: boolean;
  /** Which tool the model picked. */
  tool?: EnvToolName;
  /** Args the model supplied. */
  args?: Record<string, unknown>;
  /** The npm op's underlying result. */
  npmResult?: NpmOpResult & { exitCode?: number | null };
  error?: string;
}

const SYSTEM_PROMPT = `You are an Implementor agent applying environment-level fixes to a TypeScript project. A failing test was diagnosed as an ENVIRONMENT issue (missing dependency, wrong script, version mismatch, etc.) — NOT an implementation bug — by a 5-round majority-vote LLM judge.

Your job is to fix the project's environment so the SAME body and SAME test produce a passing run. Pick exactly ONE tool:

  add_dependency
    Add a runtime or dev dependency to package.json + run npm install. Use when the test imports a module that isn't declared.

  remove_dependency
    Strip a package from both buckets + run npm install. Use when a dep is causing a version conflict and the project doesn't actually need it.

  set_script
    Add or change an npm script. The harness REFUSES edits that overwrite scripts.test with anything not invoking vitest, so don't try.

  npm_run
    Run an existing script (e.g., npm run build, npm run typecheck) to validate the fix. Use when you've already added a dep and want to confirm it resolves before terminating.

Rules:
  - Output exactly ONE tool call. Don't write prose.
  - Be conservative. The diagnostic vouches that the BODY is plausibly correct; don't restructure the project.
  - If the hint mentions a specific package name, use that.
  - For add_dependency: prefer caret-prefixed versions ("^1.2.3") on current major versions.

Return only the tool call.`;

const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "add_dependency",
      description:
        "Add a package to package.json (dependencies if which=runtime, devDependencies if which=dev) and re-run npm install.",
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
        "Strip a package from both runtime and dev buckets and re-run npm install.",
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
        "Set an npm script (refuses to break scripts.test invariant).",
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
        "Run an existing npm script and report exit code, stdout, stderr.",
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
];

export async function applyEnvFixViaTools(
  client: LLMClient,
  input: EnvFixInput,
): Promise<EnvFixResult> {
  const userPrompt = buildUserPrompt(input);
  const opts: ChatOptions = {
    tools: TOOL_DEFS,
    toolChoice: "required",
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
  };
  const response = await client.chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    opts,
  );
  const calls = response.toolCalls ?? [];
  if (calls.length === 0) {
    return { ok: false, error: "agent did not emit a tool call" };
  }
  const call = calls[0]!;
  const toolName = call.function.name as EnvToolName;
  if (!isEnvToolName(toolName)) {
    return { ok: false, error: `unknown tool "${call.function.name}"` };
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      tool: toolName,
      error: `tool arguments did not parse: ${(e as Error).message}`,
    };
  }
  const npmResult = await runEnvTool(toolName, args, input);
  return {
    ok: npmResult.ok,
    tool: toolName,
    args,
    npmResult,
    ...(npmResult.ok ? {} : { error: npmResult.error ?? "tool failed" }),
  };
}

// ── Internals ────────────────────────────────────────────────────────

function isEnvToolName(s: string): s is EnvToolName {
  return (
    s === "add_dependency" ||
    s === "remove_dependency" ||
    s === "set_script" ||
    s === "npm_run"
  );
}

async function runEnvTool(
  tool: EnvToolName,
  args: Record<string, unknown>,
  input: EnvFixInput,
): Promise<NpmOpResult & { exitCode?: number | null }> {
  const npmBinary = input.npmBinary ?? "npm";
  const skipNpmInstall = input.skipNpmInstall ?? false;
  switch (tool) {
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
          installOk: false,
          installRan: false,
          error:
            "add_dependency: name/version must be strings, which must be 'runtime' or 'dev'",
        };
      }
      return await addDependency({
        outDir: input.projectDir,
        name,
        version,
        which,
        npmBinary,
        skipNpmInstall,
      });
    }
    case "remove_dependency": {
      const name = args["name"];
      if (typeof name !== "string") {
        return {
          ok: false,
          installOk: false,
          installRan: false,
          error: "remove_dependency: name must be a string",
        };
      }
      return await removeDependency({
        outDir: input.projectDir,
        name,
        npmBinary,
        skipNpmInstall,
      });
    }
    case "set_script": {
      const name = args["name"];
      const command = args["command"];
      if (typeof name !== "string" || typeof command !== "string") {
        return {
          ok: false,
          installOk: false,
          installRan: false,
          error: "set_script: name and command must be strings",
        };
      }
      return await setScript({
        outDir: input.projectDir,
        name,
        command,
        skipNpmInstall: true, // scripts don't affect deps
      });
    }
    case "npm_run": {
      const script = args["script"];
      if (typeof script !== "string") {
        return {
          ok: false,
          installOk: false,
          installRan: false,
          error: "npm_run: script must be a string",
        };
      }
      return await npmRun({
        outDir: input.projectDir,
        script,
        npmBinary,
      });
    }
  }
}

function buildUserPrompt(input: EnvFixInput): string {
  const lines: string[] = [];
  lines.push("# Diagnostic envPatchHint");
  lines.push("");
  lines.push(input.envPatchHint.trim());
  lines.push("");
  lines.push("# Failure output");
  lines.push("");
  const trimmed =
    input.failureMessage.length > 3000
      ? input.failureMessage.slice(0, 3000) + "\n... [truncated]"
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
    "Pick one tool to fix the environment. Output the structured tool call only.",
  );
  return lines.join("\n");
}
