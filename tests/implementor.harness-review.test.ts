/**
 * Phase 6 harness/leaf review-fix acceptance:
 *
 *   #1 `runTests({ timeoutMs })` kills the spawned vitest after the
 *      deadline and surfaces a `fatal` describing the timeout.
 *   #2 When `runTests` throws on an internal error, the temp work
 *      directory is still cleaned up (no leaks).
 *   #9 `outcomeForLeaf(result, leafId)` returns the per-leaf outcome
 *      keyed by the original capability id, hiding the slug detail.
 *  #10 Body-author retry prompt explicitly mentions an empty previous
 *      response when the prior attempt produced nothing.
 *  #11 `extractJsonObject` correctly skips escaped backslash + quote
 *      sequences inside strings.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rm, mkdtemp } from "node:fs/promises";
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
  outcomeForLeaf,
  runTests,
} from "../src/implementor/index.js";
import { makeRoleAwareClient } from "./helpers/mock-implementor-client.js";

let workDir: string;

beforeAll(async () => {
  workDir = await createHarnessDir();
  await linkHostNodeModules(workDir, process.cwd());
}, 30_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function buildSampleRpg(): { rpg: RPG; hostFile: FileNode; leafId: string } {
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

  const leafId = "cap:hang";
  const file: FileNode = {
    id: "file:src/hang.ts",
    kind: "file",
    name: "hang.ts",
    parent: "folder:src",
    children: [],
    features: [],
    path: "src/hang.ts",
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
          name: "hangForever",
          signature: { params: [], returnType: "void", isAsync: true },
          description: "Loops forever — the test should time out.",
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

describe("review fix #1 — runTests honors a wall-clock timeout", () => {
  it(
    "kills the spawned process and reports fatal when timeoutMs elapses",
    { timeout: 30_000 },
    async () => {
      const { rpg, leafId } = buildSampleRpg();
      const result = await runTests(rpg, {
        bodyByLeafId: new Map([
          [leafId, "while (true) { /* infinite loop */ }"],
        ]),
        testsByLeafId: new Map([
          [
            leafId,
            `import { describe, it, expect } from "vitest";
import { hangForever } from "../../src/hang.js";

describe("hangForever", () => {
  it("never returns", async () => {
    await hangForever();
    expect(true).toBe(true);
  });
});
`,
          ],
        ]),
        workDir,
        timeoutMs: 5_000,
      });
      expect(result.ok).toBe(false);
      expect(result.fatal ?? "").toMatch(/timed out|timeout/i);
    },
  );
});

describe("review fix #2 — runTests cleans the work dir on exceptions", () => {
  it(
    "rm-rfs the temp directory even when spawn fails",
    { timeout: 15_000 },
    async () => {
      const { rpg, leafId } = buildSampleRpg();
      // Force the harness to own its own dir + use an unresolvable
      // command so spawn rejects.
      const result = await runTests(rpg, {
        bodyByLeafId: new Map([[leafId, "return;"]]),
        testsByLeafId: new Map(),
        npxBinary: "command-that-does-not-exist-anywhere",
      } as any);
      expect(result.ok).toBe(false);
      expect(result.fatal).toBeTruthy();
      // Temp dir should not exist anymore.
      const fs = await import("node:fs/promises");
      const exists = await fs
        .stat(result.workDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    },
  );
});

describe("review fix #9 — outcomeForLeaf hides slug detail", () => {
  it(
    "returns the per-leaf outcome keyed by the original capability id",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile, leafId } = buildSampleRpg();
      hostFile.interfacePlan!.entries[0]!.signature.isAsync = false;
      const result = await runTests(rpg, {
        bodyByLeafId: new Map([[leafId, "return;"]]),
        testsByLeafId: new Map([
          [
            leafId,
            `import { describe, it, expect } from "vitest";
import { hangForever } from "../../src/hang.js";

describe("hangForever", () => {
  it("returns void", () => {
    expect(hangForever()).toBeUndefined();
  });
});
`,
          ],
        ]),
        workDir,
      });
      expect(result.ok, result.fatal).toBe(true);
      const outcome = outcomeForLeaf(result, leafId);
      expect(outcome).toBeDefined();
      expect(outcome!.ok).toBe(true);
    },
  );
});

describe("review fix #10 — empty body retry mentions emptiness", () => {
  it(
    "second attempt prompt explicitly notes the previous response was empty",
    { timeout: 60_000 },
    async () => {
      const { rpg, hostFile } = buildSampleRpg();
      hostFile.interfacePlan!.entries[0]!.signature.isAsync = false;
      const mock = makeRoleAwareClient({
        testAuthorResponses: [
          `import { describe, it, expect } from "vitest";
import { hangForever } from "../../src/hang.js";
describe("hangForever", () => { it("ok", () => { expect(hangForever()).toBeUndefined(); }); });
`,
        ],
        // First body call: empty (forces empty-retry path).
        // Second body call: real body.
        bodyAuthorResponses: ["", "return;"],
      });
      const { client, bodyAuthorCalls } = mock;

      const tmpRunDir = await mkdtemp(path.join(tmpdir(), "leaf-empty-"));
      await linkHostNodeModules(tmpRunDir, process.cwd());
      try {
        const r = await implementLeaf(client, {
          leaf: hostFile.interfacePlan!.entries[0]!,
          hostFile,
          rpg,
          bodyByLeafId: new Map(),
          testsByLeafId: new Map(),
          workDir: tmpRunDir,
          maxAttempts: 2,
        });
        expect(r.ok, r.fatal ?? r.lastFailure?.failureMessage ?? "").toBe(true);
        // The 2nd body call's prompt should mention the previous
        // response was empty.
        const bodyCalls = bodyAuthorCalls();
        expect(bodyCalls.length).toBeGreaterThanOrEqual(2);
        const retryPrompt = bodyCalls[1]!.messages.at(-1)?.content ?? "";
        expect(retryPrompt).toMatch(/empty/i);
      } finally {
        await rm(tmpRunDir, { recursive: true, force: true });
      }
    },
  );
});

describe("review fix #11 — extractJsonObject handles escape sequences", () => {
  it("does not get fooled by escaped quotes/backslashes inside strings", async () => {
    const { extractJsonObject } = await import(
      "../src/implementor/test-harness.js"
    );
    const tricky = String.raw`prefix noise {"value":"quote \"inner\" + backslash \\"} trailing`;
    const out = extractJsonObject(tricky);
    expect(out).toBe(String.raw`{"value":"quote \"inner\" + backslash \\"}`);
    const parsed = JSON.parse(out!);
    expect(parsed.value).toBe(`quote "inner" + backslash \\`);
  });
});
