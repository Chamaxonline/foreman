import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checksSummary, type CheckResult } from "./checks.js";
import type { AttemptRecord } from "./state.js";
import type { Task } from "./tasks.js";

export type OutcomeStatus =
  | "done" // PR opened (or would be, in dry-run)
  | "needs_human" // per-task limits hit; draft PR opened / reported
  | "deferred" // global spend cap hit; task left pending
  | "skipped" // already finished
  | "failed" // unrecoverable error (e.g. safety violation in runner, config)
  | "error"; // transient error (git/GitHub/API); task left pending for retry

export interface TaskOutcome {
  taskId: string;
  title: string;
  status: OutcomeStatus;
  dryRun: boolean;
  attempts: number;
  costUsd: number;
  durationMs: number;
  models: string[];
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  reason?: string;
  checks: CheckResult[];
  history: AttemptRecord[];
  summary?: string;
  /** The PR body foreman opened (or would have opened, in dry-run). */
  prBody?: string;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const mins = (ms: number) => `${(ms / 60000).toFixed(1)} min`;

export function historyTable(history: AttemptRecord[]): string {
  if (!history.length) return "_No attempts recorded._";
  const rows = history.map(
    (h) => `| ${h.n} | \`${h.model}\` | ${h.outcome} | ${usd(h.costUsd)} | ${escapeCell(h.summary).slice(0, 160)} |`,
  );
  return ["| # | Model | Outcome | Cost | Notes |", "|---|---|---|---|---|", ...rows].join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function taskSection(task: Task): string {
  const out = [`**Task \`${task.id}\`:** ${task.title}`];
  if (task.issueNumber) out.push(`Closes #${task.issueNumber}`);
  if (task.acceptance.length) {
    out.push("", "**Acceptance criteria**", ...task.acceptance.map((a) => `- ${a}`));
  }
  return out.join("\n");
}

export interface PrBodyInput {
  task: Task;
  summary: string;
  diffStat: string;
  checks: CheckResult[];
  attempts: number;
  costUsd: number;
  durationMs: number;
  models: string[];
  history: AttemptRecord[];
  review?: { verdict: string; summary: string; notes?: string[] };
}

export function successPrBody(i: PrBodyInput): string {
  return [
    "## Summary",
    i.summary.trim() || "_(no summary provided)_",
    "",
    taskSection(i.task),
    "",
    "## What changed",
    "```",
    i.diffStat.trim() || "(no diff stat)",
    "```",
    "",
    "## Checks run (by the foreman runner)",
    checksSummary(i.checks),
    "",
    ...(i.review
      ? ["## Review", `**${i.review.verdict}**: ${i.review.summary}`, ...(i.review.notes ?? []).map((n) => `- ${n}`), ""]
      : []),
    "## Run stats",
    `- Attempts: ${i.attempts}`,
    `- Models: ${[...new Set(i.models)].map((m) => `\`${m}\``).join(", ")}`,
    `- Cost: ${usd(i.costUsd)}`,
    `- Duration: ${mins(i.durationMs)}`,
    "",
    "<details><summary>Attempt history</summary>",
    "",
    historyTable(i.history),
    "",
    "</details>",
    "",
    "---",
    "_Opened automatically by [foreman](https://www.npmjs.com/package/claude-foreman). Review before merging; foreman never merges._",
  ].join("\n");
}

export interface FailureReportInput {
  task: Task;
  reason: string;
  lastError: string;
  history: AttemptRecord[];
  checks: CheckResult[];
  attempts: number;
  costUsd: number;
  durationMs: number;
  plan?: string;
}

export function failureReport(i: FailureReportInput): string {
  return [
    "## ⚠️ foreman needs a human",
    "",
    `foreman stopped working on this task: **${i.reason}**.`,
    "",
    taskSection(i.task),
    "",
    "## Last error",
    "```",
    i.lastError.trim().slice(-6000) || "(none captured)",
    "```",
    "",
    "## What was tried",
    historyTable(i.history),
    "",
    ...(i.checks.length ? ["## Last check run", checksSummary(i.checks), ""] : []),
    ...(i.plan ? ["<details><summary>Plan</summary>", "", i.plan.trim(), "", "</details>", ""] : []),
    "## Run stats",
    `- Attempts: ${i.attempts}`,
    `- Cost: ${usd(i.costUsd)}`,
    `- Duration: ${mins(i.durationMs)}`,
    "",
    "---",
    "_This draft PR contains foreman's last work in progress (protected-path changes removed). Take it over, or fix the task description and rerun with `foreman run --task " +
      i.task.id +
      " --retry`._",
  ].join("\n");
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  totalCostUsd: number;
  spentTodayUsd: number;
  stoppedReason?: string;
  tasks: TaskOutcome[];
}

export function runReportMarkdown(r: RunReport): string {
  const count = (s: OutcomeStatus) => r.tasks.filter((t) => t.status === s).length;
  const lines = [
    `# foreman run ${r.runId}${r.dryRun ? " (dry run)" : ""}`,
    "",
    `- Started: ${r.startedAt}`,
    `- Finished: ${r.finishedAt}`,
    `- Cost this run: ${usd(r.totalCostUsd)} (today: ${usd(r.spentTodayUsd)})`,
    `- Done: ${count("done")} · Needs human: ${count("needs_human")} · Deferred: ${count("deferred")} · Errors: ${count("error") + count("failed")} · Skipped: ${count("skipped")}`,
    ...(r.stoppedReason ? [`- Stopped early: ${r.stoppedReason}`] : []),
    "",
    "| Task | Status | Attempts | Cost | PR | Notes |",
    "|---|---|---|---|---|---|",
    ...r.tasks.map(
      (t) =>
        `| \`${t.taskId}\` ${escapeCell(t.title)} | ${t.status} | ${t.attempts} | ${usd(t.costUsd)} | ${t.prUrl ? `[#${t.prNumber ?? "PR"}](${t.prUrl})` : "-"} | ${escapeCell(t.reason ?? "")} |`,
    ),
    "",
  ];
  for (const t of r.tasks.filter((x) => x.history.length)) {
    lines.push(`## ${t.taskId}: ${t.title}`, "", historyTable(t.history), "");
  }
  return lines.join("\n");
}

export async function writeRunReport(dir: string, report: RunReport): Promise<{ md: string; json: string }> {
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, `run-${report.runId}`);
  const md = `${base}.md`;
  const json = `${base}.json`;
  await writeFile(md, runReportMarkdown(report));
  await writeFile(json, JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(dir, "latest.md"), runReportMarkdown(report));
  await writeFile(path.join(dir, "latest.json"), JSON.stringify(report, null, 2) + "\n");
  return { md, json };
}
