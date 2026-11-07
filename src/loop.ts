import { Budget, type LimitKind } from "./budget.js";
import type { AgentCall, AgentResult, AgentRunner } from "./claude.js";
import type { CheckResult, CheckRunner } from "./checks.js";
import { checksSummary } from "./checks.js";
import type { ForemanConfig } from "./config.js";
import { BranchSafetyError, branchFor, type ChangedFile } from "./git.js";
import type { GitHubApi, PullRequestRef } from "./github.js";
import {
  coderPrompt,
  escalationPrompt,
  parseReview,
  plannerPrompt,
  REVIEW_SCHEMA,
  retryPrompt,
  reviewerPrompt,
  type FeedbackKind,
  type ReviewVerdict,
} from "./prompts.js";
import { failureReport, historyTable, successPrBody, type OutcomeStatus, type TaskOutcome } from "./report.js";
import type { Role, RoleDefinition } from "./roles.js";
import type { AttemptRecord, StateStore } from "./state.js";
import { errorSignature, StuckDetector } from "./stuck.js";
import type { Task } from "./tasks.js";

/** The subset of Git the loop uses (mocked in tests). */
export interface GitOps {
  fetch(): Promise<void>;
  createWorktree(taskId: string): Promise<{ dir: string; branch: string; baseSha: string }>;
  removeWorktree(taskId: string): Promise<void>;
  stagedChanges(dir: string, sinceRef: string): Promise<ChangedFile[]>;
  stagedDiff(dir: string, sinceRef: string, context?: number): Promise<string>;
  diffStat(dir: string, sinceRef: string): Promise<string>;
  restorePaths(dir: string, sinceRef: string, paths: string[]): Promise<void>;
  commit(dir: string, message: string): Promise<string>;
  hasStagedChanges(dir: string): Promise<boolean>;
  headSha(dir: string): Promise<string>;
  commitsAhead(dir: string, baseSha: string): Promise<number>;
  push(dir: string, branch: string): Promise<void>;
  /** File content at a commit (undefined if absent). */
  readFileAt(dir: string, ref: string, path: string): Promise<string | undefined>;
  /** Current working-tree file content (undefined if absent). */
  readWorkingFile(dir: string, path: string): Promise<string | undefined>;
}

export interface GateViolation {
  path: string;
  reason: string;
}

export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
}

export interface FileReader {
  before(path: string): Promise<string | undefined>;
  after(path: string): Promise<string | undefined>;
}

/** Inspects the agent's diff before anything is committed. */
export interface DiffGate {
  inspect(changes: ChangedFile[], diff: string, reader?: FileReader): GateResult | Promise<GateResult>;
}

export const permissiveGate: DiffGate = { inspect: () => ({ ok: true, violations: [] }) };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export interface LoopDeps {
  config: ForemanConfig;
  state: StateStore;
  git: GitOps;
  /** Absent in dry-run without a token. */
  github?: GitHubApi;
  agents: AgentRunner;
  checks: CheckRunner;
  gate: DiffGate;
  roles: Record<Role, RoleDefinition>;
  isProtected: (relPath: string) => boolean;
  runId: string;
  dryRun: boolean;
  log: Logger;
  /** Per-task agent event log sink. */
  taskLog?: (taskId: string) => (line: string) => void;
  keepWorktrees?: boolean;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** An infrastructure error (API outage, network); the task is retried later. */
export class TransientError extends Error {
  override name = "TransientError";
}

/** Claude usage limit reached (subscription window or API 429). Pause until it resets. */
export class RateLimitError extends Error {
  override name = "RateLimitError";
  constructor(readonly resetsAt?: number) {
    super(`Claude usage limit reached${resetsAt ? ` (resets ${new Date(resetsAt).toISOString()})` : ""}`);
  }
}

const FINISHED = new Set(["done", "needs_human", "failed"]);

export function backoffMs(errorCount: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, errorCount - 1));
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

interface Ctx {
  task: Task;
  dir: string;
  branch: string;
  baseSha: string;
  signal: AbortSignal;
  started: number;
  models: string[];
  plan: string;
  lastChecks: CheckResult[];
  lastError: string;
  tlog: (line: string) => void;
  budget: Budget;
}

