/**
 * Phase 0 — stack proposal + package.json materialization.
 *
 * The architect picks a TS/JS stack (deps, scripts, engines) for
 * the project. The harness validates the result, materializes it
 * to `<outDir>/package.json`, and (optionally) runs `npm install`
 * so subsequent phases see a real `node_modules` and can rely on
 * declared dependencies in their generated code.
 *
 * Mutation flow (later phases):
 *   - Operations vocabulary will gain `add_dependency` /
 *     `remove_dependency` / `set_script` (feature #5 stage B). Each
 *     mutation re-materializes package.json and re-runs npm install.
 *   - For now: the model only gets one shot at picking the stack
 *     up front; the only correctness guarantee is "scripts.test
 *     invokes vitest, the install command succeeded."
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LLMClient } from "../llm/types.js";
import {
  STACK_SYSTEM_PROMPT,
  buildStackUserPrompt,
} from "./stack-prompts.js";

export interface PackageJson {
  name: string;
  version: string;
  description?: string;
  type: "module";
  engines?: { node?: string };
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface StackInput {
  description: string;
  /** Where package.json + node_modules land. Caller's responsibility
   *  to ensure it exists / is sandboxed. */
  outDir: string;
  /** Read existing package.json from outDir (extend mode) and pass
   *  it to the prompt so the model integrates with what's there. */
  mode?: "greenfield" | "extend";
  maxAttempts?: number;
  temperature?: number;
  /** Skip the npm install step. Default false. Tests pass true so
   *  they don't require network + don't pollute the project tree. */
  skipNpmInstall?: boolean;
  /** Hard cap on `npm install` wall-clock. Default 5 minutes — npm
   *  on a cold cache + slow registry can run long. */
  npmInstallTimeoutMs?: number;
  /** Override the npm binary. Used by tests; defaults to "npm". */
  npmBinary?: string;
}

export interface StackResult {
  ok: boolean;
  /** The validated package.json the harness wrote to disk. */
  packageJson?: PackageJson;
  installRan: boolean;
  installOk: boolean;
  installStdout?: string;
  installStderr?: string;
  error?: string;
  attempts: number;
}

const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 300_000;

