/**
 * Stage B of feature #5 — npm-mutation primitives.
 *
 * Phase 0 is one-shot: the model picks the stack up front. But
 * during phases 5/6 the body author may realize it needs another
 * dependency (zod for validation, kysely for the planned SQL
 * client, etc.) — the user's framing was that this should NOT be
 * special-cased: deps are part of the project's source state, and
 * the model should be able to mutate them just like it mutates
 * code.
 *
 * Each primitive:
 *   - Reads the current package.json from outDir
 *   - Mutates the JSON in memory (validates the result)
 *   - Writes it back atomically (temp + rename)
 *   - Re-runs `npm install` if the dependency surface changed,
 *     so node_modules stays in sync with the manifest
 *
 * Tests stub the npm binary so the suite doesn't hit the registry.
 */

import { rename, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parsePackageJson,
  runNpmInstall,
  type PackageJson,
} from "./stack.js";

export interface NpmOpInput {
  /** Project directory containing package.json. */
  outDir: string;
  /** Skip the npm install re-run (tests; or operations that don't
   *  change the dependency surface). Default false. */
  skipNpmInstall?: boolean;
  /** Override the npm binary. Defaults to "npm". */
  npmBinary?: string;
  /** npm install timeout. Defaults to 5min. */
  npmInstallTimeoutMs?: number;
}

export interface NpmOpResult {
  ok: boolean;
  /** The post-mutation package.json. */
  packageJson?: PackageJson;
  /** True iff `npm install` ran AND succeeded. False on skip,
   *  failure, or no-op (operations that don't touch deps). */
  installOk: boolean;
  /** True iff `npm install` actually ran. */
  installRan: boolean;
  installStdout?: string;
  installStderr?: string;
  error?: string;
}

/**
 * Add a dependency. `which: "runtime"` lands in `dependencies`,
 * `which: "dev"` in `devDependencies`. Re-runs npm install on
 * success.
 *
 * Idempotent: if the package is already present at the given
 * version, this is a no-op (no install re-run). If present at a
 * different version, the version is updated and install re-runs.
 */
export async function addDependency(
  input: NpmOpInput & {
    name: string;
    version: string;
    which: "runtime" | "dev";
  },
): Promise<NpmOpResult> {
  const pkgPath = path.join(input.outDir, "package.json");
  const loaded = await loadPkg(pkgPath);
  if (!loaded.ok) return { ok: false, installOk: false, installRan: false, error: loaded.error };
  const pkg = loaded.value;
  const bucketName = input.which === "runtime" ? "dependencies" : "devDependencies";
  const bucket: Record<string, string> = pkg[bucketName] ?? {};
  if (bucket[input.name] === input.version) {
    // No change — return ok without re-installing.
    return {
      ok: true,
      packageJson: pkg,
      installOk: true,
      installRan: false,
    };
  }
  bucket[input.name] = input.version;
  pkg[bucketName] = bucket;
  return await persistAndInstall(pkg, pkgPath, input);
}

/**
 * Remove a dependency from both runtime and dev buckets. Returns
 * ok even when the package wasn't present (idempotent).
 */
export async function removeDependency(
  input: NpmOpInput & { name: string },
): Promise<NpmOpResult> {
  const pkgPath = path.join(input.outDir, "package.json");
  const loaded = await loadPkg(pkgPath);
  if (!loaded.ok) return { ok: false, installOk: false, installRan: false, error: loaded.error };
  const pkg = loaded.value;
  let changed = false;
  if (pkg.dependencies && input.name in pkg.dependencies) {
    delete pkg.dependencies[input.name];
    changed = true;
  }
  if (pkg.devDependencies && input.name in pkg.devDependencies) {
    delete pkg.devDependencies[input.name];
    changed = true;
  }
  if (!changed) {
    // Nothing to remove — no re-install.
    return {
      ok: true,
      packageJson: pkg,
      installOk: true,
      installRan: false,
    };
  }
  return await persistAndInstall(pkg, pkgPath, input);
}

/**
 * Set a script. Common cases: switch the test command, add a
 * lint or build script. No npm install re-run since scripts
 * don't affect node_modules.
 */
