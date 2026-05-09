/**
 * Step U1: per-file mutex.
 *
 * Generalizes withInfraLock to withFileLock(path, fn) — locks
 * keyed by repo-relative path. Edits to different files run in
 * parallel; edits to the same file serialize.
 *
 * The previous infra-mutex was a single global lock for
 * package.json/tsconfig.json/etc. The new model: ANY file can
 * be edited by ANY worker, and the per-file lock prevents
 * races without serializing the whole process.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  withFileLock,
  _resetFileLocksForTesting,
} from "../src/architect/file-lock.js";

beforeEach(() => {
  _resetFileLocksForTesting();
});

describe("withFileLock", () => {
  it("serializes concurrent calls on the SAME path", async () => {
    const events: string[] = [];
    const a = withFileLock("package.json", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
      return "a";
    });
    const b = withFileLock("package.json", async () => {
      events.push("b-start");
      events.push("b-end");
      return "b";
    });
    const results = await Promise.all([a, b]);
    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs concurrent calls on DIFFERENT paths in parallel", async () => {
    const events: string[] = [];
    const a = withFileLock("src/a.ts", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
      return "a";
    });
    const b = withFileLock("src/b.ts", async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("b-end");
      return "b";
    });
    const results = await Promise.all([a, b]);
    expect(results).toEqual(["a", "b"]);
    // Both starts MUST come before either end — proves overlap.
    expect(events.indexOf("a-start")).toBeLessThan(events.indexOf("a-end"));
    expect(events.indexOf("b-start")).toBeLessThan(events.indexOf("b-end"));
    expect(events.indexOf("a-start")).toBeLessThan(events.indexOf("b-end"));
    expect(events.indexOf("b-start")).toBeLessThan(events.indexOf("a-end"));
  });

  it("releases the lock when fn throws", async () => {
    await expect(
      withFileLock("file.txt", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    // Subsequent same-file call still works.
    const r = await withFileLock("file.txt", async () => "ok");
    expect(r).toBe("ok");
  });

  it("returns the inner value", async () => {
    const r = await withFileLock("x", async () => 42);
    expect(r).toBe(42);
  });

  it("classic lost-update race is prevented for same-file edits", async () => {
    const shared = { count: 0 };
    const slowReader = async (): Promise<number> => {
      const snapshot = shared.count;
      await new Promise((r) => setTimeout(r, 5));
      return snapshot;
    };
    await Promise.all([
      withFileLock("package.json", async () => {
        const c = await slowReader();
        shared.count = c + 1;
      }),
      withFileLock("package.json", async () => {
        const c = await slowReader();
        shared.count = c + 1;
      }),
    ]);
    expect(shared.count).toBe(2);
  });
});
