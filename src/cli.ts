#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AuthError, resolveAuth, SdkAgentRunner, type AuthMode } from "./claude.js";
import { CONFIG_FILE, ConfigError, loadConfig, type ForemanConfig } from "./config.js";
import { renderDashboardHtml } from "./dashboard.js";
import { execFile } from "./exec.js";
import { sleepAbortable, tailLog } from "./logs.js";
import { summarizeModelUsage, type OutcomeStatus, type RunReport } from "./report.js";
import { findBrowser, renderScreens } from "./browser.js";
import { critiqueAndRefine, type CritiqueOutcome } from "./critique.js";
import { parseStoryDoc } from "./prompts.js";
import {
  approvePrototype,
  localPrototypeState,
  PrototypeError,
  prototypeLayout,
  writePrototype,
  type PrototypeState,
} from "./prototype.js";
import { loadRoles } from "./roles.js";
import { createRuntime } from "./runtime.js";
import { makeProtectedMatcher } from "./safety.js";
import { StoryError, writeStory } from "./story.js";
import { acquireLock, LockError, StateStore, STATE_DIR, usageOf } from "./state.js";
import { loadTasks, sortByPriority, TASK_ID_RE, TasksError } from "./tasks.js";
import { configTemplate, detectProject, TASKS_TEMPLATE } from "./templates.js";

const HELP = `foreman: autonomous task → Claude → verified PR orchestrator

Usage:
  foreman init [--force]              Write example foreman.config.yaml and tasks.yaml
  foreman story "<idea>" [--id <name>] Turn an idea into a story file to review (writes no code)
  foreman prototype <id> [--feedback "..."] [--open]
                                      Build (or revise) a clickable prototype of a story to approve
  foreman approve <id>                Approve the prototype so the real build can start
  foreman run [--task <id>] [--retry] Process pending tasks once, then exit
  foreman dry-run [--task <id>]       Like run, but never pushes or opens PRs
  foreman watch                       Run continuously: process, idle, poll again
  foreman status [--json]             Show task status, spend and the last run
  foreman dashboard [--open]          Write a local HTML snapshot (model usage, spend, tasks)
  foreman dashboard --watch [--open]  Keep refreshing that page while a run is in progress
  foreman logs [-f] [-n <lines>]      Show the run log (last 40 lines); -f keeps following it

Options:
  --repo <dir>          Target repository (default: current directory)
  --task <id>           Only this task
  --retry               With --task: reset a finished/needs-human task and run it again
  --dry-run             Do everything except push and open PRs
  --tasks-from-remote   Read tasks.yaml from <remote>/<baseBranch> instead of the working tree
  --keep-worktrees      Keep task worktrees in .foreman/worktrees for debugging
  --watch               With dashboard: keep rewriting the file until Ctrl+C
  --interval <seconds>  With dashboard --watch: refresh interval (default 5)
  --feedback <text>     With prototype: what to change in an existing prototype
  --no-critique         With prototype: skip the screenshot design review
  --force-unlock        Take over a lock held by another foreman process
  --auth <mode>         Claude credential: auto | subscription | api-key (overrides agent.auth)
  -v, --verbose         Print agent activity
  -h, --help            Show help
  --version             Show version

Environment:
  CLAUDE_CODE_OAUTH_TOKEN  Claude subscription token from 'claude setup-token' (preferred by auth=auto)
  ANTHROPIC_API_KEY        Anthropic API key, billed per use
  GITHUB_TOKEN             GitHub: token for push/PRs (FOREMAN_GITHUB_TOKEN, GH_TOKEN also work)
  FOREMAN_AZURE_TOKEN      Azure DevOps: PAT for push/PRs (AZURE_DEVOPS_EXT_PAT also works;
                           SYSTEM_ACCESSTOKEN in Azure Pipelines)
  Repository tokens are never passed to agents.

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
        auth: { type: "string" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        open: { type: "boolean" },
        watch: { type: "boolean" },
        interval: { type: "string" },
        follow: { type: "boolean", short: "f" },
        lines: { type: "string", short: "n" },
        id: { type: "string" },
        feedback: { type: "string" },
        "no-critique": { type: "boolean" },
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
      case "story": {
        const idea = positionals.slice(1).join(" ").trim();
        if (!idea) {
          console.error('Give the idea as text, e.g. foreman story "Let users export reports as PDF"');
          return 2;
        }
        return await cmdStory(repoDir, idea, {
          ...(o.id ? { id: o.id } : {}),
          ...(o.auth ? { auth: o.auth } : {}),
          forceUnlock: Boolean(o["force-unlock"]),
        });
      }
      case "prototype": {
        const id = positionals[1];
        if (!id) {
          console.error("Give the story id, e.g. foreman prototype export-reports-as-pdf");
          return 2;
        }
        return await cmdPrototype(repoDir, id, {
          ...(o.feedback ? { feedback: o.feedback } : {}),
          open: Boolean(o.open),
          noCritique: Boolean(o["no-critique"]),
          ...(o.auth ? { auth: o.auth } : {}),
          forceUnlock: Boolean(o["force-unlock"]),
        });
      }
      case "approve": {
        const id = positionals[1];
        if (!id) {
          console.error("Give the story id, e.g. foreman approve export-reports-as-pdf");
          return 2;
        }
        return await cmdApprove(repoDir, id);
      }
      case "logs": {
        const lines = o.lines ? Number(o.lines) : 40;
        if (!Number.isInteger(lines) || lines < 1) {
          console.error("--lines must be a positive whole number");
          return 2;
        }
        return await cmdLogs(repoDir, Boolean(o.follow), lines);
      }
      case "dashboard": {
        const interval = o.interval ? Number(o.interval) : 5;
        if (!Number.isFinite(interval) || interval <= 0) {
          console.error("--interval must be a positive number of seconds");
          return 2;
        }
        return await cmdDashboard(repoDir, Boolean(o.open), Boolean(o.watch), interval);
      }
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
          ...(o.auth ? { auth: o.auth } : {}),
          verbose: Boolean(o.verbose),
        });
      }
      default:
        console.error(`Unknown command: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof TasksError || e instanceof LockError || e instanceof AuthError) {
      console.error(e.message);
      return 2;
    }
    console.error(`foreman: ${(e as Error).stack ?? (e as Error).message}`);
    return 1;
  }
}

