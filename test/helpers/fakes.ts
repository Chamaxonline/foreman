import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentCall, AgentResult, AgentRunner } from "../../src/claude.js";
import type { CheckResult, CheckRun, CheckRunner } from "../../src/checks.js";
import { parseConfig, type ForemanConfig } from "../../src/config.js";
import type { ChangedFile } from "../../src/git.js";
import type { CiRef, CiStatus, CreatePrInput, PullRequestRef, RepoHost } from "../../src/host.js";
import { permissiveGate, type DiffGate, type GitOps, type LoopDeps, silentLogger } from "../../src/loop.js";
import type { RoleDefinition, Role } from "../../src/roles.js";
import { StateStore } from "../../src/state.js";
import type { Task } from "../../src/tasks.js";

/** In-memory model of the task worktree. */
export class World {
  /** Changes vs base (what stagedChanges returns). */
  changes: ChangedFile[] = [];
  diff = "";
  /** Index differs from HEAD. */
  dirty = false;
  commits: string[] = [];
  pushes: string[] = [];
  restored: string[][] = [];
  worktrees = 0;
  removed = 0;
  /** Working-tree file contents, for readWorkingFile. */
  files: Record<string, string> = {};

  edit(p: string, diff = `+++ b/${p}\n+change\n`): void {
    if (!this.changes.some((c) => c.path === p)) this.changes.push({ status: "M", path: p });
    this.diff += diff;
    this.dirty = true;
  }

  /** Pre-seed a file as already existing (base content), not a change made this attempt. */
  seed(p: string, content: string): void {
    this.files[p] = content;
  }

  /** Simulate an agent writing a file: updates content and registers it as a change. */
  write(p: string, content: string): void {
    this.files[p] = content;
    this.edit(p, `+++ b/${p}\n+${content.split("\n").join("\n+")}\n`);
  }
}

export class FakeGit implements GitOps {
  constructor(readonly w: World) {}
  async fetch() {}
  async createWorktree(taskId: string) {
    this.w.worktrees++;
    return { dir: `/wt/${taskId}`, branch: `foreman/${taskId}`, baseSha: "base000" };
  }
  async removeWorktree() {
    this.w.removed++;
  }
  async stagedChanges(): Promise<ChangedFile[]> {
    return [...this.w.changes];
  }
  async stagedDiff() {
    return this.w.diff;
  }
  async diffStat() {
    return this.w.changes.map((c) => ` ${c.path} | 1 +`).join("\n");
  }
  async restorePaths(_d: string, _s: string, paths: string[]) {
    this.w.restored.push(paths);
    this.w.changes = this.w.changes.filter((c) => !paths.includes(c.path));
    this.w.dirty = this.w.changes.length > 0;
  }
  async commit(_d: string, message: string) {
    this.w.commits.push(message);
    this.w.dirty = false;
    return `sha${this.w.commits.length}`.padEnd(40, "0");
  }
  async hasStagedChanges() {
    return this.w.dirty;
  }
  async headSha() {
    return `sha${this.w.commits.length}`.padEnd(40, "0");
  }
  async commitsAhead() {
    return this.w.commits.length;
  }
  async push(_d: string, branch: string) {
    if (!branch.startsWith("foreman/")) throw new Error("bad push");
    this.w.pushes.push(branch);
  }
  async readFileAt() {
    return undefined;
  }
  async readWorkingFile(_d: string, path: string) {
    return this.w.files[path];
  }
}

export type AgentScript = (call: AgentCall, n: number) => Partial<AgentResult> | Promise<Partial<AgentResult>>;

export class FakeAgents implements AgentRunner {
  calls: AgentCall[] = [];
  private counts: Record<Role, number> = { planner: 0, coder: 0, reviewer: 0, analyst: 0 };
  constructor(private readonly scripts: Partial<Record<Role, AgentScript>> = {}) {}

  async run(call: AgentCall): Promise<AgentResult> {
    this.calls.push(call);
    const n = ++this.counts[call.role];
    const defaults: AgentResult = {
      ok: true,
      text:
        call.role === "planner" ? "1. do the thing" : call.role === "reviewer" || call.role === "analyst" ? "" : "Implemented it.",
      costUsd: 0.1,
      sessionId: `${call.role}-${call.model}-${n}`,
      turns: 1,
      subtype: "success",
      deniedToolCalls: 0,
      ...(call.role === "reviewer" ? { structured: { verdict: "approve", summary: "LGTM", issues: [] } } : {}),
    };
    const script = this.scripts[call.role];
    const over = script ? await script(call, n) : {};
    return { ...defaults, ...over };
  }

