import type { ForemanConfig } from "./config.js";
import type { GitHubApi } from "./github.js";
import { backoffMs, type Logger } from "./loop.js";
import { writeRunReport, type RunReport, type TaskOutcome } from "./report.js";
import type { StateStore } from "./state.js";
import { sortByPriority, taskFromIssue, type Task } from "./tasks.js";

export interface TaskExecutor {
  runTask(task: Task): Promise<TaskOutcome>;
}

export interface OrchestratorDeps {
  config: ForemanConfig;
  state: StateStore;
  github?: GitHubApi;
  log: Logger;
  dryRun: boolean;
  reportsDir: string;
  /** Loads tasks from tasks.yaml (working tree or remote base branch). */
  loadFileTasks: () => Promise<Task[]>;
  /** Builds a TaskRunner bound to a run id. */
  makeExecutor: (runId: string) => TaskExecutor;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunOptions {
  taskId?: string;
  retry?: boolean;
  /** Checked between tasks; a set signal stops after the current task. */
  signal?: AbortSignal;
}

export class Orchestrator {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep =
      d.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          const t = setTimeout(resolve, ms);
          signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
        }));
  }

  /** tasks.yaml plus (optionally) open GitHub issues labeled for foreman. */
  async collectTasks(): Promise<Task[]> {
    const tasks = await this.d.loadFileTasks();
    const ids = new Set(tasks.map((t) => t.id.toLowerCase()));
    if (this.d.config.issues.enabled && this.d.github) {
      try {
        const issues = await this.d.github.listLabeledIssues(this.d.config.issues.label);
        for (const issue of issues) {
          const t = taskFromIssue(issue);
          if (!ids.has(t.id.toLowerCase())) {
            tasks.push(t);
            ids.add(t.id.toLowerCase());
          }
        }
      } catch (e) {
        this.d.log.warn(`Could not list GitHub issues: ${(e as Error).message}`);
      }
    }
    return tasks;
  }

  /** Pending tasks whose backoff has expired, highest priority first. */
  runnable(tasks: Task[]): Task[] {
    const now = this.now();
    return sortByPriority(
      tasks.filter((t) => {
        const st = this.d.state.get(t.id);
        if (!st) return true;
        if (st.status !== "pending") return false;
        return !st.notBefore || Date.parse(st.notBefore) <= now;
      }),
    );
  }

  /** Process runnable tasks once, then write a run report. */
  async runOnce(opts: RunOptions = {}): Promise<RunReport> {
    const d = this.d;
    const recovered = await d.state.recoverInterrupted();
    if (recovered.requeued.length) d.log.warn(`Recovered interrupted task(s): ${recovered.requeued.join(", ")}`);
    if (recovered.failed.length) d.log.error(`Gave up on repeatedly interrupted task(s): ${recovered.failed.join(", ")}`);

    const all = await this.collectTasks();
    let queue: Task[];
    if (opts.taskId) {
      const t = all.find((x) => x.id === opts.taskId);
      if (!t) throw new Error(`Task "${opts.taskId}" not found in ${d.config.tasksFile}${d.config.issues.enabled ? " or labeled issues" : ""}`);
      if (opts.retry) await d.state.reset(t.id);
      const st = d.state.get(t.id);
      if (st?.notBefore && !opts.retry) await d.state.updateTask(t.id, { notBefore: undefined });
      queue = [t];
    } else {
      queue = this.runnable(all);
    }

    const run = await d.state.startRun(d.dryRun);
    const startedAt = new Date(this.now()).toISOString();
    const executor = d.makeExecutor(run.id);
    const outcomes: TaskOutcome[] = [];
    let stoppedReason: string | undefined;

    if (!queue.length) d.log.info("No runnable tasks.");
    for (const task of queue) {
      if (opts.signal?.aborted) {
        stoppedReason = "shutdown requested";
        break;
      }
      const out = await executor.runTask(task);
      outcomes.push(out);
      await d.state.updateRun(run.id, { tasks: outcomes.map((o) => o.taskId) });
      if (out.status === "deferred") {
        stoppedReason = out.reason ?? "spend cap reached";
        break;
      }
    }

    const report: RunReport = {
      runId: run.id,
      startedAt,
      finishedAt: new Date(this.now()).toISOString(),
      dryRun: d.dryRun,
      totalCostUsd: d.state.runCost(run.id),
      spentTodayUsd: d.state.spentToday(),
      ...(stoppedReason ? { stoppedReason } : {}),
      tasks: outcomes,
    };
    await d.state.updateRun(run.id, { finishedAt: report.finishedAt });
    if (outcomes.length) {
      const files = await writeRunReport(d.reportsDir, report);
      d.log.info(`Report: ${files.md}`);
    }
    return report;
  }

  /**
   * Continuous mode: process runnable tasks, then idle and poll. Pauses until
   * the next day when the daily cap is reached. Infrastructure errors back
   * off exponentially. Returns when `signal` is aborted.
   */
  async watch(signal: AbortSignal, hooks: { onCycle?: (r: RunReport) => void } = {}): Promise<void> {
    const d = this.d;
    const pollMs = d.config.watch.pollSeconds * 1000;
    let errors = 0;
    d.log.info(`Watching for tasks (poll every ${d.config.watch.pollSeconds}s). Ctrl+C to stop after the current task.`);
    while (!signal.aborted) {
      let waitMs = pollMs;
      try {
        const report = await this.runOnce({ signal });
        hooks.onCycle?.(report);
        errors = 0;
        if (d.state.spentToday() >= d.config.limits.maxSpendPerDayUsd - 0.05) {
          const resume = d.state.nextDayStart();
          waitMs = Math.max(60_000, resume.getTime() - this.now() + 30_000);
          d.log.warn(`Daily spend cap reached ($${d.state.spentToday().toFixed(2)}). Pausing until ${resume.toISOString()}.`);
        } else {
          waitMs = Math.min(pollMs, this.untilNextBackoff() ?? pollMs);
        }
      } catch (e) {
        errors++;
        waitMs = backoffMs(errors);
        d.log.error(`Cycle failed (${errors} in a row): ${(e as Error).message}. Retrying in ${Math.round(waitMs / 1000)}s.`);
      }
      if (signal.aborted) break;
      await this.sleep(waitMs, signal);
    }
    d.log.info("Watch stopped.");
  }

  /** ms until the earliest pending task's backoff expires, if any. */
  private untilNextBackoff(): number | undefined {
    const now = this.now();
    const times = this.d.state
      .all()
      .filter((t) => t.status === "pending" && t.notBefore)
      .map((t) => Date.parse(t.notBefore!) - now)
      .filter((ms) => ms > 0);
    return times.length ? Math.max(1000, Math.min(...times)) : undefined;
  }
}
