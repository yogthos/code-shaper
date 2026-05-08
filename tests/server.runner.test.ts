/**
 * Runner integration tests.
 *
 * The runner spawns `bin/run-task.ts` under the platform sandbox.
 * For unit testing we point it at a tiny mock entry script that:
 *   - Reads the args (--project-dir, --task, --mode, --result-path)
 *   - Emits a few `phase=...` lines to stdout
 *   - Writes a TaskResult JSON to --result-path
 *   - Exits with the requested code
 *
 * That lets us cover the runner's responsibilities (log capture,
 * phase callback, result read, cancel-via-signal) without invoking
 * the LLM-driven pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runTask } from "../src/server/runner.js";
import type { TaskPhase } from "../src/server/types.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "runner-"));
  // The runner tests exercise orchestration (log capture, phase
  // callbacks, cancel), not sandbox enforcement. On hosts where
  // the sandbox tool isn't usable (Ubuntu 24.04 GHA runners with
  // AppArmor blocking unprivileged user-namespace clone, etc.),
  // the runner's default refusal would mask the orchestration
  // tests as failures. Opt out here. The dedicated sandbox-
  // enforcement test (tests/server.sandbox.test.ts) still skips
  // gracefully when no sandbox is available.
  process.env.CODE_SHAPER_ALLOW_UNSANDBOXED = "1";
});

afterEach(async () => {
  delete process.env.CODE_SHAPER_ALLOW_UNSANDBOXED;
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function writeMockEntry(behavior: {
  exitCode: number;
  emitLines?: string[];
  writeResult?: boolean;
  hangSeconds?: number;
}): Promise<string> {
  const lines = behavior.emitLines ?? [];
  const writeResult = behavior.writeResult ?? true;
  const hangSeconds = behavior.hangSeconds ?? 0;
  const script = `#!/usr/bin/env tsx
import { writeFile } from "node:fs/promises";
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i]!] = process.argv[i + 1]!;
}
${lines
  .map((l) => `console.log(${JSON.stringify(l)});`)
  .join("\n")}
${
  hangSeconds > 0
    ? `await new Promise(r => setTimeout(r, ${hangSeconds * 1000}));`
    : ""
}
${
  writeResult
    ? `await writeFile(args["--result-path"]!, JSON.stringify({
  ok: true,
  summary: "mock",
  materializedTo: args["--project-dir"]!,
  leafResults: [],
  integrationOk: true,
  error: null,
}));`
    : ""
}
process.exit(${behavior.exitCode});
`;
  const entryPath = path.join(workDir, "mock-entry.mts");
  await writeFile(entryPath, script, "utf-8");
  return entryPath;
}

describe("runner — happy path", () => {
  it(
    "spawns the child, captures stdout, fires phase callbacks, returns the parsed result",
    { timeout: 30_000 },
    async () => {
      const projectDir = path.join(workDir, "proj");
      const logPath = path.join(workDir, "logs", "t.log");
      const resultPath = path.join(workDir, "results", "t.json");
      const entryPath = await writeMockEntry({
        exitCode: 0,
        emitLines: [
          "[+0.0s] phase=proposal",
          "[+1.0s]   3 capabilities planned",
          "[+1.0s] phase=structure",
          "[+2.0s] phase=done",
        ],
      });
      const phases: TaskPhase[] = [];
      const handle = runTask({
        taskId: "t-mock",
        projectDir,
        task: "do x",
        mode: "greenfield",
        resultPath,
        logPath,
        diskQuotaMb: 1024,
        extraWritableRoots: [workDir],
        entryPath,
        onPhaseChange: (p) => {
          phases.push(p);
        },
      });
      const result = await handle.done;
      expect(result.ok).toBe(true);
      expect(result.summary).toBe("mock");
      // Terminal phases (done/failed/cancelled) are NOT forwarded
      // through onPhaseChange — the parent owns terminal transitions
      // (see runner's VALID_REPORTED_PHASES). Only progress phases
      // come through here.
      expect(phases).toEqual(["proposal", "structure"]);
      const log = await readFile(logPath, "utf-8");
      expect(log).toContain("phase=proposal");
      expect(log).toContain("3 capabilities planned");
    },
  );
});

describe("runner — child crash", () => {
  it(
    "synthesizes a failure result when the child exits without writing one",
    { timeout: 15_000 },
    async () => {
      const projectDir = path.join(workDir, "proj");
      const logPath = path.join(workDir, "logs", "t.log");
      const resultPath = path.join(workDir, "results", "t.json");
      const entryPath = await writeMockEntry({
        exitCode: 1,
        writeResult: false,
        emitLines: ["[+0.0s] phase=proposal", "boom"],
      });
      const handle = runTask({
        taskId: "t-crash",
        projectDir,
        task: "x",
        mode: "greenfield",
        resultPath,
        logPath,
        diskQuotaMb: 1024,
        extraWritableRoots: [workDir],
        entryPath,
      });
      const result = await handle.done;
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("child exited without writing result");
    },
  );
});

describe("runner — cancellation", () => {
  it(
    "cancel() SIGTERMs the child mid-run and reports cancellation",
    { timeout: 15_000 },
    async () => {
      const projectDir = path.join(workDir, "proj");
      const logPath = path.join(workDir, "logs", "t.log");
      const resultPath = path.join(workDir, "results", "t.json");
      const entryPath = await writeMockEntry({
        exitCode: 0,
        emitLines: ["[+0.0s] phase=proposal"],
        // Hang long enough that the parent must SIGTERM us.
        hangSeconds: 10,
        writeResult: false,
      });
      const handle = runTask({
        taskId: "t-cancel",
        projectDir,
        task: "x",
        mode: "greenfield",
        resultPath,
        logPath,
        diskQuotaMb: 1024,
        extraWritableRoots: [workDir],
        entryPath,
      });
      // Wait for the proposal line to land so we know the child is up.
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const timer = setInterval(async () => {
          try {
            const log = await readFile(logPath, "utf-8");
            if (log.includes("phase=proposal") || Date.now() - start > 8000) {
              clearInterval(timer);
              resolve();
            }
          } catch {
            /* log may not exist yet */
          }
        }, 50);
      });
      handle.cancel();
      const result = await handle.done;
      expect(result.ok).toBe(false);
      expect(result.summary.toLowerCase()).toContain("cancel");
    },
  );
});