  byRole(role: Role): AgentCall[] {
    return this.calls.filter((c) => c.role === role);
  }
}

export function checkResult(ok: boolean, output = ok ? "all good" : "FAIL src/a.test.ts\n  expected 1 to be 2"): CheckResult {
  return { name: "test", command: "npm test", ok, code: ok ? 0 : 1, timedOut: false, durationMs: 1000, output };
}

export class FakeChecks implements CheckRunner {
  readonly checks = [{ name: "test", run: "npm test" }];
  runs = 0;
  constructor(private readonly script: (n: number) => CheckRun | Promise<CheckRun> = () => ({ ok: true, results: [checkResult(true)], failureOutput: "" })) {}
  async run(_dir: string, _signal: AbortSignal): Promise<CheckRun> {
    return this.script(++this.runs);
  }
}

export function failingRun(output = "FAIL src/a.test.ts\n  expected 1 to be 2"): CheckRun {
  return { ok: false, results: [checkResult(false, output)], failureOutput: `$ npm test\n(exit 1)\n${output}` };
}
export const passingRun = (): CheckRun => ({ ok: true, results: [checkResult(true)], failureOutput: "" });

export class FakeHost implements RepoHost {
  readonly kind = "github" as const;
  prs: Array<PullRequestRef & CreatePrInput> = [];
  updates: Array<{ number: number; body?: string }> = [];
  labels: Array<{ number: number; labels: string[]; on: "pr" | "issue" }> = [];
  comments: Array<{ number: number; body: string; on: "pr" | "issue" }> = [];
  ci: CiStatus[] = [];
  ciRefs: CiRef[] = [];
  issueTasks: Task[] = [];
  existing?: PullRequestRef;

  issueRef(n: number) {
    return `Closes #${n}`;
  }

  async findPrForBranch(branch: string) {
    return this.prs.filter((p) => p.head === branch).at(-1) ?? this.existing;
  }
  async createPr(input: CreatePrInput) {
    const pr = { ...input, number: 100 + this.prs.length, url: `https://github.com/a/b/pull/${100 + this.prs.length}`, state: "open" as const, merged: false };
    this.prs.push(pr);
    return pr;
  }
  async updatePr(number: number, patch: { body?: string }) {
    this.updates.push({ number, ...patch });
  }
  async addPrLabels(number: number, labels: string[]) {
    this.labels.push({ number, labels, on: "pr" });
  }
  async addIssueLabels(number: number, labels: string[]) {
    this.labels.push({ number, labels, on: "issue" });
  }
  async commentPr(number: number, body: string) {
    this.comments.push({ number, body, on: "pr" });
  }
  async commentIssue(number: number, body: string) {
    this.comments.push({ number, body, on: "issue" });
  }
  async listTaskIssues(): Promise<Task[]> {
    return this.issueTasks;
  }
  async ciStatus(ref: CiRef): Promise<CiStatus> {
    this.ciRefs.push(ref);
    return this.ci.shift() ?? { state: "success", details: "" };
  }
}

export const roles: Record<Role, RoleDefinition> = {
  planner: { name: "planner", description: "", tools: [], prompt: "PLANNER" },
  coder: { name: "coder", description: "", tools: [], prompt: "CODER" },
  reviewer: { name: "reviewer", description: "", tools: [], prompt: "REVIEWER" },
  analyst: { name: "analyst", description: "", tools: [], prompt: "ANALYST" },
};

export function makeConfig(extra = ""): ForemanConfig {
  return parseConfig(`checks: { test: npm test }\n${extra}`);
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Add feature",
    description: "Do it",
    acceptance: ["it works"],
    files: [],
    priority: 0,
    source: "file",
    ...over,
  };
}

export async function makeDeps(over: Partial<LoopDeps> & { configYaml?: string; gate?: DiffGate } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foreman-loop-"));
  const state = over.state ?? (await StateStore.open(dir));
  const world = new World();
  const run = await state.startRun(over.dryRun ?? false);
  const deps: LoopDeps = {
    config: over.config ?? makeConfig(over.configYaml ?? ""),
    state,
    git: over.git ?? new FakeGit(world),
    host: "host" in over ? over.host : new FakeHost(),
    agents: over.agents ?? new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) }),
    checks: over.checks ?? new FakeChecks(),
    gate: over.gate ?? permissiveGate,
    roles,
    isProtected: () => false,
    runId: run.id,
    dryRun: over.dryRun ?? false,
    log: silentLogger,
    sleep: async () => {},
    ...(over.now ? { now: over.now } : {}),
  };
  return { deps, world, state, dir };
}
