import { describe, expect, it } from "vitest";
import { TaskRunner } from "../src/loop.js";
import { StateStore } from "../src/state.js";
import { errorSignature } from "../src/stuck.js";
import {
  FakeAgents,
  FakeChecks,
  FakeGit,
  FakeGitHub,
  failingRun,
  makeDeps,
  makeTask,
  passingRun,
  World,
} from "./helpers/fakes.js";

/** Coder that edits a file every call. */
const editingCoder = (w: () => World) => () => (w().edit("src/a.ts"), {});

describe("TaskRunner: happy path", () => {
  it("plans, codes, checks, reviews, commits, pushes and opens a PR", async () => {
    const { deps, world, state } = await makeDeps();
    const gh = deps.github as FakeGitHub;
    const out = await new TaskRunner(deps).runTask(makeTask());

    expect(out.status).toBe("done");
    expect(out.attempts).toBe(1);
    expect(out.prUrl).toBe("https://github.com/a/b/pull/100");
    const agents = deps.agents as FakeAgents;
    expect(agents.calls.map((c) => `${c.role}:${c.model}`)).toEqual(["planner:opus", "coder:sonnet", "reviewer:opus"]);
    // planner/reviewer are read-only; coder may run only configured checks
    expect(agents.byRole("planner")[0]!.readOnly).toBe(true);
    expect(agents.byRole("reviewer")[0]!.readOnly).toBe(true);
    expect(agents.byRole("coder")[0]!.readOnly).toBe(false);
    expect(agents.byRole("coder")[0]!.allowedCommands).toEqual(["npm test"]);
    expect(agents.byRole("coder")[0]!.prompt).toContain("1. do the thing"); // plan passed to coder

    expect(world.commits).toHaveLength(1);
    expect(world.commits[0]).toMatch(/^foreman\(t1\): Add feature/);
    expect(world.pushes).toEqual(["foreman/t1"]);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ head: "foreman/t1", base: "main", draft: false, labels: ["foreman"] });
    expect(gh.prs[0]!.body).toContain("Checks run");
    expect(gh.prs[0]!.body).toContain("npm test");
    expect(gh.prs[0]!.body).toMatch(/Attempts: 1/);
    expect(gh.prs[0]!.body).toMatch(/Cost: \$0\.30/);

    const st = state.get("t1")!;
    expect(st.status).toBe("done");
    expect(st.costUsd).toBeCloseTo(0.3);
    expect(state.spentToday()).toBeCloseTo(0.3);
    expect(world.removed).toBe(1); // worktree cleaned up
  });

  it("skips finished tasks", async () => {
    const { deps, state } = await makeDeps();
    await state.updateTask("t1", { status: "done" });
    const out = await new TaskRunner(deps).runTask(makeTask());
    expect(out.status).toBe("skipped");
    expect((deps.agents as FakeAgents).calls).toHaveLength(0);
  });

  it("reconciles with an existing PR when state was lost", async () => {
    const { deps, state } = await makeDeps();
    (deps.github as FakeGitHub).existing = { number: 7, url: "u", state: "open", merged: false, draft: false, head: "foreman/t1" };
    const out = await new TaskRunner(deps).runTask(makeTask());
    expect(out.status).toBe("skipped");
    expect(state.get("t1")).toMatchObject({ status: "done", prNumber: 7 });
    expect((deps.agents as FakeAgents).calls).toHaveLength(0);
  });
});

