import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/loop.js";
import { Orchestrator, type OrchestratorDeps, type TaskExecutor } from "../src/orchestrator.js";
import type { TaskOutcome } from "../src/report.js";
import { StateStore } from "../src/state.js";
import type { Task } from "../src/tasks.js";
import { FakeGitHub, makeConfig, makeTask } from "./helpers/fakes.js";

function outcome(task: Task, status: TaskOutcome["status"], extra: Partial<TaskOutcome> = {}): TaskOutcome {
  return { taskId: task.id, title: task.title, status, dryRun: false, attempts: 1, costUsd: 0, durationMs: 0, models: [], checks: [], history: [], ...extra };
}

async function setup(over: Partial<OrchestratorDeps> & { tasks?: Task[]; exec?: (t: Task, state: StateStore) => Promise<TaskOutcome> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foreman-orch-"));
  let clock = Date.parse("2026-05-01T10:00:00Z");
  const state = over.state ?? (await StateStore.open(dir, { now: () => new Date(clock) }));
  const ran: string[] = [];
  const sleeps: number[] = [];
  const exec =
    over.exec ??
    (async (t: Task, s: StateStore) => {
      await s.updateTask(t.id, { status: "done" });
      return outcome(t, "done");
    });
  const deps: OrchestratorDeps = {
    config: over.config ?? makeConfig(),
    state,
    log: silentLogger,
    dryRun: false,
    reportsDir: path.join(dir, "reports"),
    loadFileTasks: async () => over.tasks ?? [makeTask()],
    makeExecutor: (): TaskExecutor => ({
      runTask: async (t) => {
        ran.push(t.id);
        return exec(t, state);
      },
    }),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...over,
  };
  return { orch: new Orchestrator(deps), state, ran, sleeps, dir, advance: (ms: number) => (clock += ms) };
}

describe("Orchestrator.runOnce", () => {
  it("runs pending tasks by priority and writes markdown + JSON reports", async () => {
    const tasks = [makeTask({ id: "low", priority: -50 }), makeTask({ id: "high", priority: 50 }), makeTask({ id: "mid" })];
    const { orch, ran, dir } = await setup({ tasks });
    const report = await orch.runOnce();
    expect(ran).toEqual(["high", "mid", "low"]);
    expect(report.tasks.map((t) => t.status)).toEqual(["done", "done", "done"]);
    const md = await readFile(path.join(dir, "reports", "latest.md"), "utf8");
    expect(md).toContain("Done: 3");
    const json = JSON.parse(await readFile(path.join(dir, "reports", "latest.json"), "utf8"));
    expect(json.tasks).toHaveLength(3);
  });

  it("does not redo finished tasks across restarts", async () => {
    const { orch, ran, state } = await setup({ tasks: [makeTask({ id: "a" }), makeTask({ id: "b" })] });
    await orch.runOnce();
    expect(ran).toEqual(["a", "b"]);
    // "restart": new orchestrator over the same state
    const again = await setup({ tasks: [makeTask({ id: "a" }), makeTask({ id: "b" }), makeTask({ id: "c" })], state });
    await again.orch.runOnce();
    expect(again.ran).toEqual(["c"]);
  });

  it("requeues tasks left in_progress by a crash", async () => {
    const { orch, ran, state } = await setup({ tasks: [makeTask({ id: "a" })] });
    await state.updateTask("a", { status: "in_progress", attempts: 2 });
    await orch.runOnce();
    expect(ran).toEqual(["a"]);
  });

  it("stops the run when a task is deferred by a spend cap", async () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    const { orch, ran } = await setup({ tasks, exec: async (t) => outcome(t, "deferred", { reason: "reached the daily spend cap ($1)" }) });
    const report = await orch.runOnce();
    expect(ran).toEqual(["a"]);
    expect(report.stoppedReason).toMatch(/daily spend cap/);
  });

  it("respects backoff (notBefore) for tasks that hit infrastructure errors", async () => {
    const { orch, ran, state, advance } = await setup({ tasks: [makeTask({ id: "a" })] });
    await state.updateTask("a", { status: "pending", notBefore: "2026-05-01T10:05:00Z" });
    await orch.runOnce();
    expect(ran).toEqual([]);
    advance(6 * 60_000);
    await orch.runOnce();
    expect(ran).toEqual(["a"]);
  });

  it("--task runs one task; --retry resets a finished one", async () => {
    const { orch, ran, state } = await setup({ tasks: [makeTask({ id: "a" }), makeTask({ id: "b" })] });
    await state.updateTask("b", { status: "needs_human", attempts: 5 });
    await orch.runOnce({ taskId: "b", retry: true });
    expect(ran).toEqual(["b"]);
    expect(state.get("b")!.attempts).toBe(0); // reset before running (fake executor doesn't attempt)
    await expect(orch.runOnce({ taskId: "nope" })).rejects.toThrow(/not found/);
  });

  it("merges labeled GitHub issues into the queue", async () => {
    const gh = new FakeGitHub();
    gh.listLabeledIssues = async () => [{ number: 9, title: "From issue", body: "## Acceptance\n- ok", labels: ["foreman", "priority:high"] }];
    const { orch, ran } = await setup({ github: gh, config: makeConfig("issues: { enabled: true }") });
    await orch.runOnce();
    expect(ran).toEqual(["issue-9", "t1"]);
  });

  it("stops between tasks when shutdown is requested", async () => {
    const ctl = new AbortController();
    const { orch, ran } = await setup({
      tasks: [makeTask({ id: "a" }), makeTask({ id: "b" })],
      exec: async (t, s) => {
        ctl.abort();
        await s.updateTask(t.id, { status: "done" });
        return outcome(t, "done");
      },
    });
    const report = await orch.runOnce({ signal: ctl.signal });
    expect(ran).toEqual(["a"]);
    expect(report.stoppedReason).toBe("shutdown requested");
  });
});

describe("Orchestrator.watch", () => {
  it("idles and polls, picking up new tasks as they appear", async () => {
    const tasks: Task[] = [];
    const ctl = new AbortController();
    let cycles = 0;
    const { orch, ran, sleeps } = await setup({ tasks });
    await orch.watch(ctl.signal, {
      onCycle: () => {
        cycles++;
        if (cycles === 2) tasks.push(makeTask({ id: "late" }));
        if (cycles === 4) ctl.abort();
      },
    });
    expect(ran).toEqual(["late"]);
    expect(sleeps.slice(0, 2)).toEqual([300_000, 300_000]);
  });

  it("pauses until the next day when the daily cap is reached", async () => {
    const ctl = new AbortController();
    const { orch, sleeps, state } = await setup({ config: makeConfig("limits: { maxSpendPerDayUsd: 5 }") });
    await state.addSpend(5);
    let cycles = 0;
    await orch.watch(ctl.signal, { onCycle: () => (++cycles === 2 ? ctl.abort() : undefined) });
    // 10:00Z → next UTC midnight is 14h away (+30s margin)
    expect(sleeps[0]).toBe(14 * 3600_000 + 30_000);
  });

  it("backs off exponentially when a cycle throws", async () => {
    const ctl = new AbortController();
    let n = 0;
    const { orch, sleeps } = await setup({
      loadFileTasks: async () => {
        if (++n >= 3) ctl.abort();
        throw new Error("GitHub down");
      },
    });
    await orch.watch(ctl.signal);
    expect(sleeps).toEqual([60_000, 120_000]);
  });
});
