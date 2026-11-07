#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CONFIG_FILE, ConfigError, loadConfig } from "./config.js";
import { execFile } from "./exec.js";
import type { OutcomeStatus, RunReport } from "./report.js";
import { createRuntime } from "./runtime.js";
import { acquireLock, LockError, StateStore, STATE_DIR } from "./state.js";
import { loadTasks, sortByPriority, TasksError } from "./tasks.js";
import { configTemplate, detectProject, TASKS_TEMPLATE } from "./templates.js";

const HELP = `foreman: autonomous task → Claude → verified PR orchestrator

Usage:
  foreman init [--force]              Write example foreman.config.yaml and tasks.yaml
  foreman run [--task <id>] [--retry] Process pending tasks once, then exit
  foreman dry-run [--task <id>]       Like run, but never pushes or opens PRs
  foreman watch                       Run continuously: process, idle, poll again
  foreman status [--json]             Show task status, spend and the last run

Options:
  --repo <dir>          Target repository (default: current directory)
  --task <id>           Only this task
  --retry               With --task: reset a finished/needs-human task and run it again
  --dry-run             Do everything except push and open PRs
  --tasks-from-remote   Read tasks.yaml from <remote>/<baseBranch> instead of the working tree
  --keep-worktrees      Keep task worktrees in .foreman/worktrees for debugging
  --force-unlock        Take over a lock held by another foreman process
  -v, --verbose         Print agent activity
  -h, --help            Show help
  --version             Show version

Environment:
  ANTHROPIC_API_KEY     Claude API key (passed to agents)
  GITHUB_TOKEN          GitHub token for push/PRs (never passed to agents).
                        FOREMAN_GITHUB_TOKEN or GH_TOKEN also work.

Exit codes: 0 ok (including needs-human outcomes), 1 error, 2 usage/config error.
`;

function version(): string {
  try {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        task: { type: "string" },
        retry: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "tasks-from-remote": { type: "boolean" },
        "keep-worktrees": { type: "boolean" },
        "force-unlock": { type: "boolean" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: o, positionals } = parsed;
  if (o.version) {
    console.log(version());
    return 0;
  }
  const cmd = positionals[0] ?? (o.help ? "help" : undefined);
  if (!cmd || cmd === "help" || o.help) {
    console.log(HELP);
    return cmd ? 0 : 2;
  }
  const repoDir = path.resolve(o.repo ?? process.cwd());

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(repoDir, Boolean(o.force));
      case "status":
        return await cmdStatus(repoDir, Boolean(o.json));
      case "run":
      case "dry-run":
      case "watch": {
        if (o.retry && !o.task) {
          console.error("--retry requires --task <id>");
          return 2;
        }
        if (cmd === "watch" && o.task) {
          console.error("watch processes the whole queue; use `foreman run --task <id>` for a single task");
          return 2;
        }
        return await cmdRun(repoDir, {
          watch: cmd === "watch",
          dryRun: cmd === "dry-run" || Boolean(o["dry-run"]),
          ...(o.task ? { taskId: o.task } : {}),
          retry: Boolean(o.retry),
          tasksFromRemote: Boolean(o["tasks-from-remote"]),
          keepWorktrees: Boolean(o["keep-worktrees"]),
          forceUnlock: Boolean(o["force-unlock"]),
          verbose: Boolean(o.verbose),
        });
      }
      default:
        console.error(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof TasksError || e instanceof LockError) {
      console.error(e.message);
      return 2;
    }
    console.error(`foreman: ${(e as Error).stack ?? (e as Error).message}`);
    return 1;
  }
}

interface RunFlags {
  watch: boolean;
  dryRun: boolean;
  taskId?: string;
  retry: boolean;
  tasksFromRemote: boolean;
  keepWorktrees: boolean;
  forceUnlock: boolean;
  verbose: boolean;
}

async function cmdRun(repoDir: string, f: RunFlags): Promise<number> {
  const release = await acquireLock(path.join(repoDir, STATE_DIR), { force: f.forceUnlock });
  const stop = new AbortController();
  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals === 1) {
      console.error(`\n${sig}: finishing the current task, then stopping. Press Ctrl+C again to abort immediately.`);
      stop.abort();
    } else {
      console.error(`\n${sig}: aborting now. The interrupted task will be requeued on next start.`);
      void release().finally(() => process.exit(130));
    }
  };
  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  try {
    const rt = await createRuntime({
      repoDir,
      dryRun: f.dryRun,
      verbose: f.verbose,
      keepWorktrees: f.keepWorktrees,
      tasksFromRemote: f.tasksFromRemote,
    });
    if (f.dryRun) rt.log.info("DRY RUN: nothing will be pushed and no PRs will be opened.");
    if (f.watch) {
      await rt.orchestrator.watch(stop.signal, { onCycle: (r) => r.tasks.length && printSummary(r) });
      return 0;
    }
    const report = await rt.orchestrator.runOnce({
      ...(f.taskId ? { taskId: f.taskId } : {}),
      retry: f.retry,
      signal: stop.signal,
    });
    printSummary(report);
    await writeGitHubStepSummary(report, repoDir);
    return report.tasks.some((t) => t.status === "error" || t.status === "failed") ? 1 : 0;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await release();
  }
}

const ICON: Record<OutcomeStatus, string> = {
  done: "✔",
  needs_human: "✋",
  deferred: "⏸",
  skipped: "·",
  failed: "✖",
  error: "⚠",
};