function parseAuthMode(v: string): AuthMode {
  if (v === "auto" || v === "subscription" || v === "api-key") return v;
  throw new ConfigError(`--auth must be auto, subscription or api-key (got "${v}")`);
}

interface RunFlags {
  watch: boolean;
  dryRun: boolean;
  taskId?: string;
  retry: boolean;
  tasksFromRemote: boolean;
  keepWorktrees: boolean;
  forceUnlock: boolean;
  auth?: string;
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
      ...(f.auth ? { auth: parseAuthMode(f.auth) } : {}),
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

async function loadStatusSummary(repoDir: string) {
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
  // Lifetime-ish: every agent call still tracked for every task currently in
  // state (the ledger is capped per task, so old calls eventually rotate out).
  const modelUsage = summarizeModelUsage(Object.values(snap.tasks).map(usageOf));
  return {
    repo: repoDir,
    tasksFile: config.tasksFile,
    models: config.models,
    spentTodayUsd: state.spentToday(),
    dailyCapUsd: config.limits.maxSpendPerDayUsd,
    modelUsage,
    lastRun,
    tasks: rows,
  };
}

async function cmdStatus(repoDir: string, json: boolean): Promise<number> {
  const summary = await loadStatusSummary(repoDir);
  const { modelUsage, lastRun, tasks: rows } = summary;
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  console.log("Models configured:");
  for (const [role, model] of Object.entries(summary.models)) console.log(`  ${role.padEnd(10)} ${model}`);
  console.log("");
  console.log(`Spend today: $${summary.spentTodayUsd.toFixed(2)} / $${summary.dailyCapUsd.toFixed(2)}`);
  if (lastRun) console.log(`Last run:    ${lastRun.id} ($${lastRun.costUsd.toFixed(2)}${lastRun.dryRun ? ", dry run" : ""})`);
  console.log("");
  if (modelUsage.length) {
    console.log("Model usage (tracked agent calls across all tasks):");
    for (const u of modelUsage) {
      console.log(`  ${u.model.padEnd(10)} ${String(u.calls).padStart(3)} calls  $${u.costUsd.toFixed(2).padStart(6)}  ${u.pctOfCost.toFixed(1).padStart(5)}%`);
    }
    console.log("");
  }
  if (!rows.length) console.log("No tasks. Add some to " + summary.tasksFile);
  for (const r of rows) {
    const extra = r.prUrl ?? (r.status === "pending" && r.notBefore ? `retry after ${r.notBefore}` : (r.lastError ?? ""));
    console.log(`  ${r.status.padEnd(11)} ${r.id.padEnd(24)} ${String(r.attempts).padStart(2)} att  $${r.costUsd.toFixed(2).padStart(6)}  ${r.title}${extra ? `  ${extra}` : ""}`);
  }
  return 0;
}

interface Stage {
  config: ForemanConfig;
  state: StateStore;
  roles: Awaited<ReturnType<typeof loadRoles>>;
  agents: SdkAgentRunner;
  authDescription: string;
  maxBudgetUsd: number;
  signal: AbortSignal;
  isProtected: (relPath: string) => boolean;
  /** Releases the lock and the Ctrl+C handlers. */
  done(): Promise<void>;
}

/**
 * Shared setup for the commands that make one agent call (story, prototype):
 * config, the same lock as run/watch (their spend goes to the shared state
 * file), a daily-cap check and Claude auth. Returns an exit code when it can't start.
 */
async function startStage(repoDir: string, o: { auth?: string; forceUnlock: boolean }): Promise<Stage | number> {
  const config = await loadConfig(repoDir);
  const stateDir = path.join(repoDir, STATE_DIR);
  const release = await acquireLock(stateDir, { force: o.forceUnlock });
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const done = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await release();
  };
  try {
    const state = await StateStore.open(stateDir, { dayBoundary: config.dayBoundary });
    const remaining = config.limits.maxSpendPerDayUsd - state.spentToday();
    if (remaining <= 0) {
      console.error(`Daily spend cap reached ($${state.spentToday().toFixed(2)} of $${config.limits.maxSpendPerDayUsd.toFixed(2)}). Try again after it resets.`);
      await done();
      return 1;
    }
    const auth = resolveAuth(o.auth ? parseAuthMode(o.auth) : config.agent.auth);
    return {
      config,
      state,
      roles: await loadRoles(),
      agents: new SdkAgentRunner({ envPassthrough: config.agent.envPassthrough, sandbox: config.agent.sandbox, auth }),
      authDescription: auth.description,
      maxBudgetUsd: Math.min(remaining, config.limits.maxSpendPerTaskUsd ?? Infinity),
      signal: stop.signal,
      isProtected: makeProtectedMatcher(config),
      done,
    };
  } catch (e) {
    await done();
    throw e;
  }
}

