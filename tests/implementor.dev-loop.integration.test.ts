/**
 * Step 8: dev-loop isolation test — real LLM.
 *
 * Mirrors the failure mode that wedged the last TodoMVC run:
 * a leaf whose body needs to throw an error class defined in
 * a SIBLING file. Without read_file, the model has no way to
 * discover the error class's location and burns its retry
 * budget guessing.
 *
 * What we assert:
 *   - Loop terminates with ok=true (model figures it out)
 *   - The trail includes at least one read tool call (the model
 *     used the inspection capability — not just speculatively
 *     edited)
 *   - The leaf's test passes against the produced body
 *
 * Skipped when no API key is resolved.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import { emptyRPG } from "../src/rpg/index.js";
import { runLeafDevLoop } from "../src/implementor/dev-loop.js";
import {
  runTests,
  createHarnessDir,
  linkHostNodeModules,
} from "../src/implementor/test-harness.js";
import type { FileNode, FolderNode, RPG } from "../src/rpg/types.js";

const config = await loadConfig();
const providerName =
  config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
const cfg = providerName ? config.value.providers[providerName] : undefined;
const apiKeyResolved = !!cfg && !!cfg.apiKey && cfg.apiKey.length > 0;

function mkFile(opts: {
  id: string;
  path: string;
  content?: string;
  interfacePlan?: FileNode["interfacePlan"];
}): FileNode {
  return {
    id: opts.id,
    kind: "file",
    name: opts.path.split("/").pop() ?? "",
    path: opts.path,
    content: opts.content ?? "",
    language: "typescript",
    rawImports: [],
    exports: [],
    parent: null,
    children: [],
    features: [],
    ...(opts.interfacePlan ? { interfacePlan: opts.interfacePlan } : {}),
  };
}

function rpgWithFiles(files: FileNode[]): RPG {
  const rpg = emptyRPG();
  const root: FolderNode = {
    id: "folder:src",
    kind: "folder",
    name: "src",
    path: "src",
    parent: null,
    children: [],
    features: [],
  };
  rpg.nodes[root.id] = root;
  for (const f of files) {
    rpg.nodes[f.id] = f;
    f.parent = root.id;
    root.children.push(f.id);
  }
  return rpg;
}

let workDir: string;

beforeEach(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("dev-loop isolation — real LLM", () => {
  if (!apiKeyResolved) {
    const missing =
      providerName !== undefined
        ? missingForPath(config, `providers.${providerName}`)
            .map((m) => m.name)
            .join(", ")
        : "?";
    it.skip(
      `skipped — provider ${providerName ?? "?"} has no resolved API key (missing: ${missing})`,
      () => {},
    );
    return;
  }

  it(
    "discovers a sibling error class via read_file and uses it correctly",
    { timeout: 600_000 },
    async () => {
      // Fixture: errors.ts defines TodoValidationError. validation.ts
      // has a leaf that must throw it on empty input. The model
      // should list_files, read_file errors.ts, add the import, then
      // implement the body.
      const errors = mkFile({
        id: "file:errors",
        path: "src/errors.ts",
        content:
          "// Project error types.\nexport class TodoValidationError extends Error {\n  constructor(msg: string) {\n    super(msg);\n    this.name = 'TodoValidationError';\n  }\n}\n",
      });
      const validation = mkFile({
        id: "file:validation",
        path: "src/validation.ts",
        interfacePlan: {
          entries: [
            {
              leafCapabilityId: "cap:validate",
              kind: "function",
              name: "validateText",
              ownerClassName: null,
              description:
                "Validate that a todo text is non-empty after trimming. Throws TodoValidationError (defined in src/errors.ts) when the text is empty or whitespace-only. Returns nothing on success.",
              signature: {
                params: [{ name: "text", type: "string" }],
                returnType: "void",
                isAsync: false,
              },
              exported: true,
              isStatic: false,
            },
          ],
          classes: [],
        },
      });
      const rpg = rpgWithFiles([errors, validation]);

      const TEST_SRC = `import { describe, it, expect } from "vitest";
import { validateText } from "../../src/validation.js";
import { TodoValidationError } from "../../src/errors.js";
describe("validateText", () => {
  it("returns void on non-empty", () => {
    expect(validateText("hello")).toBeUndefined();
  });
  it("throws TodoValidationError on empty", () => {
    expect(() => validateText("")).toThrow(TodoValidationError);
  });
  it("throws TodoValidationError on whitespace-only", () => {
    expect(() => validateText("   ")).toThrow(TodoValidationError);
  });
});
`;

      const client = createClient(providerName!, cfg!);
      const r = await runLeafDevLoop(client, {
        leaf: validation.interfacePlan!.entries[0]!,
        hostFile: validation,
        rpg,
        bodyByLeafId: new Map(),
        testsByLeafId: new Map([["cap:validate", TEST_SRC]]),
        workDir,
        maxIterations: 20,
      });

      // Print the trail so test failures show what the model did.
      // (Not an assertion — just observability.)
      // eslint-disable-next-line no-console
      console.log(
        "dev-loop trail:",
        r.trail
          .map(
            (t) =>
              `  [${t.iteration}] ${t.tool}${
                t.error ? " ✗ " + t.error.slice(0, 120) : t.summary ? " — " + t.summary : ""
              }`,
          )
          .join("\n"),
      );

      expect(r.ok, `loop didn't converge: ${r.error}\ntrail: ${JSON.stringify(r.trail, null, 2)}`).toBe(true);
      // The model should have used a read tool to discover the
      // error class — without it the only path to success is a
      // lucky guess at the import path.
      const usedReadTool = r.trail.some(
        (t) => t.tool === "read_file" || t.tool === "list_files",
      );
      expect(usedReadTool, "expected the model to call read_file or list_files").toBe(true);

      // Final verification: run the test against the body the loop
      // produced, in a FRESH harness directory (the dev loop's
      // run_test calls have already filled `workDir` with state).
      // Catches "model claimed done but the body is wrong" — the
      // orchestrator's outer loop normally runs this verify.
      const verifyWorkDir = await createHarnessDir();
      await linkHostNodeModules(verifyWorkDir, process.cwd());
      try {
        const verify = await runTests(rpg, {
          bodyByLeafId: new Map([["cap:validate", r.body!]]),
          testsByLeafId: new Map([["cap:validate", TEST_SRC]]),
          leafIds: ["cap:validate"],
          workDir: verifyWorkDir,
        });
        expect(
          verify.ok,
          `verify run failed.\nbyLeaf: ${JSON.stringify([...verify.byLeaf.entries()], null, 2)}\nfatal: ${verify.fatal ?? "(none)"}\nbody:\n${r.body}`,
        ).toBe(true);
      } finally {
        await rm(verifyWorkDir, { recursive: true, force: true });
      }
    },
  );
});
