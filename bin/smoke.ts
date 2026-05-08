#!/usr/bin/env tsx
/**
 * Manual smoke runner — `npm run smoke` or `tsx bin/smoke.ts`.
 *
 * Hits the default provider with a one-line prompt and prints the
 * response. Useful for verifying credentials and endpoint reachability
 * outside the test runner.
 */

import { loadConfig } from "../src/config.js";
import { createClient } from "../src/llm/factory.js";

const { value: config, missing } = await loadConfig();

if (missing.length > 0) {
  for (const m of missing) {
    console.error(`[smoke] missing env var $${m.name} (referenced at ${m.jsonPath || "<root>"})`);
  }
}

const providerName =
  process.argv[2] ?? config.defaultProvider ?? Object.keys(config.providers)[0];

if (!providerName || !config.providers[providerName]) {
  console.error(`[smoke] no provider: ${providerName}`);
  process.exit(2);
}

const cfg = config.providers[providerName];
if (!cfg.apiKey) {
  console.error(`[smoke] provider "${providerName}" has no API key resolved`);
  process.exit(3);
}

console.log(`[smoke] provider=${providerName} model=${cfg.model} url=${cfg.url}`);
const client = createClient(providerName, cfg);

const start = Date.now();
const res = await client.chat([
  {
    role: "user",
    content: "Reply with exactly the word: pong (no punctuation, no extras).",
  },
]);
const dt = Date.now() - start;

console.log(`[smoke] finish=${res.finishReason} took=${dt}ms`);
console.log(`[smoke] usage=${JSON.stringify(res.usage ?? {})}`);
console.log(`---\n${res.content}\n---`);
