#!/usr/bin/env tsx
/**
 * One-shot baseline: ask the configured LLM (default GLM) to write
 * an entire TodoMVC core library in a single chat call, materialize
 * the result to demo/todomvc-baseline/, and run npm install + the
 * test script against the output.
 *
 * The whole point is the comparison: same description, same model,
 * same target — vs. the RPG-driven harness pipeline. Differences
 * the baseline tends to show against the harness:
 *   - Smaller code volume (one chat is bounded by context window)
 *   - No tests, or pro-forma tests that don't exercise the surface
 *   - Inconsistent module boundaries (greatest-hits API surface)
 *   - No incremental progress (you wait, then it's done or it isn't)
 *
 * Schema of the expected response is a JSON object:
 *   { files: [{ path: "src/foo.ts", content: "..." }, ...] }
 * Anything outside that schema gets dropped.
 *
 * The DESCRIPTION matches bin/build-todomvc.ts verbatim so a
 * side-by-side compare is fair.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import type { ChatMessage } from "../src/llm/types.js";

const DESCRIPTION = `Build a working TodoMVC web application that I can open in a browser, type into, and use end-to-end. TypeScript end to end.

REQUIREMENTS — these MUST be present:

  Functionality (the canonical TodoMVC feature set):
    - Add a todo by typing in the input and pressing Enter
    - Mark a todo complete / incomplete via a checkbox
    - Edit a todo by double-clicking it (Enter to save, Escape to cancel)
    - Delete an individual todo via a hover-revealed × button
    - Toggle-all checkbox that marks every todo complete (or active if all are already complete)
    - Filter view: All / Active / Completed (URL-routed via hash, e.g. #/active)
    - "X items left" counter (only counts active todos)
    - "Clear completed" button (only visible when at least one todo is completed)
    - Empty input rejects (don't add blank todos)

  Persistence:
    - SQLite (better-sqlite3 or your preferred sqlite binding). Todos survive a page refresh AND a server restart.
    - Schema: at minimum (id TEXT PRIMARY KEY, text TEXT, completed INTEGER, created_at INTEGER). Add columns if your design needs them.

  Server:
    - HTTP server exposing whatever endpoints the frontend needs (REST or otherwise — your call).
    - Serves the frontend assets too. ONE process, ONE port. \`npm start\` launches it; the README tells me which URL to open.

  Tests:
    - Unit tests for the storage / business logic layer (the parts that don't need a DOM).
    - Integration tests for the HTTP API (a fetch-based test that hits real endpoints against a temp database).
    - All tests run via \`npm test\` and pass cleanly.

  Quality bar:
    - Clean module boundaries: storage, business logic, HTTP, frontend each isolated.
    - Errors are real Error subclasses, not strings — server returns sensible HTTP codes, frontend doesn't crash on a 4xx.
    - Frontend is responsive and matches the canonical TodoMVC visual style closely enough that a TodoMVC fan recognizes it.

DECISIONS LEFT TO YOU:
  - UI: vanilla DOM, Lit, Preact, React, Vue, Solid, vanilla + a templating lib — your call. Pick what gives the best result with the least dependency surface for a project this size.
  - HTTP framework: hono, express, fastify, raw node http, etc.
  - SQLite binding: better-sqlite3, node-sqlite3, drizzle, kysely — pick one.
  - Build / bundle: vite, esbuild, tsx + plain script tags, no-bundler — your call. Keep it minimal.
  - File / folder layout: lay it out the way you'd organize a real codebase. Don't flatten just because it's small; don't over-nest just because of habit.

DON'T:
  - Don't add features the requirements list doesn't ask for (no auth, no themes, no multi-user, no drag-and-drop reordering — keep it focused).
  - Don't depend on global state or singletons that the tests can't isolate.
  - Don't ship debug \`console.log\`s in production paths.

I want a project where \`git clone … && npm install && npm test && npm start\` produces a working app I can interact with.
`;

const SYSTEM_PROMPT = `You are a senior TypeScript engineer.

You are given a project description. Produce a complete, runnable repository as a single JSON object:

{
  "files": [
    { "path": "src/foo.ts", "content": "..." },
    { "path": "tests/foo.test.ts", "content": "..." },
    { "path": "package.json", "content": "..." },
    ...
  ]
}

Rules:
  - Include package.json with type:"module", scripts.test invoking vitest, and devDependencies for vitest, tsx, @types/node.
  - Include a tsconfig.json suitable for tsx + ESM.
  - Include vitest tests that genuinely exercise the surface — not pro-forma.
  - Use crypto.randomUUID() (no extra deps).
  - File paths are repo-relative POSIX paths.
  - Output ONLY the JSON object. No prose, no markdown fences, no commentary.`;

interface BaselineResponse {
  files: Array<{ path: string; content: string }>;
}

interface RunNpmResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runNpm(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunNpmResult> {
  return new Promise((resolve) => {
    const child = spawn("npm", args, { cwd, env: process.env, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killedFinal = false;
    const killGroup = (sig: NodeJS.Signals): void => {
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
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
    }, timeoutMs);
    timer.unref();
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("close", (code) => {
      killedFinal = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr: timedOut
          ? `${stderr}\n[harness] command timed out after ${timeoutMs}ms`
          : stderr,
        timedOut,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + e.message,
        timedOut,
      });
    });
  });
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/);
  return m ? m[1]! : s;
}

function parseResponse(raw: string): BaselineResponse | null {
  const text = stripFences(raw).trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const files = (parsed as Record<string, unknown>)["files"];
  if (!Array.isArray(files)) return null;
  const valid: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    if (
      f &&
      typeof f === "object" &&
      typeof (f as Record<string, unknown>)["path"] === "string" &&
      typeof (f as Record<string, unknown>)["content"] === "string"
    ) {
      const fp = (f as Record<string, unknown>)["path"] as string;
      // Reject path traversal and absolute paths up front.
      if (fp.includes("..") || path.isAbsolute(fp)) continue;
      valid.push({
        path: fp,
        content: (f as Record<string, unknown>)["content"] as string,
      });
    }
  }
  return { files: valid };
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const log = (msg: string): void => {
    const t = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[+${t}s] ${msg}`);
  };

  const config = await loadConfig();
  const providerName =
    config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
  const cfg = providerName ? config.value.providers[providerName] : undefined;
  if (!providerName || !cfg || !cfg.apiKey) {
    const missing =
      providerName !== undefined
        ? missingForPath(config, `providers.${providerName}`)
            .map((m) => m.name)
            .join(", ") || "?"
        : "(no provider)";
    console.error(
      `[fatal] no API key resolved for default provider; missing env: ${missing}`,
    );
    return 2;
  }
  const client = createClient(providerName, cfg);
  log(`provider=${providerName} model=${cfg.model}`);

  const outDir = path.resolve("demo/todomvc-baseline");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Single chat call — that's the whole baseline.
  log("phase=author (one-shot)");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: DESCRIPTION },
  ];
  const response = await client.chat(messages, {
    responseFormat: { type: "json_object" },
  });
  const parsed = parseResponse(response.content);
  if (!parsed || parsed.files.length === 0) {
    console.error(
      `[fatal] response did not parse as { files: [{path, content}, ...] }. First 600 chars:\n${response.content.slice(0, 600)}`,
    );
    return 3;
  }
  log(`  ${parsed.files.length} files emitted`);

  // Materialize.
  for (const f of parsed.files) {
    const dest = path.join(outDir, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.content, "utf-8");
  }
  log(`  materialized to ${outDir}`);

  // npm install if there's a package.json.
  const hasPkg = parsed.files.some((f) => f.path === "package.json");
  if (!hasPkg) {
    log("  no package.json emitted — skipping install + test");
    return 0;
  }

  log("phase=install");
  const install = await runNpm(["install"], outDir, 300_000);
  if (!install.ok) {
    console.error(
      `[warning] npm install failed (exit ${install.exitCode}); stderr: ${install.stderr.slice(0, 1000)}`,
    );
    // Don't bail — emit the comparison artifact regardless.
  }

  log("phase=test");
  const testRun = await runNpm(["test"], outDir, 300_000);
  log(
    `  test exit=${testRun.exitCode}; stdout tail:\n${testRun.stdout.slice(-1500)}`,
  );

  // Brief summary printed to stdout for the comparison.
  const summary = {
    files: parsed.files.length,
    fileList: parsed.files.map((f) => f.path),
    installOk: install.ok,
    testOk: testRun.ok,
    testExitCode: testRun.exitCode,
  };
  log("done");
  console.log("\n=== baseline summary ===");
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n[fatal] uncaught: ${msg}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(1, 6).join("\n"));
  }
  process.exit(99);
}
