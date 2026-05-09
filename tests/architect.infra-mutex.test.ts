/**
 * Step S3 — infra-file mutex.
 *
 * Two workers calling withInfraLock concurrently must serialize.
 * The second waits for the first to finish before starting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isInfraPath,
  withInfraLock,
  _resetInfraLockForTesting,
} from "../src/architect/infra-mutex.js";

beforeEach(() => {
  _resetInfraLockForTesting();
});

describe("isInfraPath", () => {
  it("recognizes the canonical infra files", () => {
    expect(isInfraPath("package.json")).toBe(true);
    expect(isInfraPath("tsconfig.json")).toBe(true);
    expect(isInfraPath("vitest.config.ts")).toBe(true);
    expect(isInfraPath(".env")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isInfraPath("src/a.ts")).toBe(false);
    expect(isInfraPath("README.md")).toBe(false);
    expect(isInfraPath("package-lock.json")).toBe(false);
  });
});

describe("withInfraLock", () => {
  it("serializes concurrent calls in arrival order", async () => {
    const events: string[] = [];
    const a = withInfraLock(async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
      return "a";
    });
    const b = withInfraLock(async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-end");
      return "b";
    });
    const c = withInfraLock(async () => {
      events.push("c-start");
      events.push("c-end");
      return "c";
    });
    const results = await Promise.all([a, b, c]);
    expect(results).toEqual(["a", "b", "c"]);
    // Strict order: each must end before the next begins.
    expect(events).toEqual([
      "a-start", "a-end",
      "b-start", "b-end",
      "c-start", "c-end",
    ]);
  });

  it("releases the lock when fn throws", async () => {
    const a = withInfraLock(async () => {
      throw new Error("boom");
    });
    await expect(a).rejects.toThrow(/boom/);
    // Subsequent calls must still acquire the lock.
    const b = await withInfraLock(async () => "ok");
    expect(b).toBe("ok");
  });

  it("returns the inner value", async () => {
    const r = await withInfraLock(async () => 42);
    expect(r).toBe(42);
  });

  it("classic lost-update race is prevented (load → modify → save)", async () => {
    // Simulate two workers both incrementing a counter held in
    // a shared object. Without the mutex one update would clobber
    // the other.
    const shared = { count: 0 };
    const slowReader = async (): Promise<number> => {
      const snapshot = shared.count;
      // Yield — gives the other worker a chance to interleave.
      await new Promise((r) => setTimeout(r, 5));
      return snapshot;
    };
    await Promise.all([
      withInfraLock(async () => {
        const c = await slowReader();
        shared.count = c + 1;
      }),
      withInfraLock(async () => {
        const c = await slowReader();
        shared.count = c + 1;
      }),
    ]);
    expect(shared.count).toBe(2);
  });
});