export async function proposeStack(
  client: LLMClient,
  input: StackInput,
): Promise<StackResult> {
  const maxAttempts = input.maxAttempts ?? 2;
  let lastError: string | null = null;
  let lastResponse: string | null = null;
  let pkg: PackageJson | null = null;
  let attempts = 0;

  let existingPackageJson: string | undefined;
  if (input.mode === "extend") {
    try {
      const raw = await readFile(
        path.join(input.outDir, "package.json"),
        "utf-8",
      );
      // Pretty-print for the prompt (the model handles that better
      // than a single-line minified blob).
      try {
        existingPackageJson = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        existingPackageJson = raw;
      }
    } catch {
      // No existing package.json — fall through to greenfield-style
      // proposal silently.
    }
  }

  const userPrompt = buildStackUserPrompt({
    projectDescription: input.description,
    ...(existingPackageJson ? { existingPackageJson } : {}),
  });

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [
      { role: "system", content: STACK_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    if (lastError !== null && lastResponse !== null) {
      messages.push({ role: "assistant", content: lastResponse });
      messages.push({
        role: "user",
        content: `Your previous response failed validation: ${lastError}\nReturn corrected JSON now.`,
      });
    }
    const response = await client.chat(messages, {
      responseFormat: { type: "json_object" },
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
    });
    const parsed = parsePackageJson(response.content);
    if (parsed.ok) {
      pkg = parsed.value;
      break;
    }
    lastError = parsed.error;
    lastResponse = response.content;
  }

  if (!pkg) {
    return {
      ok: false,
      installRan: false,
      installOk: false,
      attempts,
      error: lastError ?? "no package.json produced",
    };
  }

  // Materialize.
  await mkdir(input.outDir, { recursive: true });
  await writeFile(
    path.join(input.outDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
    "utf-8",
  );

  if (input.skipNpmInstall) {
    return {
      ok: true,
      packageJson: pkg,
      installRan: false,
      installOk: false,
      attempts,
    };
  }

  // npm install.
  const install = await runNpmInstall({
    cwd: input.outDir,
    binary: input.npmBinary ?? "npm",
    timeoutMs: input.npmInstallTimeoutMs ?? DEFAULT_NPM_INSTALL_TIMEOUT_MS,
  });
  return {
    ok: install.ok,
    packageJson: pkg,
    installRan: true,
    installOk: install.ok,
    installStdout: install.stdout,
    installStderr: install.stderr,
    attempts,
    ...(install.ok
      ? {}
      : {
          error: `npm install exited with code ${install.exitCode ?? "null"}; stderr:\n${install.stderr.slice(0, 4000)}`,
        }),
  };
}

// ── Package.json validation ──────────────────────────────────────────

interface ParseOk {
  ok: true;
  value: PackageJson;
}
interface ParseErr {
  ok: false;
  error: string;
}

export function parsePackageJson(raw: string): ParseOk | ParseErr {
  const text = stripFences(raw).trim();
  if (!text) return { ok: false, error: "empty response body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  if (!isObject(parsed)) {
    return { ok: false, error: "top-level value is not an object" };
  }
  const obj = parsed;
  const name = obj["name"];
  // Review fix #2: use npm's actual package-name format (allows
  // scoped names @org/pkg, names with `.` and `_`, digit-leading
  // segments). Length-capped at 214 per npm spec.
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 214 ||
    !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
  ) {
    return {
      ok: false,
      error: `name: must match npm package-name format (got ${JSON.stringify(name)})`,
    };
  }
  const version = obj["version"];
  // Review fix #3: anchor the regex so "0.1.0junk" is rejected;
  // accept pre-release + build metadata per semver.
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
  ) {
    return {
      ok: false,
      error: `version: required semver string (got ${JSON.stringify(version)})`,
    };
  }
  const type = obj["type"];
  if (type !== "module") {
    return {
      ok: false,
      error: `type: must be "module" (the harness assumes ESM)`,
    };
  }
  const scripts = obj["scripts"];
  if (!isObject(scripts) || typeof scripts["test"] !== "string") {
    return {
      ok: false,
      error: `scripts.test: required string`,
    };
  }
  const testScript = scripts["test"] as string;
  if (!/\bvitest\b/.test(testScript)) {
    return {
      ok: false,
      error: `scripts.test: must invoke vitest (got "${testScript}")`,
    };
  }
  // Validate scripts is a string-string map.
  for (const [k, v] of Object.entries(scripts)) {
    if (typeof v !== "string") {
      return {
        ok: false,
        error: `scripts["${k}"]: must be a string`,
      };
    }
  }
  // dependencies + devDependencies: optional string-string maps.
  const dependencies = obj["dependencies"];
  if (dependencies !== undefined && !isObject(dependencies)) {
    return { ok: false, error: `dependencies: must be an object if present` };
  }
  if (dependencies && !allStringValues(dependencies)) {
    return {
      ok: false,
      error: `dependencies: every value must be a version string`,
    };
  }
  const devDependencies = obj["devDependencies"];
  if (devDependencies !== undefined && !isObject(devDependencies)) {
    return {
      ok: false,
      error: `devDependencies: must be an object if present`,
    };
  }
  if (devDependencies && !allStringValues(devDependencies)) {
    return {
      ok: false,
      error: `devDependencies: every value must be a version string`,
    };
  }
  // engines: optional, accepts {node?: string}
  const engines = obj["engines"];
  if (engines !== undefined) {
    if (!isObject(engines)) {
      return { ok: false, error: `engines: must be an object if present` };
    }
    if ("node" in engines && typeof engines["node"] !== "string") {
      return { ok: false, error: `engines.node: must be a string if present` };
    }
  }
  // Construct the validated value.
  const value: PackageJson = {
    name,
    version,
    type: "module",
    scripts: scripts as Record<string, string>,
  };
  const description = obj["description"];
  if (typeof description === "string") value.description = description;
  if (engines && typeof engines === "object") {
    value.engines = engines as { node?: string };
  }
  if (dependencies) {
    value.dependencies = dependencies as Record<string, string>;
  }
  if (devDependencies) {
    value.devDependencies = devDependencies as Record<string, string>;
  }
  return { ok: true, value };
}

// ── npm runner ───────────────────────────────────────────────────────

interface NpmInstallOptions {
  cwd: string;
  binary: string;
  timeoutMs: number;
}

interface NpmInstallResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runNpmInstall(
  opts: NpmInstallOptions,
): Promise<NpmInstallResult> {
  return new Promise((resolve) => {
    let child;
    try {
      // detached:true puts the install in its own process group so
      // we can SIGKILL the whole tree on timeout. Same pattern the
      // test-harness already uses for vitest.
      child = spawn(opts.binary, ["install"], {
        cwd: opts.cwd,
        env: process.env,
        detached: true,
      });
    } catch (e) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedFinal = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (typeof child!.pid === "number") {
        try {
          process.kill(-child!.pid, signal);
        } catch {
          try {
            child!.kill(signal);
          } catch {
            /* gone */
          }
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!killedFinal) killGroup("SIGKILL");
      }, 2_000).unref();
    }, opts.timeoutMs);
    timer.unref();

    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + (err instanceof Error ? err.message : String(err)),
        timedOut,
      });
    });
    child.on("close", (code) => {
      killedFinal = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr: timedOut
          ? `${stderr}\n[harness] npm install timed out after ${opts.timeoutMs}ms`
          : stderr,
        timedOut,
      });
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return fence ? fence[1]! : s;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function allStringValues(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every((v) => typeof v === "string");
}
