/**
 * Phase 4 integration test — real LLM, structural assertions only.
 *
 * Pipes Phase 3 → Phase 4 against the configured default provider on
 * the same guestbook target. We assert *shape only*:
 *   - every non-leaf capability gets a folder or file path;
 *   - all paths are repo-relative, no traversal, file extensions
 *     within the registered adapter set;
 *   - top-level capabilities became folders, not files;
 *   - the materialized RPG round-trips (folders + empty files write
 *     to disk, reload produces matching structure).
 *
 * Skipped when the configured default provider has no resolved API
 * key, mirroring the pattern from the proposal integration test.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import {
  emptyRPG,
  isCapability,
  isFile,
  isFolder,
  loadRepo,
  materializeRPG,
} from "../src/rpg/index.js";
import {
  encodeFileStructure,
  proposeFunctionalityGraph,
} from "../src/architect/index.js";

const config = await loadConfig();
const providerName =
  config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
const cfg = providerName ? config.value.providers[providerName] : undefined;
const apiKeyResolved = !!cfg && !!cfg.apiKey && cfg.apiKey.length > 0;

const ALLOWED_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

describe("architect file-structure — real LLM", () => {
  if (!apiKeyResolved) {
    const missing =
      providerName !== undefined
        ? missingForPath(config, `providers.${providerName}`)
            .map((m) => m.name)
            .join(", ")
        : "?";
    it.skip(
      `skipped — no API key resolved for default provider (missing env: ${missing || "?"})`,
      () => {},
    );
    return;
  }

  it(
    "maps the guestbook capability tree to a coherent folder/file structure that round-trips",
    { timeout: 240_000 },
    async () => {
      const client = createClient(providerName!, cfg!);
      const rpg = emptyRPG();

      // Phase 3.
      const description = `Build a small HTTP guestbook in TypeScript. Users submit name + message via POST /entries; entries persist to a JSON file; GET /entries returns them. Strict input validation.`;
      const proposal = await proposeFunctionalityGraph(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(proposal.ok, proposal.error ?? "no proposal").toBe(true);

      // Phase 4.
      const structure = await encodeFileStructure(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(structure.ok, structure.error ?? "no structure").toBe(true);
      expect(structure.attempts).toBeLessThanOrEqual(2);
      expect(structure.unmappedRequired).toEqual([]);

      // Every non-leaf capability is now mapped.
      let mappedCount = 0;
      const topLevelCapIds = new Set<string>();
      const root = rpg.nodes[rpg.rootId];
      if (root && isFolder(root)) {
        for (const childId of root.children) topLevelCapIds.add(childId);
      }
      for (const node of Object.values(rpg.nodes)) {
        if (!isCapability(node)) continue;
        if (node.isLeaf) continue;
        expect(node.status, `cap ${node.name} unmapped`).toBe("mapped");
        expect(node.mappedToId).toBeTruthy();
        mappedCount++;

        const target = rpg.nodes[node.mappedToId!];
        expect(target).toBeDefined();
        if (!target) continue;
        // Top-level capabilities must be folders. Deeper non-leaves
        // can be either folders or files at the architect's discretion.
        if (topLevelCapIds.has(node.id)) {
          expect(target.kind).toBe("folder");
        } else {
          expect(["folder", "file"]).toContain(target.kind);
        }
      }
      expect(mappedCount).toBeGreaterThan(0);

      // Every materialized file path passes the same validation we
      // enforce in the validator: relative, no "..", known extension.
      for (const node of Object.values(rpg.nodes)) {
        if (isFile(node)) {
          expect(node.path.startsWith("/")).toBe(false);
          expect(node.path.includes("..")).toBe(false);
          const ext = path.extname(node.path).toLowerCase();
          expect(ALLOWED_EXTS.has(ext)).toBe(true);
        } else if (isFolder(node) && node.path !== "") {
          expect(node.path.startsWith("/")).toBe(false);
          expect(node.path.includes("..")).toBe(false);
        }
      }

      // Round-trip: materialize empty files + folders to disk, then
      // reload — structural folders/files must match. Files have
      // empty content; the loader reads them as zero-length sources.
      const tmp = await mkdtemp(path.join(tmpdir(), "phase4-int-"));
      try {
        await materializeRPG(rpg, tmp);
        const reloaded = await loadRepo(tmp);
        const expected = collectFsPaths(rpg);
        const observed = collectFsPaths(reloaded);
        expect(observed).toEqual(expected);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
});

function collectFsPaths(rpg: ReturnType<typeof emptyRPG>): {
  folders: string[];
  files: string[];
} {
  const folders: string[] = [];
  const files: string[] = [];
  for (const node of Object.values(rpg.nodes)) {
    if (isFolder(node) && node.path !== "") folders.push(node.path);
    else if (isFile(node)) files.push(node.path);
  }
  folders.sort();
  files.sort();
  return { folders, files };
}