export class TaskRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly d: LoopDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? realSleep;
  }

  async runTask(task: Task): Promise<TaskOutcome> {
    const d = this.d;
    const started = this.now();
    const st0 = await d.state.ensure(task.id);

    if (FINISHED.has(st0.status) && !st0.forceRetry) {
      return this.outcome(task, "skipped", started, [], { reason: `already ${st0.status}` });
    }

    const budget = new Budget(d.config.limits, d.state, d.runId);
    const global = budget.globalExceeded();
    if (global) {
      return this.outcome(task, "deferred", started, [], { reason: limitText(global, d.config) });
    }

    const branch = branchFor(task.id);

    // Reconcile with GitHub: if state was lost (fresh CI cache, new machine)
    // but a PR already exists for this task, do not redo the work.
    if (!d.dryRun && d.github && !st0.forceRetry && st0.attempts === 0) {
      const pr = await d.github.findPrForBranch(branch).catch(() => undefined);
      if (pr && (pr.state === "open" || pr.merged)) {
        const status = pr.draft ? "needs_human" : "done";
        await d.state.updateTask(task.id, { status, prUrl: pr.url, prNumber: pr.number, branch, finishedAt: new Date(this.now()).toISOString() });
        return this.outcome(task, "skipped", started, [], { reason: `existing PR #${pr.number}`, prUrl: pr.url, prNumber: pr.number, branch });
      }
    }

    await d.state.updateTask(task.id, {
      status: "in_progress",
      startedAt: new Date(started).toISOString(),
      branch,
      dryRun: d.dryRun,
      forceRetry: false,
      lastError: undefined,
      notBefore: undefined,
    });
    d.log.info(`▶ ${task.id}: ${task.title}`);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), d.config.limits.maxMinutesPerTask * 60_000);
    const tlog = d.taskLog?.(task.id) ?? (() => {});
    const models: string[] = [];
    try {
      return await this.execute(task, { branch, signal: ctl.signal, started, models, tlog, budget });
    } catch (e) {
      const err = e as Error;
      tlog(`[error] ${err.stack ?? err.message}`);
      if (err instanceof RateLimitError) {
        const resume = err.resetsAt ?? this.now() + d.config.agent.rateLimitWaitMinutes * 60_000;
        const resumeAt = new Date(resume + 30_000).toISOString();
        d.log.warn(`  ⏸ ${err.message}; ${task.id} stays pending until ${resumeAt}`);
        await d.state.updateTask(task.id, { status: "pending", lastError: err.message, notBefore: resumeAt });
        return this.outcome(task, "deferred", started, models, { reason: err.message, resumeAt });
      }
      if (err instanceof BranchSafetyError) {
        d.log.error(`✖ ${task.id}: safety violation in runner: ${err.message}`);
        await d.state.updateTask(task.id, { status: "failed", lastError: err.message, finishedAt: new Date(this.now()).toISOString() });
        return this.outcome(task, "failed", started, models, { reason: err.message });
      }
      const st = d.state.get(task.id)!;
      const errorCount = (st.errorCount ?? 0) + 1;
      const notBefore = new Date(this.now() + backoffMs(errorCount)).toISOString();
      d.log.warn(`⚠ ${task.id}: ${err.message} (will retry after ${notBefore})`);
      await d.state.updateTask(task.id, { status: "pending", lastError: err.message, errorCount, notBefore });
      return this.outcome(task, "error", started, models, { reason: err.message });
    } finally {
      clearTimeout(timer);
      if (!d.keepWorktrees) await d.git.removeWorktree(task.id).catch(() => undefined);
    }
  }

  private async execute(
    task: Task,
    base: Pick<Ctx, "branch" | "signal" | "started" | "models" | "tlog" | "budget">,
  ): Promise<TaskOutcome> {
    const d = this.d;
    const cfg = d.config;
    try {
      await d.git.fetch();
    } catch (e) {
      throw new TransientError(`git fetch failed: ${(e as Error).message}`);
    }
    const wt = await d.git.createWorktree(task.id);
    const ctx: Ctx = { ...base, task, dir: wt.dir, baseSha: wt.baseSha, plan: "", lastChecks: [], lastError: "" };

    // ---- 1. plan --------------------------------------------------------------
    {
      const b = ctx.budget.status(task.id);
      if (b.exceeded) return this.stopForLimit(ctx, b.exceeded);
      const r = await this.callAgent(ctx, "planner", cfg.models.planner, plannerPrompt(task, cfg.checks), {
        readOnly: true,
        maxBudgetUsd: b.remainingUsd,
      });
      if (ctx.signal.aborted) return this.stopForLimit(ctx, "time");
      if (r.subtype === "rate_limited") throw new RateLimitError(r.resetsAt);
      if (r.ok) ctx.plan = r.text;
      else if (r.subtype === "exception") throw new TransientError(`planner failed: ${r.error}`);
      else if (r.subtype === "error_max_budget_usd") return this.stopForLimit(ctx, ctx.budget.status(task.id).binding);
      else d.log.warn(`  planner did not finish (${r.subtype}); coder will work from the task description`);
      ctx.tlog(`[plan]\n${ctx.plan}`);
    }

    // ---- 2..7. code → check → review → ship, with retries ---------------------
    const st = d.state.get(task.id)!;
    let failures = st.history.filter((h) => isFailure(h.outcome)).length;
    const stuck = new StuckDetector(cfg.limits.stuckThreshold, trailingSignatures(st.history));
    let feedback: { kind: FeedbackKind; text: string } | undefined;
    let session: { id: string; model: string } | undefined;
    let reviewRounds = 0;
    let pr: PullRequestRef | undefined;
    const canRunChecks = cfg.agent.allowBash;

    for (;;) {
      const cur = d.state.get(task.id)!;
      if (ctx.signal.aborted) return this.stopForLimit(ctx, "time");
      if (cur.attempts >= cfg.limits.maxAttemptsPerTask) return this.stopForLimit(ctx, "attempts");
      const b = ctx.budget.status(task.id);
      if (b.exceeded) return this.stopForLimit(ctx, b.exceeded);

      const n = cur.attempts + 1;
      await d.state.updateTask(task.id, { attempts: n });
      const escalated = failures >= cfg.limits.escalateAfterFailures;
      const model = escalated ? cfg.models.escalation : (task.model ?? cfg.models.coder);

      let prompt: string;
      let resume: string | undefined;
      if (!feedback) {
        prompt = coderPrompt(task, ctx.plan, cfg.checks, canRunChecks);
      } else if (session && session.model === model) {
        prompt = retryPrompt(feedback.kind, feedback.text, n, cfg.limits.maxAttemptsPerTask);
        resume = session.id;
      } else {
        if (escalated && session && session.model !== model) d.log.info(`  ↑ escalating to ${model}`);
        prompt = escalationPrompt(task, ctx.plan, cfg.checks, canRunChecks, historyTable(cur.history), feedback.kind, feedback.text);
      }
      d.log.info(`  attempt ${n}/${cfg.limits.maxAttemptsPerTask} (${model})`);

      const r = await this.callAgent(ctx, "coder", model, prompt, {
        readOnly: false,
        maxBudgetUsd: b.remainingUsd,
        ...(resume ? { resumeSessionId: resume } : {}),
      });
      if (r.sessionId) session = { id: r.sessionId, model };
      if (ctx.signal.aborted) {
        await this.record(ctx, n, model, "error", "task time limit reached during coding", r.costUsd);
        return this.stopForLimit(ctx, "time");
      }

      // record a failed attempt and decide whether to keep going
      const fail = async (kind: FeedbackKind | "error", text: string): Promise<boolean> => {
        failures++;
        const sig = errorSignature(text);
        ctx.lastError = text;
        await this.record(ctx, n, model, kind, firstLine(text), r.costUsd, sig);
        feedback = { kind: kind === "error" ? "check_failed" : kind, text };
        const isStuck = stuck.record(sig);
        d.log.info(`  ✗ ${kind}: ${firstLine(text)}`);
        return isStuck;
      };

      if (!r.ok) {
        if (r.subtype === "rate_limited") {
          // Usage limit: not the agent's fault. Give the attempt back and pause.
          await d.state.updateTask(task.id, { attempts: n - 1 });
          throw new RateLimitError(r.resetsAt);
        }
        if (r.subtype === "exception") {
          // API/network failure: not the agent's fault. Give the attempt back and retry later.
          await d.state.updateTask(task.id, { attempts: n - 1 });
          throw new TransientError(`Claude call failed: ${r.error}`);
        }
        if (r.subtype === "error_max_budget_usd") {
          await this.record(ctx, n, model, "error", "spend cap reached during coding", r.costUsd);
          return this.stopForLimit(ctx, ctx.budget.status(task.id).binding);
        }
        if (r.subtype !== "error_max_turns") {
          if (await fail("error", r.error ?? r.subtype)) return this.stopForLimit(ctx, "stuck");
          continue;
        }
        // max turns: the work may still be complete; fall through to verification.
      }

      // ---- diff gate ---------------------------------------------------------
      const changes = await d.git.stagedChanges(ctx.dir, ctx.baseSha);
      if (changes.length === 0) {
        if (await fail("check_failed", "No files were changed. Implement the task by editing files in the working directory.")) {
          return this.stopForLimit(ctx, "stuck");
        }
        continue;
      }
      const diff = await d.git.stagedDiff(ctx.dir, ctx.baseSha);
      const gate = await d.gate.inspect(changes, diff, this.reader(ctx));
      if (!gate.ok) {
        await d.git.restorePaths(ctx.dir, ctx.baseSha, uniquePaths(gate.violations));
        const text = "Safety rules violated:\n" + gate.violations.map((v) => `- ${v.path}: ${v.reason}`).join("\n");
        if (await fail("rejected", text)) return this.stopForLimit(ctx, "stuck");
        continue;
      }

      // ---- checks (run by the runner, never trusted from the agent) ----------
      const run = await d.checks.run(ctx.dir, ctx.signal);
      ctx.lastChecks = run.results;
      if (ctx.signal.aborted) {
        await this.record(ctx, n, model, "error", "task time limit reached during checks", r.costUsd);
        return this.stopForLimit(ctx, "time");
      }
      if (!run.ok) {
        if (await fail("check_failed", run.failureOutput)) return this.stopForLimit(ctx, "stuck");
        continue;
      }
      stuck.reset();

      // ---- review ------------------------------------------------------------
      let review: ReviewVerdict | undefined;
      if (cfg.review.enabled) {
        const rb = ctx.budget.status(task.id);
        if (rb.exceeded) return this.stopForLimit(ctx, rb.exceeded);
        const rr = await this.callAgent(
          ctx,
          "reviewer",
          cfg.models.reviewer,
          reviewerPrompt(task, await d.git.stagedDiff(ctx.dir, ctx.baseSha, 3), checksSummary(run.results)),
          { readOnly: true, maxBudgetUsd: rb.remainingUsd, outputSchema: REVIEW_SCHEMA as unknown as Record<string, unknown> },
        );
        if (ctx.signal.aborted) return this.stopForLimit(ctx, "time");
        review = rr.ok ? parseReview(rr.structured, rr.text) : undefined;
        // (a usage limit during review also lands here: checks passed, so ship rather than lose the work)
        if (!review) d.log.warn(`  reviewer gave no usable verdict (${rr.subtype}); proceeding on passing checks`);
        if (review?.verdict === "request_changes" && reviewRounds < cfg.review.maxRounds) {
          reviewRounds++;
          const text = [review.summary, ...review.issues.map((i) => `- ${i}`)].join("\n");
          await this.record(ctx, n, model, "review_changes", firstLine(review.summary || text), r.costUsd + rr.costUsd);
          feedback = { kind: "review_changes", text };
          d.log.info(`  ↺ reviewer requested changes`);
          continue;
        }
      }

      // ---- ship ----------------------------------------------------------------
      await this.record(ctx, n, model, "pass", "checks passed", r.costUsd);
      const summary = r.text.trim();
      const diffStat = await d.git.diffStat(ctx.dir, ctx.baseSha);
      const sha = (await d.git.hasStagedChanges(ctx.dir))
        ? await d.git.commit(ctx.dir, commitMessage(task, summary, n))
        : await d.git.headSha(ctx.dir);
      const done = d.state.get(task.id)!;
      const body = successPrBody({
        task,
        summary,
        diffStat,
        checks: run.results,
        attempts: done.attempts,
        costUsd: done.costUsd,
        durationMs: this.now() - ctx.started,
        models: ctx.models,
        history: done.history,
        ...(review ? { review } : {}),
      });

      if (d.dryRun || !d.github) {
        d.log.info(`  ✔ checks passed${d.dryRun ? " (dry run: not pushing, no PR)" : ""}`);
        await d.state.updateTask(task.id, { status: "done", finishedAt: new Date(this.now()).toISOString() });
        return this.outcome(task, "done", ctx.started, ctx.models, { branch: ctx.branch, summary, prBody: body, checks: run.results });
      }

      await d.git.push(ctx.dir, ctx.branch);
      pr = await this.openOrUpdatePr(pr, {
        head: ctx.branch,
        base: cfg.baseBranch,
        title: `foreman: ${task.title}`,
        body,
        draft: cfg.pr.draft,
        labels: cfg.pr.labels,
      });
      await d.state.updateTask(task.id, { prUrl: pr.url, prNumber: pr.number });
      d.log.info(`  ✔ PR ${pr.url}`);

      if (cfg.ci.wait) {
        const ci = await this.waitForCi(sha, ctx.signal);
        if (ci.state === "failure") {
          if (await fail("ci_failed", ci.details || "GitHub CI failed (no details available).")) {
            return this.stopForLimit(ctx, "stuck", pr);
          }
          continue;
        }
        if (ci.state === "pending") d.log.warn(`  CI still pending after ${cfg.ci.timeoutMinutes} min; leaving PR for review`);
      }

      await d.state.updateTask(task.id, { status: "done", finishedAt: new Date(this.now()).toISOString(), errorCount: 0 });
      return this.outcome(task, "done", ctx.started, ctx.models, {
        branch: ctx.branch,
        prUrl: pr.url,
        prNumber: pr.number,
        summary,
        prBody: body,
        checks: run.results,
      });
    }
  }

  // ---- helpers -------------------------------------------------------------

  private reader(ctx: Ctx): FileReader {
    return {
      before: (p) => this.d.git.readFileAt(ctx.dir, ctx.baseSha, p),
      after: (p) => this.d.git.readWorkingFile(ctx.dir, p),
    };
  }

  private async callAgent(
    ctx: Ctx,
    role: Role,
    model: string,
    prompt: string,
    extra: Pick<AgentCall, "readOnly" | "maxBudgetUsd"> & Partial<Pick<AgentCall, "resumeSessionId" | "outputSchema">>,
  ): Promise<AgentResult> {
    const d = this.d;
    ctx.models.push(model);
    ctx.tlog(`\n===== ${role} (${model}) =====\n${prompt}\n`);
    const r = await d.agents.run({
      role,
      model,
      systemPrompt: d.roles[role].prompt,
      prompt,
      cwd: ctx.dir,
      allowBash: d.config.agent.allowBash,
      allowedCommands: role === "coder" ? [...d.config.checks.map((c) => c.run), ...d.config.agent.extraAllowedCommands] : [],
      isProtected: d.isProtected,
      maxTurns: d.config.limits.maxTurnsPerCall,
      signal: ctx.signal,
      onEvent: ctx.tlog,
      ...extra,
    });
    await d.state.addSpend(r.costUsd, ctx.task.id, d.runId);
    ctx.tlog(`[${role} result] ok=${r.ok} subtype=${r.subtype} cost=$${r.costUsd.toFixed(4)}\n${r.text}`);
    return r;
  }

  private async record(
    ctx: Ctx,
    n: number,
    model: string,
    outcome: AttemptRecord["outcome"],
    summary: string,
    costUsd: number,
    signature?: string,
  ): Promise<void> {
    await this.d.state.recordAttempt(ctx.task.id, {
      n,
      model,
      outcome,
      summary,
      costUsd,
      ...(signature ? { signature } : {}),
    });
  }

  private async openOrUpdatePr(
    existing: PullRequestRef | undefined,
    input: { head: string; base: string; title: string; body: string; draft: boolean; labels: string[] },
  ): Promise<PullRequestRef> {
    const gh = this.d.github!;
    const pr = existing ?? (await gh.findPrForBranch(input.head));
    if (pr && pr.state === "open") {
      await gh.updatePr(pr.number, { body: input.body, title: input.title });
      return pr;
    }
    return gh.createPr(input);
  }

  private async waitForCi(sha: string, signal: AbortSignal): Promise<{ state: "success" | "failure" | "pending" | "none"; details: string }> {
    const cfg = this.d.config.ci;
    const start = this.now();
    const deadline = start + cfg.timeoutMinutes * 60_000;
    this.d.log.info(`  waiting for CI on ${sha.slice(0, 8)}…`);
    for (;;) {
      await this.sleep(cfg.pollSeconds * 1000, signal);
      if (signal.aborted) return { state: "pending", details: "" };
      let s;
      try {
        s = await this.d.github!.ciStatus(sha);
      } catch (e) {
        this.d.log.warn(`  CI status error: ${(e as Error).message}`);
        s = { state: "pending" as const, details: "" };
      }
      if (s.state === "success" || s.state === "failure") return s;
      // No checks registered after a grace period: repo has no CI for this branch.
      if (s.state === "none" && this.now() - start >= 3 * 60_000) return s;
      if (this.now() >= deadline) return { state: "pending", details: "" };
    }
  }

  /** Per-task limits → needs-human; global spend caps → deferred. */
  private async stopForLimit(ctx: Ctx, kind: LimitKind, pr?: PullRequestRef): Promise<TaskOutcome> {
    const d = this.d;
    const reason = limitText(kind, d.config);
    if (kind === "run_spend" || kind === "day_spend") {
      d.log.warn(`  ⏸ ${reason}; ${ctx.task.id} stays pending`);
      await d.state.updateTask(ctx.task.id, { status: "pending", lastError: `deferred: ${reason}` });
      return this.outcome(ctx.task, "deferred", ctx.started, ctx.models, { reason, branch: ctx.branch, checks: ctx.lastChecks });
    }

    d.log.warn(`  ✋ ${ctx.task.id}: ${reason} → needs human`);
    const st = d.state.get(ctx.task.id)!;
    const body = failureReport({
      task: ctx.task,
      reason,
      lastError: ctx.lastError,
      history: st.history,
      checks: ctx.lastChecks,
      attempts: st.attempts,
      costUsd: st.costUsd,
      durationMs: this.now() - ctx.started,
      plan: ctx.plan,
    });

    let prRef = pr;
    if (!d.dryRun && d.github) {
      try {
        prRef = await this.publishFailure(ctx, body, pr);
      } catch (e) {
        d.log.error(`  could not publish failure report: ${(e as Error).message}`);
      }
    }
    await d.state.updateTask(ctx.task.id, {
      status: "needs_human",
      lastError: reason,
      finishedAt: new Date(this.now()).toISOString(),
      ...(prRef ? { prUrl: prRef.url, prNumber: prRef.number } : {}),
    });
    return this.outcome(ctx.task, "needs_human", ctx.started, ctx.models, {
      reason,
      branch: ctx.branch,
      checks: ctx.lastChecks,
      prBody: body,
      ...(prRef ? { prUrl: prRef.url, prNumber: prRef.number } : {}),
    });
  }

  /** Commit salvageable WIP (minus safety violations), push, and open/label a draft PR. */
  private async publishFailure(ctx: Ctx, body: string, existing?: PullRequestRef): Promise<PullRequestRef | undefined> {
    const d = this.d;
    const gh = d.github!;
    const labels = [...d.config.pr.labels, d.config.pr.needsHumanLabel];

    let changes = await d.git.stagedChanges(ctx.dir, ctx.baseSha);
    if (changes.length) {
      const gate = await d.gate.inspect(changes, await d.git.stagedDiff(ctx.dir, ctx.baseSha), this.reader(ctx));
      if (!gate.ok) await d.git.restorePaths(ctx.dir, ctx.baseSha, uniquePaths(gate.violations));
      await d.git.stagedChanges(ctx.dir, ctx.baseSha); // re-stage after restore
      if (await d.git.hasStagedChanges(ctx.dir)) {
        await d.git.commit(ctx.dir, `foreman(${ctx.task.id}): work in progress (needs human)\n\nForeman stopped: limits reached.`);
      }
    }

    const ahead = await d.git.commitsAhead(ctx.dir, ctx.baseSha);
    if (ahead > 0) {
      await d.git.push(ctx.dir, ctx.branch);
      const pr = existing ?? (await gh.findPrForBranch(ctx.branch));
      if (pr && pr.state === "open") {
        await gh.comment(pr.number, body);
        await gh.addLabels(pr.number, [d.config.pr.needsHumanLabel]);
        return pr;
      }
      return gh.createPr({
        head: ctx.branch,
        base: d.config.baseBranch,
        title: `[needs-human] foreman: ${ctx.task.title}`,
        body,
        draft: true,
        labels,
      });
    }
    // Nothing to put in a PR (GitHub rejects empty PRs). Report on the issue if there is one.
    if (ctx.task.issueNumber) {
      await gh.comment(ctx.task.issueNumber, body);
      await gh.addLabels(ctx.task.issueNumber, [d.config.pr.needsHumanLabel]);
    }
    return undefined;
  }

  private outcome(
    task: Task,
    status: OutcomeStatus,
    started: number,
    models: string[],
    extra: Partial<TaskOutcome> & { prBody?: string } = {},
  ): TaskOutcome {
    const st = this.d.state.get(task.id);
    return {
      taskId: task.id,
      title: task.title,
      status,
      dryRun: this.d.dryRun,
      attempts: st?.attempts ?? 0,
      costUsd: st?.costUsd ?? 0,
      durationMs: this.now() - started,
      models: [...new Set(models)],
      checks: [],
      history: st?.history ?? [],
      ...(st?.prUrl && !extra.prUrl ? { prUrl: st.prUrl, prNumber: st.prNumber } : {}),
      ...extra,
    };
  }
}

