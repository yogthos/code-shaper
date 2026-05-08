/**
 * Acceptance tests for the config loader's env-var interpolation,
 * including review fix #9 — per-provider missing-var attribution.
 */

import { describe, it, expect } from "vitest";
import { interpolateConfig, missingForPath } from "../src/config.js";

describe("config interpolation", () => {
  it("interpolates ${VAR} from a synthetic env", () => {
    const env = { ZHIPU_API_KEY: "abc", DEEPSEEK_API_KEY: "xyz" } as NodeJS.ProcessEnv;
    const result = interpolateConfig(
      {
        providers: {
          glm: { url: "u1", apiKey: "${ZHIPU_API_KEY}", model: "m1" },
          deepseek: { url: "u2", apiKey: "${DEEPSEEK_API_KEY}", model: "m2" },
        },
      },
      env,
    );
    expect(result.value.providers.glm!.apiKey).toBe("abc");
    expect(result.value.providers.deepseek!.apiKey).toBe("xyz");
    expect(result.missing).toEqual([]);
  });

  it("attributes a missing var to its JSON path", () => {
    const env = { OTHER: "x" } as NodeJS.ProcessEnv;
    const result = interpolateConfig(
      {
        providers: {
          glm: { url: "u", apiKey: "${MISSING_KEY}", model: "m" },
          good: { url: "u", apiKey: "${OTHER}", model: "m" },
        },
      },
      env,
    );
    expect(result.missing).toEqual([
      { name: "MISSING_KEY", jsonPath: "providers.glm.apiKey" },
    ]);
    // missingForPath narrows to a single provider's tree.
    expect(missingForPath(result, "providers.glm").map((m) => m.name)).toEqual([
      "MISSING_KEY",
    ]);
    expect(missingForPath(result, "providers.good")).toEqual([]);
  });
});
