import { formatDuration, STEPS, type LiveView, type Step } from "./live.js";
import { PROTOTYPE_LABEL } from "./prototype.js";
import type { ModelUsage } from "./report.js";
import type { StorySummary } from "./story.js";

export interface DashboardTaskRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  costUsd: number;
  prUrl?: string;
  /** Why a task that is not done is waiting or stopped. */
  lastError?: string | undefined;
}

export interface DashboardSummary {
  repo: string;
  models: Record<string, string>;
  spentTodayUsd: number;
  dailyCapUsd: number;
  modelUsage: ModelUsage[];
  lastRun?: { id: string; costUsd: number; dryRun: boolean } | undefined;
  /** What foreman is doing right now, if it is running. */
  live?: LiveView | undefined;
  stories?: StorySummary[];
  tasks: DashboardTaskRow[];
}

// Validated reference palette (dataviz skill: references/palette.md), used
// as shipped. Categorical slots are assigned in fixed order by first
// appearance in modelUsage (already sorted by cost desc), never by hashing
// or alphabetizing, so the same model keeps its color across a run.
const CATEGORICAL: Array<{ light: string; dark: string }> = [
  { light: "#2a78d6", dark: "#3987e5" }, // blue
  { light: "#eb6834", dark: "#d95926" }, // orange
  { light: "#1baf7a", dark: "#199e70" }, // aqua
  { light: "#eda100", dark: "#c98500" }, // yellow
  { light: "#e87ba4", dark: "#d55181" }, // magenta
  { light: "#008300", dark: "#008300" }, // green
  { light: "#6250d6", dark: "#9085e9" }, // violet
  { light: "#e34948", dark: "#e66767" }, // red
];