describe("TaskRunner: retries, escalation, stuck", () => {
  it("feeds check output back to the same session and retries", async () => {
    let world!: World;
    const checks = new FakeChecks((n) => (n === 1 ? failingRun("TypeError: x is not a function") : passingRun()));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ checks, agents });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());

    expect(out.status).toBe("done");
    expect(out.attempts).toBe(2);
    const coder = agents.byRole("coder");
    expect(coder).toHaveLength(2);
    expect(coder[1]!.prompt).toContain("checks FAILED");
    expect(coder[1]!.prompt).toContain("TypeError: x is not a function");
    expect(coder[1]!.resumeSessionId).toBe("coder-sonnet-1");
    expect(made.state.get("t1")!.history.map((h) => h.outcome)).toEqual(["check_failed", "pass"]);
  });

  it("escalates to the stronger model after 2 failures, in a fresh session with history", async () => {
    let world!: World;
    const errors = ["error A", "error B"];
    const checks = new FakeChecks((n) => (n <= 2 ? failingRun(errors[n - 1]) : passingRun()));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ checks, agents, configYaml: "models: { coder: haiku, escalation: opus }" });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());

    expect(out.status).toBe("done");
    const coder = agents.byRole("coder");
    expect(coder.map((c) => c.model)).toEqual(["haiku", "haiku", "opus"]);
    expect(coder[2]!.resumeSessionId).toBeUndefined();
    expect(coder[2]!.prompt).toContain("Previous attempts");
    expect(coder[2]!.prompt).toContain("error B");
    expect(out.models).toEqual(expect.arrayContaining(["haiku", "opus"]));
  });

  it("respects a per-task model override", async () => {
    const made = await makeDeps();
    await new TaskRunner(made.deps).runTask(makeTask({ model: "haiku" }));
    expect((made.deps.agents as FakeAgents).byRole("coder")[0]!.model).toBe("haiku");
  });

  it("stops early when stuck on the same error 3 times, opening a draft needs-human PR", async () => {
    let world!: World;
    // same error with varying timings/paths → same signature
    const outputs = [
      "FAIL src/a.test.ts (12ms)\nAssertionError: expected 1 to be 2 at /tmp/abc123/x.ts:10:5",
      "FAIL src/a.test.ts (15ms)\nAssertionError: expected 1 to be 2 at /tmp/zzz999/x.ts:11:7",
      "FAIL src/a.test.ts (9ms)\nAssertionError: expected 1 to be 2 at /tmp/qqq000/x.ts:12:2",
    ];
    const checks = new FakeChecks((n) => failingRun(outputs[(n - 1) % 3]));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ checks, agents, configYaml: "limits: { maxAttemptsPerTask: 8 }" });
    world = made.world;
    const gh = made.deps.github as FakeGitHub;
    const out = await new TaskRunner(made.deps).runTask(makeTask());

    expect(out.status).toBe("needs_human");
    expect(out.attempts).toBe(3);
    expect(out.reason).toMatch(/stuck/);
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ draft: true, labels: ["foreman", "needs-human"] });
    expect(gh.prs[0]!.title).toMatch(/^\[needs-human\]/);
    expect(gh.prs[0]!.body).toContain("foreman needs a human");
    expect(gh.prs[0]!.body).toContain("AssertionError");
    expect(gh.prs[0]!.body).toContain("| 3 |"); // history table
    expect(world.commits[0]).toMatch(/work in progress/);
    expect(made.state.get("t1")!.status).toBe("needs_human");
  });

  it("hits the attempt limit with different errors", async () => {
    let world!: World;
    const checks = new FakeChecks((n) => failingRun(`distinct error number ${"x".repeat(n)}`));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ checks, agents, configYaml: "limits: { maxAttemptsPerTask: 4 }" });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("needs_human");
    expect(out.attempts).toBe(4);
    expect(out.reason).toMatch(/maximum of 4 attempts/);
  });

  it("resumes stuck detection and attempt counts after a restart", async () => {
    let world!: World;
    const made0 = await makeDeps();
    const sig = errorSignature("$ npm test\n(exit 1)\nsame failure");
    await made0.state.updateTask("t1", { status: "pending", attempts: 2 });
    for (const n of [1, 2]) {
      await made0.state.recordAttempt("t1", { n, model: "sonnet", outcome: "check_failed", summary: "same failure", costUsd: 0, signature: sig });
    }
    const checks = new FakeChecks(() => failingRun("same failure"));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ checks, agents, state: made0.state });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("needs_human");
    expect(out.attempts).toBe(3); // only one new attempt
    expect(out.reason).toMatch(/stuck/);
    // 2 prior failures ≥ escalateAfterFailures → straight to escalation model
    expect(agents.byRole("coder")[0]!.model).toBe("opus");
  });

  it("treats 'no changes' as a failed attempt", async () => {
    let world!: World;
    const agents = new FakeAgents({ coder: (_c, n) => (n >= 2 ? world.edit("src/a.ts") : undefined, {}) });
    const made = await makeDeps({ agents });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("done");
    expect(agents.byRole("coder")[1]!.prompt).toContain("No files were changed");
  });
});