function printSummary(r: RunReport): void {
  console.log(`\nRun ${r.runId}${r.dryRun ? " (dry run)" : ""}: $${r.totalCostUsd.toFixed(2)} this run, $${r.spentTodayUsd.toFixed(2)} today`);
  for (const t of r.tasks) {
    console.log(
      `  ${ICON[t.status]} ${t.taskId.padEnd(24)} ${t.status.padEnd(11)} ${String(t.attempts).padStart(2)} att  $${t.costUsd.toFixed(2).padStart(6)}  ${t.prUrl ?? t.reason ?? ""}`,
    );
  }
  if (r.stoppedReason) console.log(`  stopped: ${r.stoppedReason}`);
}

/** In GitHub Actions, add the run report to the job summary. */
async function writeGitHubStepSummary(r: RunReport, repoDir: string): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file || !r.tasks.length) return;
  try {
    const md = await readFile(path.join(repoDir, STATE_DIR, "reports", `run-${r.runId}.md`), "utf8");
    await appendFile(file, md + "\n");
  } catch {
    /* best effort */
  }
}

async function cmdStatus(repoDir: string, json: boolean): Promise<number> {
  const config = await loadConfig(repoDir);
  const tasks = sortByPriority(await loadTasks(path.join(repoDir, config.tasksFile)));
  const state = await StateStore.open(path.join(repoDir, STATE_DIR), { dayBoundary: config.dayBoundary });
  const snap = state.snapshot();
  const rows = tasks.map((t) => {
    const s = snap.tasks[t.id];
    return {
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: s?.status ?? "pending",
      attempts: s?.attempts ?? 0,
      costUsd: s?.costUsd ?? 0,
      prUrl: s?.prUrl,
      lastError: s?.lastError,
      notBefore: s?.notBefore,
    };
  });
  // tasks known to state but no longer in tasks.yaml (e.g. from issues)
  for (const s of Object.values(snap.tasks)) {
    if (!rows.some((r) => r.id === s.id)) {
      rows.push({ id: s.id, title: "(not in tasks file)", priority: 0, status: s.status, attempts: s.attempts, costUsd: s.costUsd, prUrl: s.prUrl, lastError: s.lastError, notBefore: s.notBefore });
    }
  }
  const lastRun = snap.runs.at(-1);
  const summary = {
    repo: repoDir,
    spentTodayUsd: state.spentToday(),
    dailyCapUsd: config.limits.maxSpendPerDayUsd,
    lastRun,
    tasks: rows,
  };
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  console.log(`Spend today: $${summary.spentTodayUsd.toFixed(2)} / $${summary.dailyCapUsd.toFixed(2)}`);
  if (lastRun) console.log(`Last run:    ${lastRun.id} ($${lastRun.costUsd.toFixed(2)}${lastRun.dryRun ? ", dry run" : ""})`);
  console.log("");
  if (!rows.length) console.log("No tasks. Add some to " + config.tasksFile);
  for (const r of rows) {
    const extra = r.prUrl ?? (r.status === "pending" && r.notBefore ? `retry after ${r.notBefore}` : (r.lastError ?? ""));
    console.log(`  ${r.status.padEnd(11)} ${r.id.padEnd(24)} ${String(r.attempts).padStart(2)} att  $${r.costUsd.toFixed(2).padStart(6)}  ${r.title}${extra ? `  ${extra}` : ""}`);
  }
  return 0;
}

async function cmdInit(repoDir: string, force: boolean): Promise<number> {
  const cfgPath = path.join(repoDir, CONFIG_FILE);
  const tasksPath = path.join(repoDir, "tasks.yaml");
  const project = detectProject(repoDir);
  const base = await detectBaseBranch(repoDir);
  const written: string[] = [];
  for (const [file, content] of [
    [cfgPath, configTemplate(project, base)],
    [tasksPath, TASKS_TEMPLATE],
  ] as const) {
    if (existsSync(file) && !force) {
      console.log(`exists, skipped: ${path.relative(repoDir, file)} (use --force to overwrite)`);
      continue;
    }
    await writeFile(file, content);
    written.push(path.relative(repoDir, file));
  }
  const gi = path.join(repoDir, ".gitignore");
  const giText = existsSync(gi) ? await readFile(gi, "utf8") : "";
  if (!/^\/?\.foreman\/?$/m.test(giText)) {
    await writeFile(gi, `${giText.replace(/\n?$/, giText ? "\n" : "")}.foreman/\n`);
    written.push(".gitignore (+ .foreman/)");
  }
  for (const w of written) console.log(`wrote ${w}`);
  console.log(`\nDetected ${project.kind}; checks: ${project.checks.map((c) => c.run).join(" → ")}`);
  console.log("Next: review foreman.config.yaml, edit tasks.yaml, then `foreman dry-run`.");
  return 0;
}

async function detectBaseBranch(repoDir: string): Promise<string> {
  try {
    const res = await execFile("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir });
    if (res.code === 0) return res.stdout.trim().replace(/^origin\//, "");
    const cur = await execFile("git", ["branch", "--show-current"], { cwd: repoDir });
    if (cur.code === 0 && cur.stdout.trim()) return cur.stdout.trim();
  } catch {
    /* not a git repo */
  }
  return "main";
}

// Run when executed directly (bin), not when imported by tests.
const invokedDirectly = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const arg = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return arg === self || arg.replace(/\.js$/, "") === self.replace(/\.js$/, "") || /[\\/](foreman|claude-foreman)(\.cmd|\.js)?$/.test(arg);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