const STATUS_LABEL: Record<string, string> = {
  done: "Done",
  needs_human: "Needs human",
  failed: "Failed",
  in_progress: "In progress",
  pending: "Pending",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusPill(status: string): string {
  const cls = status === "done" ? "good" : status === "needs_human" ? "warning" : status === "failed" ? "critical" : "muted";
  return `<span class="pill pill-${cls}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

function modelBars(usage: ModelUsage[]): string {
  if (!usage.length) return `<p class="muted">No model usage recorded yet.</p>`;
  return usage
    .map((u, i) => {
      const color = CATEGORICAL[i % CATEGORICAL.length]!;
      const pct = Math.max(u.pctOfCost, u.pctOfCost > 0 ? 1 : 0); // keep a sliver visible for tiny nonzero shares
      return `
      <div class="bar-row">
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;background:var(--m${i % CATEGORICAL.length})"></div>
        </div>
        <div class="bar-label">
          <strong>${esc(u.model)}</strong>
          <span class="muted">${u.calls} call${u.calls === 1 ? "" : "s"} · $${u.costUsd.toFixed(2)} · ${u.pctOfCost.toFixed(1)}%${u.roles?.length ? ` · ${esc(u.roles.join(", "))}` : ""}</span>
        </div>
      </div>`;
    })
    .join("\n");
}

function taskRows(tasks: DashboardTaskRow[]): string {
  if (!tasks.length) return `<tr><td colspan="5" class="muted">No tasks.</td></tr>`;
  return tasks
    .map(
      (t) => `
    <tr>
      <td><code>${esc(t.id)}</code></td>
      <td>${esc(t.title)}${t.lastError && t.status !== "done" ? `<div class="note">${esc(t.lastError.slice(0, 220))}</div>` : ""}</td>
      <td>${statusPill(t.status)}</td>
      <td class="num">${t.attempts}</td>
      <td class="num">$${t.costUsd.toFixed(2)}</td>
      <td>${t.prUrl ? `<a href="${esc(t.prUrl)}">PR</a>` : ""}</td>
    </tr>`,
    )
    .join("\n");
}

const STEP_LABEL: Record<Step, string> = { setup: "Setup", plan: "Plan", code: "Code", checks: "Checks", review: "Review", ship: "Ship" };

/**
 * The top card: whether foreman is working right now, on what, at which step,
 * and the last few things it did. Everything here comes from the agents and the
 * files they touched, so it is all escaped.
 */
function liveCard(live: LiveView | undefined): string {
  if (!live?.running) {
    return `<div class="card live">
    <div class="live-head"><span class="dot dot-off" aria-hidden="true"></span><strong>Not running</strong></div>
    <p class="muted" style="margin:8px 0 0">Start work with <code>foreman run</code>, <code>foreman watch</code>, <code>foreman story</code> or <code>foreman prototype</code>.</p>
  </div>`;
  }
  const running = `running for ${formatDuration(live.secondsRunning)}`;
  if (!live.working) {
    return `<div class="card live">
    <div class="live-head"><span class="dot dot-wait" aria-hidden="true"></span><strong>Waiting</strong><span class="muted">foreman ${esc(live.command)} · ${running}</span></div>
    <p class="muted" style="margin:8px 0 0">${esc(live.stage)}. Nothing to work on right now.</p>
  </div>`;
  }
  const detail = [
    live.model ? esc(live.model) : "",
    live.attempt && live.maxAttempts ? `attempt ${live.attempt} of ${live.maxAttempts}` : "",
    `${formatDuration(live.secondsInStage)} in this step`,
  ]
    .filter(Boolean)
    .join(" · ");
  const current = live.step ? STEPS.indexOf(live.step) : -1;
  const steps =
    current >= 0
      ? `<ol class="steps" aria-label="Progress">${STEPS.map(
          (s, i) => `<li class="${i < current ? "done" : i === current ? "current" : ""}">${STEP_LABEL[s]}</li>`,
        ).join("")}</ol>`
      : "";
  const heading = live.title ?? live.taskId;
  const quiet = (live.secondsSinceActivity ?? 0) > 90;
  const latest = live.lastActivity
    ? `<div class="live-now"><span class="muted">Latest action:</span> ${esc(live.lastActivity)} <span class="muted">(${formatDuration(live.secondsSinceActivity ?? 0)} ago${quiet ? ", the model is thinking" : ""})</span></div>`
    : `<div class="live-now muted">Waiting for the first action...</div>`;
  const recent = live.recent.length ? `<ul class="recent">${[...live.recent].reverse().slice(0, 6).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  return `<div class="card live">
    <div class="live-head"><span class="dot dot-live" aria-hidden="true"></span><strong>Working</strong><span class="muted">foreman ${esc(live.command)} · ${running}</span></div>
    ${heading ? `<div class="live-title">${esc(heading)}${live.taskId && live.title ? ` <code>${esc(live.taskId)}</code>` : ""}</div>` : ""}
    <div class="live-stage">${esc(live.stage)} <span class="muted">· ${detail}</span></div>
    ${steps}
    ${latest}
    ${recent}
  </div>`;
}

const PROTOTYPE_PILL: Record<string, string> = { none: "muted", draft: "warning", approved: "good", stale: "warning" };

function storyRows(stories: StorySummary[]): string {
  return stories
    .map(
      (s) => `
    <tr>
      <td><code>${esc(s.id)}</code></td>
      <td>${esc(s.title)}</td>
      <td><span class="pill pill-${PROTOTYPE_PILL[s.prototype] ?? "muted"}">${esc(PROTOTYPE_LABEL[s.prototype])}</span></td>
      <td class="num">$${s.costUsd.toFixed(2)}</td>
    </tr>`,
    )
    .join("\n");
}

/** A small, static, self-contained HTML page — open it locally; nothing is hosted. */
export function renderDashboardHtml(s: DashboardSummary, generatedAt: string, refreshSeconds?: number): string {
  const spendPct = s.dailyCapUsd > 0 ? Math.min(100, (s.spentTodayUsd / s.dailyCapUsd) * 100) : 0;
  const spendColor = spendPct >= 90 ? "var(--status-critical)" : spendPct >= 70 ? "var(--status-warning)" : "var(--m0)";
  const modelsConfigured = Object.entries(s.models)
    .map(([role, model]) => `<span class="chip">${esc(role)}: <strong>${esc(model)}</strong></span>`)
    .join(" ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">\n` : ""}<title>foreman dashboard</title>
<style>
  :root {
    color-scheme: light;
    --surface: #fcfcfb; --page: #f9f9f7; --text: #0b0b0b; --text-2: #52514e; --muted: #898781;
    --border: rgba(11,11,11,0.10); --track: #e1e0d9;
    --status-good: #0ca30c; --status-warning: #fab219; --status-critical: #d03b3b;
    --m0: #2a78d6; --m1: #eb6834; --m2: #1baf7a; --m3: #eda100; --m4: #e87ba4; --m5: #008300; --m6: #6250d6; --m7: #e34948;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --surface: #1a1a19; --page: #0d0d0d; --text: #f0efec; --text-2: #c3c2b7; --muted: #898781;
      --border: rgba(255,255,255,0.10); --track: #2c2c2a;
      --status-good: #0ca30c; --status-warning: #fab219; --status-critical: #d03b3b;
      --m0: #3987e5; --m1: #d95926; --m2: #199e70; --m3: #c98500; --m4: #d55181; --m5: #008300; --m6: #9085e9; --m7: #e66767;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 48px; background: var(--page); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-2); margin: 0 0 14px; }
  .muted { color: var(--muted); }
  .chip { display: inline-block; background: var(--page); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; margin: 0 6px 6px 0; font-size: 13px; }
  .meter-row { display: flex; align-items: center; gap: 12px; }
  .meter-value { font-size: 28px; font-weight: 600; white-space: nowrap; }
  .meter-track { flex: 1; height: 10px; border-radius: 6px; background: var(--track); overflow: hidden; }
  .meter-fill { height: 100%; border-radius: 6px; }
  .bar-row { margin-bottom: 14px; }
  .bar-track { height: 16px; border-radius: 4px; background: var(--track); overflow: hidden; margin-bottom: 4px; }
  .bar-fill { height: 100%; border-radius: 4px; min-width: 2px; }
  .bar-label { display: flex; justify-content: space-between; font-size: 13px; }
  .bar-label strong { font-weight: 600; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; white-space: nowrap; }
  .pill-good { background: var(--status-good); }
  .pill-warning { background: var(--status-warning); color: #0b0b0b; }
  .pill-critical { background: var(--status-critical); }
  .pill-muted { background: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); }
  th { color: var(--text-2); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font-size: 12px; background: var(--page); padding: 1px 5px; border-radius: 4px; }
  a { color: var(--m0); }
  .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .live-head { display: flex; align-items: center; gap: 10px; font-size: 15px; flex-wrap: wrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot-live { background: var(--status-good); animation: pulse 1.6s ease-out infinite; }
  .dot-wait { background: var(--status-warning); }
  .dot-off { background: var(--muted); }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(12,163,12,.55); }
    70% { box-shadow: 0 0 0 9px rgba(12,163,12,0); }
    100% { box-shadow: 0 0 0 0 rgba(12,163,12,0); }
  }
  @media (prefers-reduced-motion: reduce) { .dot-live { animation: none; } }
  .live-title { font-size: 18px; font-weight: 600; margin: 12px 0 2px; }
  .live-stage { color: var(--text-2); }
  .steps { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; padding: 0; margin: 14px 0 0; }
  .steps li { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .steps li.done { color: var(--text-2); }
  .steps li.done::before { content: "\\2713  "; }
  .steps li.current { background: var(--text); color: var(--surface); border-color: var(--text); font-weight: 600; }
  .steps li.current::before { content: "\\25CF  "; }
  .live-now { margin-top: 14px; font-size: 14px; }
  .recent { list-style: none; margin: 10px 0 0; padding: 10px 12px; background: var(--page); border: 1px solid var(--border); border-radius: 8px; font: 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text-2); }
  .recent li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<div class="wrap">
  <h1>foreman</h1>
  <p class="sub">${esc(s.repo)} · generated ${esc(generatedAt)}</p>

  ${liveCard(s.live)}

  <div class="card">
    <h2>Spend today</h2>
    <div class="meter-row">
      <div class="meter-value">$${s.spentTodayUsd.toFixed(2)}<span class="muted" style="font-size:15px;font-weight:400"> / $${s.dailyCapUsd.toFixed(2)}</span></div>
      <div class="meter-track"><div class="meter-fill" style="width:${spendPct}%;background:${spendColor}"></div></div>
    </div>
    ${s.lastRun ? `<p class="muted" style="margin:10px 0 0">Last run ${esc(s.lastRun.id)} — $${s.lastRun.costUsd.toFixed(2)}${s.lastRun.dryRun ? " (dry run)" : ""}</p>` : ""}
  </div>

  <div class="card">
    <h2>Models configured</h2>
    <div>${modelsConfigured || '<span class="muted">none</span>'}</div>
  </div>

  <div class="card">
    <h2>Model usage (by cost share)</h2>
    ${modelBars(s.modelUsage)}
    <p class="muted" style="font-size:12px;margin:10px 0 0">Counts every agent call: stories, prototypes, design reviews and builds.</p>
  </div>

  ${
    s.stories?.length
      ? `<div class="card">
    <h2>Stories and prototypes</h2>
    <table>
      <thead><tr><th>Story</th><th>Title</th><th>Prototype</th><th class="num">Spent</th></tr></thead>
      <tbody>${storyRows(s.stories)}</tbody>
    </table>
  </div>`
      : ""
  }

  <div class="card">
    <h2>Tasks</h2>
    <table>
      <thead><tr><th>ID</th><th>Title</th><th>Status</th><th class="num">Attempts</th><th class="num">Cost</th><th>PR</th></tr></thead>
      <tbody>${taskRows(s.tasks)}</tbody>
    </table>
  </div>

  <p class="muted" style="font-size:12px">${refreshSeconds ? `Watching — this page reloads itself every ${refreshSeconds}s.` : `Static snapshot — re-run <code>foreman dashboard</code> to refresh, or use <code>foreman dashboard --watch</code>.`}</p>
</div>
</body>
</html>
`;
}
