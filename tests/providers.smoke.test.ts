/**
 * Phase 0 acceptance test.
 *
 * For every provider declared in config.json whose env vars are set,
 * make a tiny round-trip and assert non-empty content.
 *
 * Providers whose env vars are missing are skipped with a console
 * note rather than failing the suite — this lets local devs run the
 * test with whichever subset of credentials they have.
 */

import { describe, it, expect } from "vitest";
import { loadConfig, missingForPath } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";

const config = await loadConfig();

const providerNames = Object.keys(config.value.providers);

if (providerNames.length === 0) {
  describe("providers smoke", () => {
    it.skip("no providers configured", () => {});
  });
}

for (const name of providerNames) {
  const cfg = config.value.providers[name]!;
  const missingForThis = missingForPath(config, `providers.${name}`);
  const apiKeyResolved = cfg.apiKey && cfg.apiKey.length > 0;

  describe(`provider: ${name}`, () => {
    if (!apiKeyResolved) {
      const missing = missingForThis.map((m) => m.name).join(", ") || "?";
      it.skip(`skipped — no API key resolved (missing env: ${missing})`, () => {});
      return;
    }

    it(
      "returns non-empty content for a trivial prompt",
      { timeout: 60_000 },
      async () => {
        const client = createClient(name, cfg);
        const res = await client.chat([
          {
            role: "user",
            content:
              "Reply with exactly the word: pong (no punctuation, no extra text).",
          },
        ]);
        expect(res.content.trim().length).toBeGreaterThan(0);
        expect(res.finishReason).toBeTruthy();
      },
    );
  });
}
