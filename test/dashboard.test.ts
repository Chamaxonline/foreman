import { describe, expect, it } from "vitest";
import { renderDashboardHtml, type DashboardSummary } from "../src/dashboard.js";
import type { LiveView } from "../src/live.js";
import type { StorySummary } from "../src/story.js";

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    repo: "/repo",
    models: { planner: "opus", coder: "sonnet" },
    spentTodayUsd: 1.5,
    dailyCapUsd: 10,
    modelUsage: [{ model: "opus", calls: 2, costUsd: 1.0, pctOfCost: 66.7 }, { model: "sonnet", calls: 1, costUsd: 0.5, pctOfCost: 33.3 }],
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
    const usage = Array.from({ length: 10 }, (_, i) => ({ model: `m${i}`, calls: 1, costUsd: 1, pctOfCost: 10 }));
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

  describe("live status", () => {
    const live = (over: Partial<LiveView> = {}): LiveView => ({
      pid: 1, host: "h", command: "run", startedAt: "x", idle: false, taskId: "list-tenants", title: "Add a GET /tenants endpoint",
      stage: "Writing the code", step: "code", role: "coder", model: "sonnet", attempt: 2, maxAttempts: 5, stageStartedAt: "x",
      lastActivity: "Edit src/tenants.ts", lastActivityAt: "x",
      recent: ["Read a.ts", "Grep tenant", "Edit src/tenants.ts"], updatedAt: "x",
      running: true, working: true, secondsRunning: 212, secondsInStage: 84, secondsSinceActivity: 4,
      ...over,
    });
    const html = (l?: LiveView) => renderDashboardHtml(summary({ live: l }), "x");

    it("shows that foreman is working, on what, at which step, and what it just did", () => {
      const h = html(live());
      expect(h).toContain("<strong>Working</strong>");
      expect(h).toContain("foreman run · running for 3m 32s");
      expect(h).toContain("Add a GET /tenants endpoint");
      expect(h).toContain("<code>list-tenants</code>");
      expect(h).toContain("Writing the code");
      expect(h).toContain("sonnet · attempt 2 of 5 · 1m 24s in this step");
      expect(h).toContain("Latest action:</span> Edit src/tenants.ts");
      expect(h).toContain("(4s ago)");
      // newest action first in the list
      expect(h.indexOf("<li>Edit src/tenants.ts</li>")).toBeLessThan(h.indexOf("<li>Read a.ts</li>"));
      expect(h).toContain('class="dot dot-live"');
    });

    it("tracks the steps: earlier ones done, the current one marked, later ones plain", () => {
      const h = html(live({ step: "checks" }));
      expect(h).toContain('<li class="done">Setup</li>');
      expect(h).toContain('<li class="done">Code</li>');
      expect(h).toContain('<li class="current">Checks</li>');
      expect(h).toContain("<li class=\"\">Review</li>");
      expect(html(live({ step: undefined }))).not.toContain('class="steps"'); // story and prototype work has no steps
    });

    it("says the model is thinking when there has been no action for a while", () => {
      expect(html(live({ secondsSinceActivity: 200 }))).toContain("(3m 20s ago, the model is thinking)");
      expect(html(live({ lastActivity: undefined, recent: [] }))).toContain("Waiting for the first action");
    });

    it("shows waiting when running with nothing to do, and not running otherwise", () => {
      const waiting = html(live({ working: false, idle: true, stage: "Waiting for the next task", title: undefined, taskId: undefined }));
      expect(waiting).toContain("<strong>Waiting</strong>");
      expect(waiting).toContain("Nothing to work on right now");
      expect(waiting).toContain('class="dot dot-wait"');
      expect(waiting).not.toContain("<strong>Working</strong>");

      for (const l of [undefined, live({ running: false, working: false })]) {
        const off = html(l);
        expect(off).toContain("<strong>Not running</strong>");
        expect(off).toContain("foreman prototype");
        expect(off).not.toContain("<strong>Working</strong>");
      }
    });

    it("escapes everything an agent or a file name can put in it", () => {
      const evil = `<img src=x onerror=alert(1)>`;
      const h = html(live({ title: evil, taskId: evil, stage: evil, model: evil, lastActivity: evil, recent: [evil, "<script>alert(1)</script>"] }));
      expect(h).not.toContain("<img src=x");
      expect(h).not.toContain("<script>alert(1)");
      expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("respects reduced-motion for the pulsing dot", () => {
      expect(html(live())).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.dot-live\s*\{\s*animation: none/);
    });
  });

  it("shows which roles used each model next to its percentage", () => {
    const h = renderDashboardHtml(
      summary({ modelUsage: [{ model: "opus", calls: 4, costUsd: 3, pctOfCost: 75, roles: ["analyst", "critic", "designer"] }, { model: "sonnet", calls: 1, costUsd: 1, pctOfCost: 25 }] }),
      "x",
    );
    expect(h).toContain("4 calls · $3.00 · 75.0% · analyst, critic, designer");
    expect(h).toContain("1 call · $1.00 · 25.0%</span>"); // no roles recorded: nothing extra
    expect(h).toContain("Counts every agent call");
  });

  it("lists stories with their prototype state and cost, and omits the card when there are none", () => {
    const stories: StorySummary[] = [
      { id: "tickets", title: "Ticket queue", prototype: "draft", costUsd: 2.93, calls: 4 },
      { id: "pdf", title: "Export <b>PDF</b>", prototype: "approved", costUsd: 0.91, calls: 3 },
      { id: "x", title: "Changed", prototype: "stale", costUsd: 0, calls: 0 },
      { id: "y", title: "Fresh", prototype: "none", costUsd: 0, calls: 0 },
    ];
    const h = renderDashboardHtml(summary({ stories }), "x");
    expect(h).toContain("<h2>Stories and prototypes</h2>");
    expect(h).toContain('<span class="pill pill-warning">Needs your approval</span>');
    expect(h).toContain('<span class="pill pill-good">Approved</span>');
    expect(h).toContain('<span class="pill pill-warning">Changed since approval</span>');
    expect(h).toContain('<span class="pill pill-muted">No prototype</span>');
    expect(h).toContain("$2.93");
    expect(h).toContain("Export &lt;b&gt;PDF&lt;/b&gt;");
    expect(renderDashboardHtml(summary({ stories: [] }), "x")).not.toContain("Stories and prototypes");
    expect(renderDashboardHtml(summary(), "x")).not.toContain("Stories and prototypes");
  });

  it("explains why a task is waiting, but not for a finished one", () => {
    const tasks = [
      { id: "a", title: "Waiting task", status: "pending", attempts: 0, costUsd: 0, lastError: "The prototype for a is not approved yet." },
      { id: "b", title: "Done task", status: "done", attempts: 1, costUsd: 1, lastError: "an old error" },
    ];
    const h = renderDashboardHtml(summary({ tasks }), "x");
    expect(h).toContain('<div class="note">The prototype for a is not approved yet.</div>');
    expect(h).not.toContain("an old error");
  });

  it("keeps a status pill on one line", () => {
    expect(renderDashboardHtml(summary(), "x")).toMatch(/\.pill \{[^}]*white-space: nowrap/);
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
