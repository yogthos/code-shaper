/**
 * Disk-quota watchdog tests.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startDiskQuotaWatch } from "../src/server/disk-quota.js";

describe("disk-quota watchdog", () => {
  it("fires onBreach once when path size exceeds maxBytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "quota-"));
    try {
      // Pre-fill 100 KB so the first sample already exceeds the
      // very-low quota of 50 KB.
      await writeFile(path.join(dir, "big.bin"), Buffer.alloc(100 * 1024));
      let breachedAt = 0;
      let breachCount = 0;
      const handle = startDiskQuotaWatch({
        path: dir,
        maxBytes: 50 * 1024,
        pollMs: 50,
        onBreach: (bytes) => {
          breachCount++;
          breachedAt = bytes;
        },
      });
      // Wait long enough for the first immediate sample to land.
      await new Promise((r) => setTimeout(r, 250));
      handle.stop();
      expect(breachCount).toBe(1);
      expect(breachedAt).toBeGreaterThanOrEqual(50 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("doesn't fire onBreach when path stays under quota", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "quota-"));
    try {
      await writeFile(path.join(dir, "small.bin"), Buffer.alloc(1024));
      let breached = false;
      const handle = startDiskQuotaWatch({
        path: dir,
        maxBytes: 100 * 1024,
        pollMs: 30,
        onBreach: () => {
          breached = true;
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      handle.stop();
      expect(breached).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("probe() returns the current size in bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "quota-"));
    try {
      await writeFile(path.join(dir, "x.bin"), Buffer.alloc(8 * 1024));
      const handle = startDiskQuotaWatch({
        path: dir,
        maxBytes: 1024 * 1024 * 1024,
        pollMs: 100_000, // never auto-fires during the test
        onBreach: () => {},
      });
      const bytes = await handle.probe();
      handle.stop();
      // du rounds up to the filesystem block size; 8 KB file might
      // report anywhere from 8 KB to ~12 KB depending on inode
      // overhead and HFS/APFS block size. Just sanity-check non-zero
      // and at-least-roughly the file size.
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(64 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stop() halts further sampling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "quota-"));
    try {
      let samples = 0;
      const handle = startDiskQuotaWatch({
        path: dir,
        maxBytes: 1024 * 1024 * 1024,
        pollMs: 30,
        onBreach: () => {},
        onSample: () => {
          samples++;
        },
      });
      await new Promise((r) => setTimeout(r, 100));
      const beforeStop = samples;
      handle.stop();
      await new Promise((r) => setTimeout(r, 150));
      // No new samples should arrive after stop.
      expect(samples).toBe(beforeStop);
      expect(beforeStop).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
