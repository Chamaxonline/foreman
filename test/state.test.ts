import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  dayKey,
  LockError,
  MAX_RECOVERIES,
  nextDayStart,
  StateStore,
} from "../src/state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "foreman-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("StateStore persistence", () => {
  it("persists task updates and reloads them", async () => {
    const s = await StateStore.open(dir);
    await s.updateTask("a", { status: "in_progress", attempts: 2 });
    await s.recordAttempt("a", {
      n: 1,
      model: "sonnet",
      outcome: "check_failed",
      summary: "test failed",
      costUsd: 0.5,
    });
    await s.updateTask("b", { status: "done", prUrl: "https://x/pr/1" });

    const s2 = await StateStore.open(dir);
    expect(s2.get("a")).toMatchObject({ status: "in_progress", attempts: 2 });
    expect(s2.get("a")!.history).toHaveLength(1);
    expect(s2.get("b")).toMatchObject({ status: "done", prUrl: "https://x/pr/1" });
  });

  it("serializes concurrent saves without corrupting the file", async () => {
    const s = await StateStore.open(dir);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => s.updateTask(`t${i}`, { attempts: i })),
    );
    const parsed = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    expect(Object.keys(parsed.tasks)).toHaveLength(25);
  });

  it("falls back to the .bak file if state.json is corrupt", async () => {
    const s = await StateStore.open(dir);
    await s.updateTask("a", { status: "done" });
    await s.updateTask("b", { status: "pending" }); // .bak now has "a"
    await writeFile(path.join(dir, "state.json"), "{ truncated");
    const s2 = await StateStore.open(dir);
    expect(s2.get("a")?.status).toBe("done");
  });

  it("returns copies, not live references", async () => {
    const s = await StateStore.open(dir);
    await s.updateTask("a", { attempts: 1 });
    const t = s.get("a")!;
    t.attempts = 99;
    expect(s.get("a")!.attempts).toBe(1);
  });
});

describe("crash recovery / resume", () => {
  it("requeues in_progress tasks, keeps attempts and spend, leaves finished tasks alone", async () => {
    const s = await StateStore.open(dir);
    await s.updateTask("running", { status: "in_progress", attempts: 3 });
    await s.addSpend(1.25, "running");
    await s.updateTask("finished", { status: "done" });
    await s.updateTask("blocked", { status: "needs_human" });

    // simulate a restart
    const s2 = await StateStore.open(dir);
    const report = await s2.recoverInterrupted();
    expect(report).toEqual({ requeued: ["running"], failed: [] });
    expect(s2.get("running")).toMatchObject({
      status: "pending",
      attempts: 3,
      costUsd: 1.25,
      recoveries: 1,
    });
    expect(s2.get("finished")!.status).toBe("done");
    expect(s2.get("blocked")!.status).toBe("needs_human");
    expect(s2.spentToday()).toBe(1.25);
  });

  it("marks a task failed after repeated interruptions", async () => {
    for (let i = 0; i < MAX_RECOVERIES; i++) {
      // each iteration is a fresh process: pick up the task, then "crash"
      const s = await StateStore.open(dir);
      await s.updateTask("crashy", { status: "in_progress" });
      await (await StateStore.open(dir)).recoverInterrupted();
    }
    const final = (await StateStore.open(dir)).get("crashy")!;
    expect(final.status).toBe("failed");
    expect(final.lastError).toMatch(/Interrupted 3 times/);
  });

  it("closes runs that never finished", async () => {
    const s = await StateStore.open(dir);
    await s.startRun(false);
    await s.updateTask("x", { status: "in_progress" });
    const s2 = await StateStore.open(dir);
    await s2.recoverInterrupted();
    expect(s2.snapshot().runs[0]!.finishedAt).toBeDefined();
  });
});

describe("spend tracking", () => {
  it("tracks spend per day, per task and per run, and resets at the day boundary", async () => {
    let now = new Date("2026-03-01T23:30:00Z");
    const s = await StateStore.open(dir, { now: () => now });
    const run = await s.startRun(false);
    await s.addSpend(2, "a", run.id);
    await s.addSpend(0.5, "a", run.id);
    expect(s.spentToday()).toBe(2.5);
    expect(s.get("a")!.costUsd).toBe(2.5);
    expect(s.runCost(run.id)).toBe(2.5);
    expect(s.nextDayStart().toISOString()).toBe("2026-03-02T00:00:00.000Z");

    now = new Date("2026-03-02T00:00:01Z");
    expect(s.spentToday()).toBe(0);
    await s.addSpend(1);
    expect(s.spentToday()).toBe(1);

    // survives restart
    const s2 = await StateStore.open(dir, { now: () => now });
    expect(s2.spentToday()).toBe(1);
    expect(s2.snapshot().spend["2026-03-01"]).toBe(2.5);
  });

  it("ignores zero/negative/NaN spend", async () => {
    const s = await StateStore.open(dir);
    await s.addSpend(0);
    await s.addSpend(-1);
    await s.addSpend(Number.NaN);
    expect(s.spentToday()).toBe(0);
  });

  it("dayKey / nextDayStart helpers", () => {
    const d = new Date("2026-12-31T12:00:00Z");
    expect(dayKey(d, "utc")).toBe("2026-12-31");
    expect(nextDayStart(d, "utc").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const local = nextDayStart(d, "local");
    expect(local.getHours()).toBe(0);
    expect(local.getTime()).toBeGreaterThan(d.getTime());
  });
});

describe("process lock", () => {
  it("is exclusive while held and reusable after release", async () => {
    const release = await acquireLock(dir);
    await expect(acquireLock(dir)).rejects.toThrow(LockError);
    await release();
    const release2 = await acquireLock(dir);
    await release2();
  });

  it("takes over a stale lock from a dead process on this host", async () => {
    await writeFile(
      path.join(dir, "lock"),
      JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: "x" }),
    );
    const release = await acquireLock(dir);
    await release();
  });

  it("refuses a lock held on another host unless forced", async () => {
    await writeFile(
      path.join(dir, "lock"),
      JSON.stringify({ pid: 1, host: "some-other-host", startedAt: "x" }),
    );
    await expect(acquireLock(dir)).rejects.toThrow(/--force-unlock/);
    const release = await acquireLock(dir, { force: true });
    await release();
  });
});
