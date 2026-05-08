/**
 * Stage C wiring: when the diagnostic verdict is `environment` and
 * env-fix is enabled, the harness invokes the env-fix tool author,
 * applies the chosen npm-mutation, and re-runs the test against the
 * SAME body. If the rerun passes, the leaf is done without burning
 * body-author retries.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  emptyRPG,
  type FileNode,
  type FolderNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  createHarnessDir,
  implementLeaf,
  linkHostNodeModules,
} from "../src/implementor/index.js";
import type { LLMClient, LLMResponse } from "../src/llm/types.js";

let workDir: string;
let projectDir: string;

beforeAll(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
}, 30_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "leaf-envfix-"));
  // Pre-seed a valid package.json so the npm-tools primitives can
  // load + mutate it.
  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: "test-app",
        version: "0.1.0",
        type: "module",
        scripts: { test: "vitest run" },
        dependencies: {},
        devDependencies: { vitest: "^2.0.0" },
      },
      null,
      2,
    ),
  );
});

afterEach(async () => {
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

function buildAddRpg(): { rpg: RPG; hostFile: FileNode; leafId: string } {
  const rpg = emptyRPG();
  const root = rpg.nodes[rpg.rootId] as FolderNode;
  rpg.nodes["folder:src"] = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    parent: rpg.rootId,
    children: [],
    features: [],
    path: "src",
  };
  root.children.push("folder:src");
  const leafId = "cap:add";
  const file: FileNode = {
    id: "file:src/add.ts",
    kind: "file",
    name: "add.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/add.ts",
    content: "",
    language: "typescript",
    rawImports: [],
    exports: [],
    interfacePlan: {
      classes: [],
      entries: [
        {
          leafCapabilityId: leafId,
          kind: "function",
          ownerClassName: null,
          name: "add",
          signature: {
            params: [
              { name: "a", type: "number" },
              { name: "b", type: "number" },
            ],
            returnType: "number",
            isAsync: false,
          },
          description: "Sum two numbers.",
          exported: true,
          isStatic: false,
        },
      ],
    },
  };
  rpg.nodes[file.id] = file;
  (rpg.nodes["folder:src"] as FolderNode).children.push(file.id);
  return { rpg, hostFile: file, leafId };
}

const TEST = `import { describe, it, expect } from "vitest";
import { add } from "../../src/add.js";
describe("add", () => { it("sums", () => { expect(add(2, 3)).toBe(5); }); });
`;

describe("implementLeaf — env-fix on environment verdicts", () => {
  it(
    "applies add_dependency on environment verdict, retries, and succeeds",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddRpg();
      let envToolCalls = 0;
      let bodyAttempts = 0;

      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;

          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            return { content: TEST, finishReason: "stop" };
          }

          if (sys.includes("producing the body of a single")) {
            bodyAttempts++;
            // First body wrong, second right.
            if (bodyAttempts === 1) {
              return { content: "return a;", finishReason: "stop" };
            }
            return { content: "return a + b;", finishReason: "stop" };
          }

          if (sys.includes("Diagnostic agent")) {
            // Vote environment 5/5 on the first failure.
            return {
              content: JSON.stringify({
                category: "environment",
                reasoning: "missing dep",
                envPatchHint: "add zod for validation",
              }),
              finishReason: "stop",
            };
          }

          if (
            sys.includes("environment-level fixes") ||
            sys.includes("npm-mutation tools")
          ) {
            envToolCalls++;
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "envcall",
                  type: "function",
                  function: {
                    name: "add_dependency",
                    arguments: JSON.stringify({
                      name: "zod",
                      version: "^3.22.0",
                      which: "runtime",
                    }),
                  },
                },
              ],
            };
          }

          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      const result = await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 3,
        diagnosis: { enabled: true, rounds: 5, afterFailures: 0 },
        // Env-fix wired in.
        enableEnvFix: true,
        projectDir,
        envFixSkipNpmInstall: true,
      });

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(envToolCalls).toBeGreaterThanOrEqual(1);
      // The package.json on disk got the new dep.
      const pkg = JSON.parse(
        await readFile(path.join(projectDir, "package.json"), "utf-8"),
      );
      expect(pkg.dependencies?.zod).toBe("^3.22.0");
    },
  );

  it(
    "respects maxEnvPatches budget — env-fix doesn't fire after exhaustion",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddRpg();
      let envToolCalls = 0;

      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            return { content: TEST, finishReason: "stop" };
          }
          if (sys.includes("producing the body of a single")) {
            // Always wrong — body keeps failing, diagnostic keeps
            // saying environment.
            return { content: "return a;", finishReason: "stop" };
          }
          if (sys.includes("Diagnostic agent")) {
            return {
              content: JSON.stringify({
                category: "environment",
                reasoning: "missing dep",
                envPatchHint: "x",
              }),
              finishReason: "stop",
            };
          }
          if (
            sys.includes("environment-level fixes") ||
            sys.includes("npm-mutation tools")
          ) {
            envToolCalls++;
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "ec",
                  type: "function",
                  function: {
                    name: "add_dependency",
                    arguments: JSON.stringify({
                      name: "zod",
                      version: "^3.0.0",
                      which: "runtime",
                    }),
                  },
                },
              ],
            };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 5,
        diagnosis: { enabled: true, rounds: 1, afterFailures: 0 },
        enableEnvFix: true,
        maxEnvPatches: 2,
        projectDir,
        envFixSkipNpmInstall: true,
      });

      // env-fix called at most maxEnvPatches=2 times.
      expect(envToolCalls).toBeLessThanOrEqual(2);
    },
  );

  it(
    "is a no-op when enableEnvFix is false (default)",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildAddRpg();
      let envToolCalls = 0;

      const client: LLMClient = {
        async chat(messages, opts): Promise<LLMResponse> {
          const sys = messages[0]!.content;
          if (
            sys.includes("producing a vitest test file") &&
            !opts?.tools
          ) {
            return { content: TEST, finishReason: "stop" };
          }
          if (sys.includes("producing the body of a single")) {
            return { content: "return a + b;", finishReason: "stop" };
          }
          if (sys.includes("Diagnostic agent")) {
            return {
              content: JSON.stringify({
                category: "environment",
                reasoning: "x",
                envPatchHint: "y",
              }),
              finishReason: "stop",
            };
          }
          if (sys.includes("environment-level fixes")) {
            envToolCalls++;
            return { content: "", finishReason: "stop" };
          }
          return { content: "", finishReason: "stop" };
        },
        async listModels() {
          return ["mock"];
        },
      };

      await implementLeaf(client, {
        leaf: hostFile.interfacePlan!.entries[0]!,
        hostFile,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map(),
        workDir,
        maxAttempts: 2,
        diagnosis: { enabled: true, rounds: 1, afterFailures: 0 },
        // enableEnvFix NOT set
      });

      expect(envToolCalls).toBe(0);
    },
  );
});