export async function setScript(
  input: NpmOpInput & { name: string; command: string },
): Promise<NpmOpResult> {
  const pkgPath = path.join(input.outDir, "package.json");
  const loaded = await loadPkg(pkgPath);
  if (!loaded.ok) return { ok: false, installOk: false, installRan: false, error: loaded.error };
  const pkg = loaded.value;
  pkg.scripts[input.name] = input.command;
  // Re-validate via parsePackageJson — guards against breaking the
  // scripts.test invariant by overwriting it with something that
  // doesn't invoke vitest.
  const reparsed = parsePackageJson(JSON.stringify(pkg));
  if (!reparsed.ok) {
    return {
      ok: false,
      installOk: false,
      installRan: false,
      error: `set_script would invalidate package.json: ${reparsed.error}`,
    };
  }
  await writePkg(pkgPath, pkg);
  return {
    ok: true,
    packageJson: pkg,
    installOk: true,
    installRan: false,
  };
}

/**
 * Run a script via `npm run <name>`. Captures stdout/stderr;
 * surfaces the exit code. Useful when the model wants to verify
 * its setup worked (npm run build, npm run test, etc.).
 */
export async function npmRun(
  input: NpmOpInput & { script: string; timeoutMs?: number },
): Promise<NpmOpResult & { exitCode: number | null }> {
  const pkgPath = path.join(input.outDir, "package.json");
  const loaded = await loadPkg(pkgPath);
  if (!loaded.ok) {
    return {
      ok: false,
      installOk: false,
      installRan: false,
      error: loaded.error,
      exitCode: null,
    };
  }
  const pkg = loaded.value;
  if (!(input.script in pkg.scripts)) {
    return {
      ok: false,
      installOk: false,
      installRan: false,
      error: `script "${input.script}" not in package.json`,
      packageJson: pkg,
      exitCode: null,
    };
  }
  // Re-use the same spawn machinery as runNpmInstall, but with
  // ["run", scriptName] as the args. We do this by calling a
  // dedicated runner that mirrors runNpmInstall's pattern.
  const result = await runNpmCommand({
    cwd: input.outDir,
    binary: input.npmBinary ?? "npm",
    args: ["run", input.script],
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    packageJson: pkg,
    installOk: false,
    installRan: false,
    installStdout: result.stdout,
    installStderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.exitCode === 0 && !result.timedOut
      ? {}
      : {
          error: `npm run ${input.script} exited with code ${result.exitCode ?? "null"}${result.timedOut ? " (timed out)" : ""}`,
        }),
  };
}

// ── Internals ────────────────────────────────────────────────────────

async function loadPkg(
  pkgPath: string,
): Promise<
  { ok: true; value: PackageJson } | { ok: false; error: string }
> {
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf-8");
  } catch (e) {
    return {
      ok: false,
      error: `failed to read ${pkgPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const parsed = parsePackageJson(raw);
  if (!parsed.ok) {
    return { ok: false, error: `invalid existing package.json: ${parsed.error}` };
  }
  return { ok: true, value: parsed.value };
}

async function writePkg(pkgPath: string, pkg: PackageJson): Promise<void> {
  // Atomic write via temp + rename — guards against half-written
  // package.json if the harness is killed mid-write.
  const tmp = pkgPath + ".tmp";
  await writeFile(tmp, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  await rename(tmp, pkgPath);
}

async function persistAndInstall(
  pkg: PackageJson,
  pkgPath: string,
  input: NpmOpInput,
): Promise<NpmOpResult> {
  await writePkg(pkgPath, pkg);
  if (input.skipNpmInstall) {
    return {
      ok: true,
      packageJson: pkg,
      installOk: false,
      installRan: false,
    };
  }
  const install = await runNpmInstall({
    cwd: input.outDir,
    binary: input.npmBinary ?? "npm",
    timeoutMs: input.npmInstallTimeoutMs ?? 300_000,
  });
  return {
    ok: install.ok,
    packageJson: pkg,
    installOk: install.ok,
    installRan: true,
    installStdout: install.stdout,
    installStderr: install.stderr,
    ...(install.ok
      ? {}
      : {
          error: `npm install exited with code ${install.exitCode ?? "null"}; stderr:\n${install.stderr.slice(0, 4000)}`,
        }),
  };
}

interface NpmCommandOpts {
  cwd: string;
  binary: string;
  args: string[];
  timeoutMs: number;
}

interface NpmCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runNpmCommand(opts: NpmCommandOpts): Promise<NpmCommandResult> {
  // Mirror runNpmInstall's pattern (detached + process-group kill
  // on timeout) for any npm subcommand.
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.binary, opts.args, {
        cwd: opts.cwd,
        env: process.env,
        detached: true,
      });
    } catch (e) {
      resolve({
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
        exitCode: code,
        stdout,
        stderr: timedOut
          ? `${stderr}\n[harness] command timed out after ${opts.timeoutMs}ms`
          : stderr,
        timedOut,
      });
    });
  });
}