function isFailure(o: AttemptRecord["outcome"]): boolean {
  return o === "check_failed" || o === "rejected" || o === "ci_failed" || o === "error";
}

/** Signatures of the trailing run of failures (for resuming stuck detection after a restart). */
function trailingSignatures(history: AttemptRecord[]): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.outcome === "review_changes") continue;
    if (!isFailure(h.outcome) || !h.signature) break;
    out.unshift(h.signature);
  }
  return out;
}

function uniquePaths(v: Array<{ path: string }>): string[] {
  return [...new Set(v.map((x) => x.path))];
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("$") && !l.startsWith("(exit")) ?? s.trim();
  return line.slice(0, 200);
}

export function limitText(kind: LimitKind, cfg: ForemanConfig): string {
  const l = cfg.limits;
  switch (kind) {
    case "attempts":
      return `reached the maximum of ${l.maxAttemptsPerTask} attempts`;
    case "time":
      return `reached the ${l.maxMinutesPerTask}-minute time limit`;
    case "task_spend":
      return `reached the per-task spend cap ($${l.maxSpendPerTaskUsd})`;
    case "run_spend":
      return `reached the per-run spend cap ($${l.maxSpendPerRunUsd})`;
    case "day_spend":
      return `reached the daily spend cap ($${l.maxSpendPerDayUsd})`;
    case "stuck":
      return `stuck: the same error occurred ${l.stuckThreshold} times in a row`;
  }
}

export function commitMessage(task: Task, summary: string, attempts: number): string {
  const subject = `foreman(${task.id}): ${task.title}`.slice(0, 72);
  const body = summary.trim().slice(0, 4000);
  return [
    subject,
    "",
    body,
    "",
    `Foreman-Task: ${task.id}`,
    `Foreman-Attempts: ${attempts}`,
    ...(task.issueNumber ? [`Refs: #${task.issueNumber}`] : []),
  ].join("\n");
}