async function cmdStory(repoDir: string, idea: string, o: { id?: string; auth?: string; forceUnlock: boolean }): Promise<number> {
  const stage = await startStage(repoDir, o);
  if (typeof stage === "number") return stage;
  const { config, state } = stage;
  try {
    console.log(`Writing a story with ${config.models.analyst} (${stage.authDescription})...`);
    let result;
    try {
      result = await writeStory({
        repoDir,
        idea,
        ...(o.id ? { id: o.id } : {}),
        config,
        agents: stage.agents,
        systemPrompt: stage.roles.analyst.prompt,
        isProtected: stage.isProtected,
        maxBudgetUsd: stage.maxBudgetUsd,
        signal: stage.signal,
      });
    } catch (e) {
      if (e instanceof StoryError) {
        if (e.costUsd > 0) await state.addSpend(e.costUsd);
        console.error(e.message);
        return 1;
      }
      throw e;
    }
    await state.addSpend(result.costUsd);
    console.log(`\nWrote ${result.file}`);
    console.log(`  ${result.title ?? "(no title found)"}`);
    console.log(`  ${result.acceptance.length} acceptance criteria · $${result.costUsd.toFixed(2)}`);
    if (!result.acceptance.length) console.log("  Warning: no acceptance criteria were found. Open the file and add them.");
    console.log(`\nNext: read and edit it. To see it as a clickable prototype before anything is built:`);
    console.log(`  foreman prototype ${result.id}`);
    console.log(`To build it directly instead: commit and push the story to origin/${config.baseBranch} (the build only sees what is there), then add to ${config.tasksFile}:`);
    console.log(`  - id: ${result.id}`);
    console.log(`    prompt: ${JSON.stringify(idea)}`);
    if (!config.docs.enabled) console.log("Also set `docs.enabled: true` in foreman.config.yaml so tasks use story docs.");
    return 0;
  } finally {
    await stage.done();
  }
}

