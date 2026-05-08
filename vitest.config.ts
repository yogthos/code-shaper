import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Defaults pick up `**/*.test.ts` everywhere — but
    // `demo/todomvc-harness/` and `demo/todomvc-baseline/` carry
    // generated test files from the comparison runs (sometimes
    // half-written, sometimes empty stubs from a killed run) and
    // they should NOT be picked up by the harness's own test
    // suite. Same for any cached or temp dirs.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "demo/**", "dist/**"],
  },
});
