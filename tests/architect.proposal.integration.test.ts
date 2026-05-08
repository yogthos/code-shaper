/**
 * Phase 3 integration test — real LLM, structural assertions only.
 *
 * Runs the proposal-level architect against the configured default
 * provider on a small known target (a guestbook app, which is small
 * enough that the plan should reliably contain "server"-y and
 * "persistence"-y modules). We assert *shape* only — not specific
 * names — because the LLM is non-deterministic.
 *
 * Skipped when the configured default provider has no resolved API
 * key, mirroring the smoke-test pattern.
 */

import { describe, it, expect } from "vitest";

import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";
import { emptyRPG, isCapability } from "../src/rpg/index.js";
import { proposeFunctionalityGraph } from "../src/architect/index.js";

const config = await loadConfig();
const providerName =
  config.value.defaultProvider ?? Object.keys(config.value.providers)[0];
const cfg = providerName ? config.value.providers[providerName] : undefined;
const apiKeyResolved = !!cfg && !!cfg.apiKey && cfg.apiKey.length > 0;

describe("architect proposal — real LLM", () => {
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
    "produces a structurally valid plan for a guestbook app",
    { timeout: 120_000 },
    async () => {
      const client = createClient(providerName!, cfg!);
      const rpg = emptyRPG();
      const result = await proposeFunctionalityGraph(client, rpg, {
        description: `Build a small HTTP guestbook in TypeScript. Users can submit a name and a message via POST /entries. The server stores entries in a JSON file on disk and serves a GET /entries endpoint that returns them as JSON. Include input validation that rejects empty names or messages longer than 1000 characters.`,
        maxAttempts: 2,
      });

      expect(result.ok, result.error ?? "no error").toBe(true);
      if (!result.ok) return;
      expect(result.attempts).toBeLessThanOrEqual(2);

      // Structural shape, not specific content.
      // 3-7 root capabilities per the prompt's guidelines.
      expect(result.attachedRootIds.length).toBeGreaterThanOrEqual(3);
      expect(result.attachedRootIds.length).toBeLessThanOrEqual(7);

      // At least one node should have children (a non-trivial tree).
      const hasNonLeaf = result.attachedRootIds.some((id) => {
        const n = rpg.nodes[id];
        return n && isCapability(n) && !n.isLeaf;
      });
      expect(hasNonLeaf).toBe(true);

      // Total node count exceeds root count (some children exist).
      expect(result.totalNodesAdded).toBeGreaterThan(result.attachedRootIds.length);

      // Every capability has a non-empty description (validation enforced).
      let capCount = 0;
      for (const node of Object.values(rpg.nodes)) {
        if (isCapability(node)) {
          capCount++;
          expect(node.description.trim().length).toBeGreaterThan(0);
          expect(node.name.trim().length).toBeGreaterThan(0);
          expect(node.status).toBe("planned");
          expect(node.mappedToId).toBeNull();
        }
      }
      expect(capCount).toBe(result.totalNodesAdded);
    },
  );
});