describe("TaskRunner: diff gate", () => {
  it("rejects violating diffs, reverts the paths and feeds the reason back", async () => {
    let world!: World;
    const agents = new FakeAgents({
      coder: (_c, n) => {
        world.edit("src/a.ts");
        if (n === 1) world.edit("vitest.config.ts");
        return {};
      },
    });
    const gate = {
      inspect: (changes: Array<{ path: string }>) => {
        const bad = changes.filter((c) => c.path === "vitest.config.ts");
        return { ok: bad.length === 0, violations: bad.map((c) => ({ path: c.path, reason: "protected path" })) };
      },
    };
    const made = await makeDeps({ agents, gate });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("done");
    expect(world.restored).toEqual([["vitest.config.ts"]]);
    expect(agents.byRole("coder")[1]!.prompt).toContain("REJECTED");
    expect(agents.byRole("coder")[1]!.prompt).toContain("vitest.config.ts: protected path");
    expect(made.state.get("t1")!.history[0]!.outcome).toBe("rejected");
  });
});

describe("TaskRunner: review", () => {
  it("sends reviewer change requests back to the coder once", async () => {
    let world!: World;
    const agents = new FakeAgents({
      coder: () => (world.edit("src/a.ts"), {}),
      reviewer: (_c, n) =>
        n === 1
          ? { structured: { verdict: "request_changes", summary: "Missing edge case", issues: ["handle empty input"] } }
          : { structured: { verdict: "approve", summary: "Good", issues: [] } },
    });
    const made = await makeDeps({ agents });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("done");
    expect(agents.byRole("reviewer")).toHaveLength(2);
    expect(agents.byRole("coder")[1]!.prompt).toContain("handle empty input");
    expect(made.state.get("t1")!.history.map((h) => h.outcome)).toEqual(["review_changes", "pass"]);
    expect((made.deps.github as FakeGitHub).prs[0]!.body).toContain("**approve**: Good");
  });

  it("can be disabled", async () => {
    const made = await makeDeps({ configYaml: "review: { enabled: false }" });
    await new TaskRunner(made.deps).runTask(makeTask());
    expect((made.deps.agents as FakeAgents).byRole("reviewer")).toHaveLength(0);
  });
});

describe("TaskRunner: CI", () => {
  it("waits for CI, feeds failures back, pushes a fix and updates the same PR", async () => {
    let world!: World;
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ agents, configYaml: "ci: { wait: true }" });
    world = made.world;
    const gh = made.deps.github as FakeGitHub;
    gh.ci = [
      { state: "pending", details: "" },
      { state: "failure", details: "### build (failure)\nlint error: no-unused-vars" },
      { state: "success", details: "" },
    ];
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("done");
    expect(gh.prs).toHaveLength(1);
    expect(gh.updates).toHaveLength(1); // second push updated the existing PR
    expect(world.pushes).toEqual(["foreman/t1", "foreman/t1"]);
    expect(agents.byRole("coder")[1]!.prompt).toContain("GitHub CI FAILED");
    expect(agents.byRole("coder")[1]!.prompt).toContain("no-unused-vars");
    expect(made.state.get("t1")!.history.map((h) => h.outcome)).toEqual(["pass", "ci_failed", "pass"]);
  });
});

describe("TaskRunner: dry run", () => {
  it("does everything except push and open PRs", async () => {
    const made = await makeDeps({ dryRun: true });
    const gh = made.deps.github as FakeGitHub;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("done");
    expect(out.dryRun).toBe(true);
    expect(out.prBody).toContain("## Summary");
    expect(made.world.pushes).toEqual([]);
    expect(gh.prs).toEqual([]);
    expect(made.world.commits).toHaveLength(1); // local commit only, in a throwaway worktree
  });

  it("does not push or open a draft PR when limits are hit in dry run", async () => {
    let world!: World;
    const checks = new FakeChecks(() => failingRun("same"));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ dryRun: true, checks, agents });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("needs_human");
    expect(world.pushes).toEqual([]);
    expect((made.deps.github as FakeGitHub).prs).toEqual([]);
    expect(out.prBody).toContain("needs a human");
  });
});

