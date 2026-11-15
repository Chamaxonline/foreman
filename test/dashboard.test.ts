import { describe, expect, it } from "vitest";
import { renderDashboardHtml, type DashboardSummary } from "../src/dashboard.js";

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    repo: "/repo",
    models: { planner: "opus", coder: "sonnet" },
    spentTodayUsd: 1.5,
    dailyCapUsd: 10,
    modelUsage: [{ model: "opus", attempts: 2, costUsd: 1.0, pctOfCost: 66.7 }, { model: "sonnet", attempts: 1, costUsd: 0.5, pctOfCost: 33.3 }],
    tasks: [{ id: "t1", title: "Add thing", status: "done", attempts: 2, costUsd: 1.5, prUrl: "https://example.com/pr/1" }],
    ...over,
  };
}

describe("renderDashboardHtml", () => {
  it("is a self-contained static document: one style block, no external requests, no script", () => {
    const html = renderDashboardHtml(summary(), "2026-01-01T00:00:00.000Z");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>foreman dashboard</title>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i); // no external stylesheet/font requests
    expect(html).not.toMatch(/\bfetch\(|cdn\.|googleapis\.com/i);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });

  it("renders spend, models configured, model usage bars and the task table", () => {
    const html = renderDashboardHtml(summary(), "2026-01-01T00:00:00.000Z");
    expect(html).toContain("$1.50");
    expect(html).toContain("$10.00");
    expect(html).toContain("planner: <strong>opus</strong>");
    expect(html).toContain("<strong>opus</strong>");
    expect(html).toContain("2 calls");
    expect(html).toContain("66.7%");
    expect(html).toContain('width:66.7%');
    expect(html).toContain("Add thing");
    expect(html).toContain('<span class="pill pill-good">Done</span>');
    expect(html).toContain('href="https://example.com/pr/1"');
  });

  it("assigns model colors by first appearance, not alphabetically, and cycles past 8 models", () => {
    const usage = Array.from({ length: 10 }, (_, i) => ({ model: `m${i}`, attempts: 1, costUsd: 1, pctOfCost: 10 }));
    const html = renderDashboardHtml(summary({ modelUsage: usage }), "x");
    expect(html).toContain("var(--m0)"); // first model
    expect(html).toContain("var(--m7)"); // 8th model, last distinct slot
    // 9th and 10th models wrap back to slot 0 and 1. Match on the model bars
    // specifically (class="bar-fill"), not the spend meter, which also uses
    // var(--m0) at low spend.
    const fills = [...html.matchAll(/class="bar-fill" style="width:[\d.]+%;background:var\(--m(\d)\)"/g)].map((m) => m[1]);
    expect(fills).toHaveLength(10);
    expect(fills[8]).toBe("0");
    expect(fills[9]).toBe("1");
  });

  it("escapes HTML in task titles, repo path and model names", () => {
    const html = renderDashboardHtml(
      summary({
        repo: '<img src=x onerror=alert(1)>',
        tasks: [{ id: "t1", title: `<script>alert('x')</script> & "quoted"`, status: "pending", attempts: 0, costUsd: 0 }],
      }),
      "x",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;quoted&quot;");
  });

  it("handles no model usage, no tasks, and no PR link without crashing", () => {
    const html = renderDashboardHtml(summary({ modelUsage: [], tasks: [] }), "x");
    expect(html).toMatch(/no model usage|No model usage/i);
    expect(html).toContain("No tasks.");
  });

  it("colors the spend meter by how close it is to the daily cap", () => {
    const low = renderDashboardHtml(summary({ spentTodayUsd: 1, dailyCapUsd: 100 }), "x");
    expect(low).toContain("background:var(--m0)");
    const high = renderDashboardHtml(summary({ spentTodayUsd: 95, dailyCapUsd: 100 }), "x");
    expect(high).toContain("background:var(--status-critical)");
  });

  it("omits the auto-refresh meta tag for a plain static snapshot", () => {
    const html = renderDashboardHtml(summary(), "x");
    expect(html).not.toMatch(/http-equiv="refresh"/);
    expect(html).toContain("Static snapshot");
  });

  it("adds a self-reloading meta tag and watching note when refreshSeconds is given", () => {
    const html = renderDashboardHtml(summary(), "x", 5);
    expect(html).toContain('<meta http-equiv="refresh" content="5">');
    expect(html).toContain("Watching — this page reloads itself every 5s.");
    expect(html).not.toContain("Static snapshot");
  });

  it("every status maps to a labeled, non-color-alone pill", () => {
    const tasks = ["done", "needs_human", "failed", "in_progress", "pending", "weird_future_status"].map((status, i) => ({
      id: `t${i}`,
      title: status,
      status,
      attempts: 0,
      costUsd: 0,
    }));
    const html = renderDashboardHtml(summary({ tasks }), "x");
    expect(html).toContain(">Done<");
    expect(html).toContain(">Needs human<");
    expect(html).toContain(">Failed<");
    expect(html).toContain(">In progress<");
    expect(html).toContain(">Pending<");
    expect(html).toContain(">weird_future_status<"); // unknown status still gets a labeled pill, not blank
  });
});
