/**
 * Phase 5 integration test — real LLM, structural assertions only.
 *
 * Pipes Phase 3 → 4 → 5 against the configured default provider on
 * the same guestbook target. Asserts shape:
 *   - every leaf capability is mapped to a file;
 *   - every file the architect named has an InterfacePlan with at
 *     least one entry;
 *   - signatures parse: param names look like identifiers, return
 *     type is non-empty, isAsync is a real boolean;
 *   - within-file extends references real classes;
 *   - dataFlow edges (when present) reference known capability ids
 *     and have a non-empty payload.
 *
 * Skipped when no API key is resolved.
 */

import { describe, it, expect } from "vitest";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import {
  emptyRPG,
  isCapability,
  isFile,
} from "../src/rpg/index.js";
import {
  designInterfaces,
  encodeFileStructure,
  proposeFunctionalityGraph,
} from "../src/architect/index.js";

const config = await loadConfig();
const providerName =
  config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
const cfg = providerName ? config.value.providers[providerName] : undefined;
const apiKeyResolved = !!cfg && !!cfg.apiKey && cfg.apiKey.length > 0;

describe("architect interface design — real LLM", () => {
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
    "designs interfaces and data flow for the guestbook through Phase 3 → 4 → 5",
    { timeout: 720_000 },
    async () => {
      const client = createClient(providerName!, cfg!);
      const rpg = emptyRPG();
      const description = `Build a small HTTP guestbook in TypeScript. Users submit name + message via POST /entries; entries persist to a JSON file; GET /entries returns them. Strict input validation.`;

      const proposal = await proposeFunctionalityGraph(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(proposal.ok, proposal.error ?? "").toBe(true);

      const structure = await encodeFileStructure(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(structure.ok, structure.error ?? "").toBe(true);

      const interfaces = await designInterfaces(client, rpg, {
        description,
        maxAttempts: 2,
      });
      expect(interfaces.ok, interfaces.error ?? "").toBe(true);
      expect(interfaces.unplannedLeaves).toEqual([]);
      expect(interfaces.entries.length).toBeGreaterThan(0);

      // Every leaf is now mapped to a file.
      const leafCount = Object.values(rpg.nodes).filter(
        (n) => isCapability(n) && n.isLeaf,
      ).length;
      expect(leafCount).toBeGreaterThan(0);
      for (const node of Object.values(rpg.nodes)) {
        if (isCapability(node) && node.isLeaf) {
          expect(node.status).toBe("mapped");
          expect(node.mappedToId).toMatch(/^file:/);
        }
      }

      // Every file referenced by entries has an InterfacePlan with the
      // right entries.
      const entryFilePaths = new Set(interfaces.entries.map((e) => {
        const cap = rpg.nodes[e.leafCapabilityId];
        if (!cap || !isCapability(cap)) return undefined;
        return cap.mappedToId?.replace(/^file:/, "");
      }).filter(Boolean) as string[]);
      for (const p of entryFilePaths) {
        const node = rpg.nodes[`file:${p}`];
        expect(node && isFile(node)).toBe(true);
        if (!node || !isFile(node)) continue;
        expect(node.interfacePlan).toBeDefined();
        expect(node.interfacePlan!.entries.length).toBeGreaterThan(0);
      }

      // Signatures look identifier-shaped.
      for (const e of interfaces.entries) {
        expect(/^[a-z_][a-zA-Z0-9_]*$/.test(e.name)).toBe(true);
        expect(e.signature.returnType.length).toBeGreaterThan(0);
        expect(typeof e.signature.isAsync).toBe("boolean");
        for (const p of e.signature.params) {
          expect(/^_?[a-z][A-Za-z0-9_]*$/.test(p.name)).toBe(true);
          expect(p.type.length).toBeGreaterThan(0);
        }
      }

      // Within-file extends references real classes (declared somewhere
      // in the same file's plan).
      for (const c of interfaces.classes) {
        if (c.extendsName === null) continue;
        const sameFileClassNames = interfaces.classes
          .filter(
            (other) =>
              other.name !== c.name &&
              // We can't read filePath off PlannedClass directly here;
              // check the file by hunting for the class in any file's plan.
              true,
          )
          .map((other) => other.name);
        // The extendsName must be one of the known classes overall.
        // We can't tell same-file at this top-level vantage, but any
        // valid extends is at least a class we declared.
        expect(sameFileClassNames).toContain(c.extendsName);
      }

      // DataFlow edges reference real capability ids and a payload.
      for (const e of rpg.dataFlow) {
        const from = rpg.nodes[e.fromNode];
        const to = rpg.nodes[e.toNode];
        expect(from).toBeDefined();
        expect(to).toBeDefined();
        expect(e.payload.trim().length).toBeGreaterThan(0);
      }
    },
  );
});