describe("TaskRunner: limits", () => {
  it("defers when the daily cap is already spent", async () => {
    const made = await makeDeps({ configYaml: "limits: { maxSpendPerDayUsd: 1 }" });
    await made.state.addSpend(1);
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("deferred");
    expect(out.reason).toMatch(/daily spend cap/);
    expect(made.state.get("t1")!.status).toBe("pending");
    expect((made.deps.agents as FakeAgents).calls).toHaveLength(0);
  });

  it("passes the remaining budget to each call and defers when the run cap is reached mid-task", async () => {
    let world!: World;
    const checks = new FakeChecks(() => failingRun(`err ${Math.random()}`));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), { costUsd: 0.4 }) });
    const made = await makeDeps({ checks, agents, configYaml: "limits: { maxSpendPerRunUsd: 1, maxAttemptsPerTask: 10 }" });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("deferred");
    expect(out.reason).toMatch(/per-run spend cap/);
    const budgets = agents.calls.map((c) => Number(c.maxBudgetUsd.toFixed(2)));
    expect(budgets[0]).toBe(1); // planner
    expect(budgets[1]).toBe(0.9); // after planner's 0.1
    expect(budgets[2]).toBe(0.5);
    expect(made.state.get("t1")!.status).toBe("pending");
  });

  it("per-task spend cap ends the task as needs-human", async () => {
    let world!: World;
    const checks = new FakeChecks(() => failingRun(`err ${Math.random()}`));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), { costUsd: 0.5 }) });
    const made = await makeDeps({ checks, agents, configYaml: "limits: { maxSpendPerTaskUsd: 1, maxAttemptsPerTask: 10 }" });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("needs_human");
    expect(out.reason).toMatch(/per-task spend cap/);
  });

  it("aborts cleanly at the time limit", async () => {
    let world!: World;
    const agents = new FakeAgents({
      coder: (call) =>
        new Promise((resolve) => {
          world.edit("src/a.ts");
          call.signal.addEventListener("abort", () => resolve({ ok: false, subtype: "aborted" }));
        }),
    });
    const made = await makeDeps({ agents, configYaml: "limits: { maxMinutesPerTask: 0.002 }" });
    world = made.world;
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("needs_human");
    expect(out.reason).toMatch(/time limit/);
    expect(made.state.get("t1")!.status).toBe("needs_human");
    expect(world.removed).toBe(1);
  });
});

describe("TaskRunner: infrastructure errors", () => {
  it("returns the attempt and leaves the task pending with backoff on API exceptions", async () => {
    const agents = new FakeAgents({ coder: () => ({ ok: false, subtype: "exception", error: "529 overloaded" }) });
    const made = await makeDeps({ agents, now: () => Date.parse("2026-01-01T00:00:00Z") });
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("error");
    const st = made.state.get("t1")!;
    expect(st.status).toBe("pending");
    expect(st.attempts).toBe(0);
    expect(st.errorCount).toBe(1);
    expect(st.notBefore).toBe("2026-01-01T00:01:00.000Z");
    expect(st.lastError).toMatch(/overloaded/);
  });

  it("marks the task failed on a branch-safety violation", async () => {
    let world!: World;
    const git = new (class extends FakeGit {
      override async push(): Promise<void> {
        const { BranchSafetyError } = await import("../src/git.js");
        throw new BranchSafetyError("Refusing to push to base branch main");
      }
    })((world = new World()));
    const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
    const made = await makeDeps({ git, agents });
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("failed");
    expect(made.state.get("t1")!.status).toBe("failed");
  });

  it("never leaves a task in_progress after it returns", async () => {
    const agents = new FakeAgents({ planner: () => { throw new Error("kaboom"); } });
    const made = await makeDeps({ agents });
    const out = await new TaskRunner(made.deps).runTask(makeTask());
    expect(out.status).toBe("error");
    expect(made.state.get("t1")!.status).toBe("pending");
    const reopened = await StateStore.open(made.dir);
    expect(reopened.get("t1")!.status).toBe("pending");
  });
});
