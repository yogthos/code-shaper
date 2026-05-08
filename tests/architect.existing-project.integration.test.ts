/**
 * Existing-project pipeline integration test — real LLM.
 *
 * Loads tests/fixtures/sample-repo via loadRepo (it has db.ts,
 * server.ts, mixed.ts, util.ts, plus the "test-build/" segment that
 * exercises the segment-only ignore rule). Then asks the architect to
 * extend it with a single new feature, runs Phases 3 → 4 → 5 in extend
 * mode, then the refactor pass.
 *
 * Asserts:
 *   - existing files are still present after the run (extend mode
 *     doesn't delete or move them);
 *   - their content is byte-identical to the loaded original;
 *   - the new capability got added (architect saw the existing
 *     structure);
 *   - the refactor pass either left things alone (conservative
 *     default) or proposed sound restructuring that applied cleanly.
 *
 * Skipped when no API key is resolved.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import {
  isCapability,
  isFile,
  loadRepo,
  type FileNode,
  type RPG,
} from "../src/rpg/index.js";
import {
  designInterfaces,
  encodeFileStructure,
  proposeFunctionalityGraph,
  runRefactorPass,
} from "../src/architect/index.js";

const FIXTURE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/sample-repo",
);

const config = await loadConfig();
const providerName =
  config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
const cfg = providerName ? config.value.providers[providerName] : undefined;
const apiKeyResolved = !!cfg && !!cfg.apiKey && cfg.apiKey.length > 0;

interface FileSnapshot {
  path: string;
  content: string;
  exports: string[];
}

function snapshotFiles(rpg: RPG): FileSnapshot[] {
  const out: FileSnapshot[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (!isFile(node)) continue;
    out.push({
      path: node.path,
      content: node.content,
      exports: [...node.exports],
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

describe("existing-project pipeline — real LLM", () => {
  if (!apiKeyResolved) {
    const missing =
      providerName !== undefined
        ? missingForPath(config, `providers.${providerName}`)
            .map((m) => m.name)
            .join(", ")
        : "?";
    it.skip(
      `skipped — no API key resolved (missing env: ${missing || "?"})`,
      () => {},
    );
    return;
  }

  it(
    "extends an existing repo without disturbing its current files",
    { timeout: 900_000 },
    async () => {
      const rpg = await loadRepo(FIXTURE);
      const before = snapshotFiles(rpg);
      expect(before.length).toBeGreaterThan(0);

      const description = `Extend this existing TypeScript guestbook with a CSV export feature: a new exported function "exportEntriesToCsv" that takes the guestbook entries and returns a CSV string. The new code must integrate with the existing "GuestbookDb" class in src/db.ts where appropriate, but should not break or rename any existing exports.`;

      const client = createClient(providerName!, cfg!);

      const proposal = await proposeFunctionalityGraph(client, rpg, {
        description,
        mode: "extend",
        maxAttempts: 2,
      });
      expect(proposal.ok, proposal.error ?? "").toBe(true);
      expect(proposal.attachedRootIds.length).toBeGreaterThan(0);

      const structure = await encodeFileStructure(client, rpg, {
        description,
        mode: "extend",
        maxAttempts: 2,
      });
      expect(structure.ok, structure.error ?? "").toBe(true);

      const interfaces = await designInterfaces(client, rpg, {
        description,
        mode: "extend",
        maxAttempts: 2,
      });
      expect(interfaces.ok, interfaces.error ?? "").toBe(true);

      const refactor = await runRefactorPass(client, rpg, {
        description,
        mode: "extend",
        maxAttempts: 2,
      });
      expect(refactor.ok, refactor.error ?? "").toBe(true);
      // Conservative: most likely zero ops on a small repo. If the LLM
      // proposed any, the apply layer must have validated them.
      if (refactor.applyReport) {
        expect(refactor.applyReport.ok).toBe(true);
      }

      // Existing files are still present and their content is byte-
      // identical to what loadRepo produced.
      const after = snapshotFiles(rpg);
      const beforePaths = new Set(before.map((f) => f.path));
      const afterPaths = new Set(after.map((f) => f.path));
      for (const p of beforePaths) {
        expect(afterPaths.has(p), `existing file dropped: ${p}`).toBe(true);
      }
      for (const f of before) {
        const post = after.find((x) => x.path === f.path);
        if (!post) continue; // covered above
        // Refactor ops may have moved files; if the path is unchanged
        // we expect content + exports unchanged.
        if (afterPaths.has(f.path)) {
          expect(post.content, `content drift in ${f.path}`).toBe(f.content);
          expect(post.exports, `exports drift in ${f.path}`).toEqual(f.exports);
        }
      }

      // At least one new capability or new file/plan exists.
      const newPaths = [...afterPaths].filter((p) => !beforePaths.has(p));
      const newCapabilities = Object.values(rpg.nodes).filter(
        (n): n is import("../src/rpg/index.js").CapabilityNode =>
          isCapability(n),
      );
      expect(newCapabilities.length).toBeGreaterThan(0);
      // Either a new file appeared or an existing file's interface plan
      // was extended (set via Phase 5 + apply).
      const planAttached = Object.values(rpg.nodes).some(
        (n): n is FileNode => isFile(n) && !!n.interfacePlan,
      );
      expect(newPaths.length > 0 || planAttached).toBe(true);
    },
  );
});