function prototypeNext(id: string, state: PrototypeState, config: ForemanConfig): string {
  const dir = prototypeLayout(config, id).dir;
  switch (state) {
    case "approved":
      return `Approved. Commit and push ${dir}/ (including approval.json) to origin/${config.baseBranch} so the build can see it, then run foreman.`;
    case "stale":
      return `It changed after it was approved. Run \`foreman approve ${id}\` again.`;
    default:
      return `Open it in a browser. Happy with it? Run \`foreman approve ${id}\`. Want changes? Run \`foreman prototype ${id} --feedback "what to change"\`.`;
  }
}

function printCritique(outcome: CritiqueOutcome): void {
  const n = outcome.rounds.length;
  console.log(`\nDesign review: ${n} review${n === 1 ? "" : "s"}, $${outcome.costUsd.toFixed(2)}`);
  for (const r of outcome.rounds) {
    const majors = r.critique.issues.filter((i) => i.severity === "major").length;
    const minors = r.critique.issues.length - majors;
    const found = r.critique.issues.length ? `${majors} major, ${minors} minor` : "no issues";
    console.log(`  ${r.round}. ${r.critique.verdict === "approve" ? "approved" : "needed changes"} (${found})${r.revised ? ", fixed by the designer" : ""}`);
  }
  const last = outcome.rounds.at(-1);
  if (last?.critique.issues.length) {
    console.log(last.critique.verdict === "revise" ? "  Still open when it stopped:" : "  Notes:");
    for (const i of last.critique.issues) console.log(`    [${i.severity}]${i.where ? ` (${i.where})` : ""} ${i.problem}`);
  }
  if (outcome.layoutIssues.length) {
    console.log("  The browser measured these layout problems:");
    for (const l of outcome.layoutIssues) console.log(`    ${l}`);
  }
  if (outcome.consoleIssues.length) {
    console.log("  The page logged these in the browser:");
    for (const c of outcome.consoleIssues) console.log(`    ${c}`);
  }
  if (outcome.stopped) console.log(`  Stopped early: ${outcome.stopped}`);
  if (last) console.log(`  Screenshots the critic saw: ${outcome.screensDir}/`);
}

