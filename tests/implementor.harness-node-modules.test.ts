/**
 * resolveNodeModulesSource — picks outDir over host when outDir has
 * vitest installed, falls back to host (or cwd) otherwise. Validates
 * the env-fix-visibility fix.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveNodeModulesSource } from "../src/implementor/test-harness.js";

let outDir: string;
let hostRepo: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "harness-out-"));
  hostRepo = await mkdtemp(path.join(tmpdir(), "harness-host-"));
});

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
  if (hostRepo) await rm(hostRepo, { recursive: true, force: true });
});

async function pretendVitestInstalled(repo: string): Promise<void> {
  const vitestDir = path.join(repo, "node_modules", "vitest");
  await mkdir(vitestDir, { recursive: true });
  await writeFile(
    path.join(vitestDir, "package.json"),
    JSON.stringify({ name: "vitest", version: "2.0.0" }),
  );
}

describe("resolveNodeModulesSource", () => {
  it("prefers outDir when its node_modules contains vitest", async () => {
    await pretendVitestInstalled(outDir);
    expect(resolveNodeModulesSource(outDir, hostRepo)).toBe(outDir);
  });

  it("falls back to hostRepo when outDir has no node_modules", () => {
    expect(resolveNodeModulesSource(outDir, hostRepo)).toBe(hostRepo);
  });

  it("falls back to hostRepo when outDir has node_modules but no vitest", async () => {
    await mkdir(path.join(outDir, "node_modules"), { recursive: true });
    // node_modules exists but vitest doesn't — env-fix may have
    // half-installed. Don't assume vitest is there.
    expect(resolveNodeModulesSource(outDir, hostRepo)).toBe(hostRepo);
  });

  it("falls back to process.cwd() when neither outDir nor hostRepo are usable", () => {
    expect(resolveNodeModulesSource(undefined, undefined)).toBe(process.cwd());
  });

  it("respects an explicit hostRepo when outDir is undefined", () => {
    expect(resolveNodeModulesSource(undefined, hostRepo)).toBe(hostRepo);
  });
});
