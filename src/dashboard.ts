import type { ModelUsage } from "./report.js";

export interface DashboardTaskRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  costUsd: number;
  prUrl?: string;
}

export interface DashboardSummary {
  repo: string;
  models: Record<string, string>;
  spentTodayUsd: number;
  dailyCapUsd: number;
  modelUsage: ModelUsage[];
  lastRun?: { id: string; costUsd: number; dryRun: boolean } | undefined;
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
          <span class="muted">${u.attempts} call${u.attempts === 1 ? "" : "s"} · $${u.costUsd.toFixed(2)} · ${u.pctOfCost.toFixed(1)}%</span>
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
      <td>${esc(t.title)}</td>
      <td>${statusPill(t.status)}</td>
      <td class="num">${t.attempts}</td>
      <td class="num">$${t.costUsd.toFixed(2)}</td>
      <td>${t.prUrl ? `<a href="${esc(t.prUrl)}">PR</a>` : ""}</td>
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
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #fff; }
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
</style>
</head>
<body>
<div class="wrap">
  <h1>foreman</h1>
  <p class="sub">${esc(s.repo)} · generated ${esc(generatedAt)}</p>

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
  </div>

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