async function cmdPrototype(
  repoDir: string,
  id: string,
  o: { feedback?: string; open: boolean; noCritique: boolean; auth?: string; forceUnlock: boolean },
): Promise<number> {
  if (!TASK_ID_RE.test(id) || id.includes("..")) {
    console.error(`"${id}" is not a usable story id: use 1-64 letters, digits, '.', '_' or '-'.`);
    return 2;
  }
  const config = await loadConfig(repoDir);
  const layout = prototypeLayout(config, id);
  const file = path.join(repoDir, layout.index);
  const existing = await localPrototypeState(repoDir, config, id);
  if (existing !== "none" && !o.feedback) {
    // Nothing to build: say where it stands (and show it) without an agent call.
    console.log(`The prototype for ${id} is ${existing}: ${file}`);
    console.log(prototypeNext(id, existing, config));
    if (o.open) openInBrowser(file);
    return 0;
  }

  const stage = await startStage(repoDir, o);
  if (typeof stage === "number") return stage;
  try {
    console.log(`${o.feedback ? "Revising" : "Building"} the prototype with ${config.models.designer} (${stage.authDescription}). This can take a few minutes...`);
    let result;
    try {
      result = await writePrototype({
        repoDir,
        id,
        ...(o.feedback ? { feedback: o.feedback } : {}),
        config,
        agents: stage.agents,
        systemPrompt: stage.roles.designer.prompt,
        isProtected: stage.isProtected,
        maxBudgetUsd: stage.maxBudgetUsd,
        signal: stage.signal,
      });
    } catch (e) {
      if (e instanceof PrototypeError) {
        if (e.costUsd > 0) await stage.state.addSpend(e.costUsd);
        console.error(e.message);
        return 1;
      }
      throw e;
    }
    await stage.state.addSpend(result.costUsd);
    console.log(`\n${result.revised ? "Revised" : "Wrote"} ${layout.index} · $${result.costUsd.toFixed(2)}`);
    console.log(`  ${file}`);
    if (result.externalRefs.length) {
      console.log("  Warning: it referenced outside resources. The browser blocks them, so it may not look as intended:");
      for (const ref of result.externalRefs) console.log(`    ${ref}`);
    }
    const review = config.prototype.critique;
    if (review.enabled && !o.noCritique) {
      const explicit = config.prototype.browser ?? process.env.FOREMAN_BROWSER;
      const browser = findBrowser(config.prototype.browser ? { configured: config.prototype.browser } : {});
      if (!browser) {
        console.log(
          explicit
            ? `\nSkipped the design review: the browser you set (${explicit}) was not found.`
            : "\nSkipped the design review: no Chrome, Edge or Chromium was found. Install one, or set prototype.browser or FOREMAN_BROWSER. Pass --no-critique to silence this.",
        );
      } else {
        console.log(
          `\nReviewing the design in ${path.basename(browser)}: screenshots at desktop, mobile and dark mode, up to ${review.maxRevisions} fix round${review.maxRevisions === 1 ? "" : "s"}...`,
        );
        const outcome = await critiqueAndRefine({
          repoDir,
          id,
          config,
          agents: stage.agents,
          designerPrompt: stage.roles.designer.prompt,
          criticPrompt: stage.roles.critic.prompt,
          isProtected: stage.isProtected,
          maxBudgetUsd: stage.maxBudgetUsd - result.costUsd,
          render: (htmlFile, outDir, prefix) =>
            renderScreens(browser, htmlFile, outDir, prefix, { signal: stage.signal, maxScreens: review.maxScreens }),
          signal: stage.signal,
        });
        await stage.state.addSpend(outcome.costUsd);
        printCritique(outcome);
      }
    }
    console.log(`\n${prototypeNext(id, "draft", config)}`);
    if (o.open) openInBrowser(file);
    return 0;
  } finally {
    await stage.done();
  }
}

