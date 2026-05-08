/**
 * Task table — registry + persistence + per-projectDir mutex.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTaskTable } from "../src/server/task-table.js";
import type { TaskRecord } from "../src/server/types.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "server-state-"));
});

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

async function makeProjectDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "proj-"));
  return d;
}

describe("task table — registry", () => {
  it("creates a record with a fresh id and stable startedAt", async () => {
    const t = await createTaskTable({ stateDir });
    const projectDir = await makeProjectDir();
    try {
      const record = await t.create({
        projectDir,
        task: "do the thing",
        mode: "auto",
      });
      expect(record.taskId).toMatch(/^t-[a-z0-9]{8}$/);
      expect(record.phase).toBe("queued");
      expect(record.doneAt).toBeNull();
      expect(record.pid).toBeNull();
      expect(record.startedAt).toBeGreaterThan(0);
      expect(record.logPath).toContain(record.taskId);
      expect(record.resultPath).toContain(record.taskId);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("get() returns a clone — mutating it shouldn't poison the table", async () => {
    const t = await createTaskTable({ stateDir });
    const projectDir = await makeProjectDir();
    try {
      const r = await t.create({ projectDir, task: "x", mode: "auto" });
      const fetched = t.get(r.taskId);
      expect(fetched).not.toBeNull();
      (fetched as TaskRecord).phase = "done";
      const refetched = t.get(r.taskId);
      expect(refetched!.phase).toBe("queued");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("update() applies a partial patch and persists it", async () => {
    const t = await createTaskTable({ stateDir });
    const projectDir = await makeProjectDir();
    try {
      const r = await t.create({ projectDir, task: "x", mode: "auto" });
      await t.update(r.taskId, { phase: "proposal", pid: 1234 });
      const fetched = t.get(r.taskId)!;
      expect(fetched.phase).toBe("proposal");
      expect(fetched.pid).toBe(1234);
      // Persistence: re-open from disk and verify.
      const t2 = await createTaskTable({ stateDir });
      const reloaded = t2.get(r.taskId);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.phase).toBe("proposal");
      expect(reloaded!.pid).toBe(1234);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("list() returns every record in insertion order", async () => {
    const t = await createTaskTable({ stateDir });
    const p1 = await makeProjectDir();
    const p2 = await makeProjectDir();
    try {
      const a = await t.create({ projectDir: p1, task: "a", mode: "auto" });
      const b = await t.create({ projectDir: p2, task: "b", mode: "auto" });
      const records: TaskRecord[] = t.list();
      expect(records.map((r: TaskRecord) => r.taskId)).toEqual([
        a.taskId,
        b.taskId,
      ]);
    } finally {
      await rm(p1, { recursive: true, force: true });
      await rm(p2, { recursive: true, force: true });
    }
  });
});

describe("task table — projectDir mutex", () => {
  it("acquireProjectDir is exclusive — second waiter blocks until release", async () => {
    const t = await createTaskTable({ stateDir });
    const projectDir = await makeProjectDir();
    try {
      const release = await t.acquireProjectDir(projectDir);
      let secondAcquired = false;
      const second = t.acquireProjectDir(projectDir).then(() => {
        secondAcquired = true;
      });
      // Yield a few microtasks; the second acquire must NOT have
      // resolved yet because the first hasn't released.
      await new Promise((r) => setImmediate(r));
      expect(secondAcquired).toBe(false);
      release();
      await second;
      expect(secondAcquired).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("acquireProjectDir on different dirs runs concurrently", async () => {
    const t = await createTaskTable({ stateDir });
    const p1 = await makeProjectDir();
    const p2 = await makeProjectDir();
    try {
      const release1 = await t.acquireProjectDir(p1);
      // The second acquire on a DIFFERENT dir must resolve immediately.
      const release2 = await Promise.race([
        t.acquireProjectDir(p2),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("blocked")), 200),
        ),
      ]);
      release1();
      release2();
    } finally {
      await rm(p1, { recursive: true, force: true });
      await rm(p2, { recursive: true, force: true });
    }
  });

  it("normalises projectDir paths so /a and /a/ acquire the same lock", async () => {
    const t = await createTaskTable({ stateDir });
    const projectDir = await makeProjectDir();
    try {
      const release = await t.acquireProjectDir(projectDir);
      let blocked = true;
      const second = t.acquireProjectDir(projectDir + "/").then(() => {
        blocked = false;
      });
      await new Promise((r) => setImmediate(r));
      expect(blocked).toBe(true);
      release();
      await second;
      expect(blocked).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("task table — persistence", () => {
  it("writes the registry JSON to stateDir on every mutation", async () => {
    const t = await createTaskTable({ stateDir });
    const projectDir = await makeProjectDir();
    try {
      const r = await t.create({ projectDir, task: "x", mode: "auto" });
      const indexPath = path.join(stateDir, "tasks.json");
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as { tasks: TaskRecord[] };
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0]!.taskId).toBe(r.taskId);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt index file and starts fresh", async () => {
    // Pre-write garbage.
    await mkdir(stateDir, { recursive: true });
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(stateDir, "tasks.json"), "not valid json");
    const t = await createTaskTable({ stateDir });
    expect(t.list()).toEqual([]);
  });
});
