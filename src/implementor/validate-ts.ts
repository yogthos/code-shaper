/**
 * Tree-sitter-backed TypeScript source validator.
 *
 * Used by the implementor's test-author and body-author paths to
 * reject obviously-malformed LLM output BEFORE we hand it to vitest
 * (where the same problem surfaces as a confusing suite-level
 * failure with no per-leaf attribution).
 *
 * Reuses the registered TypeScript language adapter so we don't pay
 * a second tree-sitter init.
 */

import { getAdapterByLanguage } from "../rpg/adapters/index.js";

export interface ValidateTsResult {
  ok: boolean;
  /** Concise error message describing what went wrong. Empty when
   *  ok=true. */
  error: string;
}

/** Parse `source` as TypeScript and return a validation result.
 *  Adapter-driven so the same parser the rest of the codebase uses
 *  is the one validating LLM output — no surprises.
 *
 *  Treats the source as a complete `.ts` module body. To validate a
 *  bare function body (no module wrapper) wrap it in a function
 *  declaration first. */
export function validateTypeScriptSource(source: string): ValidateTsResult {
  const adapter = getAdapterByLanguage("typescript");
  if (!adapter) {
    // No adapter registered — refuse rather than silently pass. The
    // implementor flow imports the adapter index at startup, so this
    // branch should never fire in normal runs.
    return {
      ok: false,
      error: "no typescript adapter registered; cannot validate source",
    };
  }
  // Use a synthetic file path so the adapter picks the typescript
  // language; the path doesn't have to exist on disk.
  const result = adapter.extract({
    fileId: "<validate>",
    filePath: "validate.ts",
    source,
  });
  const parseError = (result.warnings ?? []).find(
    (w) => w.kind === "parse-error",
  );
  if (parseError) {
    return { ok: false, error: parseError.message };
  }
  return { ok: true, error: "" };
}