async function cmdApprove(repoDir: string, id: string): Promise<number> {
  const config = await loadConfig(repoDir);
  try {
    const r = await approvePrototype(repoDir, config, id);
    const story = await readFile(path.join(repoDir, r.layout.story), "utf8").catch(() => "");
    const title = parseStoryDoc(story).title ?? id;
    console.log(r.alreadyApproved ? `Already approved: ${r.layout.index}` : `Approved ${r.layout.index}`);
    console.log(`\nNext: commit and push ${r.layout.dir}/ and ${r.layout.story} to origin/${config.baseBranch} (the build only sees what is there).`);
    console.log(`Then add this task to ${config.tasksFile} and run foreman:`);
    console.log(`  - id: ${id}`);
    console.log(`    title: ${JSON.stringify(title)}`);
    if (!config.docs.enabled) console.log("Also set `docs.enabled: true` in foreman.config.yaml so the task is built from the story, not just its title.");
    return 0;
  } catch (e) {
    if (e instanceof PrototypeError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

async function cmdLogs(repoDir: string, follow: boolean, lines: number): Promise<number> {
  const file = path.join(repoDir, STATE_DIR, "logs", "foreman.log");
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const found = await tailLog(file, {
      lines,
      follow,
      signal: stop.signal,
      write: (text) => console.log(text.replace(/\r?\n$/, "")),
    });
    if (!found) console.log(`No log yet: ${file}\nIt is created by \`foreman run\`; use \`foreman logs -f\` to wait for it.`);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}

function openInBrowser(file: string): void {
  const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  const cmd = process.platform === "win32" ? "cmd" : opener;
  const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
  try {
    // No GUI opener (headless/SSH/CI, or xdg-open missing) fails async via
    // an 'error' event, not a thrown exception — without a listener that
    // becomes an uncaught exception. Swallow it; opening is a convenience.
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => console.log("Could not open it automatically; open the file above in a browser."))
      .unref();
  } catch {
    console.log(`Could not open it automatically; open the file above in a browser.`);
  }
}

async function cmdDashboard(repoDir: string, open: boolean, watch: boolean, intervalSeconds: number): Promise<number> {
  const file = path.join(repoDir, STATE_DIR, "dashboard.html");
  await mkdir(path.dirname(file), { recursive: true });
  const writeOnce = async () => {
    const summary = await loadStatusSummary(repoDir);
    await writeFile(file, renderDashboardHtml(summary, new Date().toISOString(), watch ? intervalSeconds : undefined));
  };
  await writeOnce();
  console.log(`Wrote ${file}`);
  if (open) openInBrowser(file);

  if (!watch) {
    if (!open) console.log("Open it in a browser, or rerun with --open.");
    return 0;
  }

  console.log(`Watching — refreshing ${file} every ${intervalSeconds}s. The open page reloads itself. Press Ctrl+C to stop.`);
  const stop = new AbortController();
  const onSignal = () => {
    console.error("\nStopping dashboard watch.");
    stop.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    while (!stop.signal.aborted) {
      await sleepAbortable(intervalSeconds * 1000, stop.signal);
      if (stop.signal.aborted) break;
      await writeOnce();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
  // These files are committed, so an image built with `COPY . .` would ship the task backlog.
  const dockerignore = path.join(repoDir, ".dockerignore");
  if (existsSync(path.join(repoDir, "Dockerfile")) && !/tasks\.yaml/.test(existsSync(dockerignore) ? await readFile(dockerignore, "utf8") : "")) {
    console.log("Note: this repo has a Dockerfile. Add foreman.config.yaml, tasks.yaml and .foreman/ to .dockerignore so they don't end up in built images.");
  }
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
    // import.meta.url resolves through symlinks (e.g. `npm link`), so argv[1]
    // must be realpath'd too, or a linked global install never matches and
    // the CLI silently does nothing.
    const self = fileURLToPath(import.meta.url);
    const resolved = process.argv[1] ? path.resolve(process.argv[1]) : "";
    const arg = resolved ? (realpathSync(resolved, { encoding: "utf8" }) as string) : "";
    return arg === self || resolved === self || arg.replace(/\.js$/, "") === self.replace(/\.js$/, "") || /[\\/](foreman|claude-foreman)(\.cmd|\.js)?$/.test(resolved);
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
