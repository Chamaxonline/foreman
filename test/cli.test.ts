import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { parseConfig } from "../src/config.js";
import { LiveWriter } from "../src/live.js";
import { StateStore } from "../src/state.js";
import { parseTasks } from "../src/tasks.js";
import { detectProject } from "../src/templates.js";

let dir: string;
let out: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "foreman-cli-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("cli", () => {
  it("prints help and version", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("foreman run");
    expect(await main(["--version"])).toBe(0);
    expect(out.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
    expect(await main([])).toBe(2);
    expect(await main(["bogus"])).toBe(2);
  });

  it("init writes valid config + tasks with detected checks and ignores .foreman", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }));
    expect(await main(["init", "--repo", dir])).toBe(0);
    const cfg = parseConfig(await readFile(path.join(dir, "foreman.config.yaml"), "utf8"));
    expect(cfg.checks.map((c) => c.run)).toEqual(["npm run build", "npm run lint", "npm test"]);
    expect(parseTasks(await readFile(path.join(dir, "tasks.yaml"), "utf8"))).toHaveLength(1);
    expect(await readFile(path.join(dir, ".gitignore"), "utf8")).toContain(".foreman/");

    // idempotent without --force
    out = [];
    expect(await main(["init", "--repo", dir])).toBe(0);
    expect(out.join("\n")).toContain("exists, skipped");
  });

  it("status shows tasks and spend (text and JSON)", async () => {
    await main(["init", "--repo", dir]);
    const state = await StateStore.open(path.join(dir, ".foreman"));
    await state.updateTask("example-readme-badge", { status: "done", attempts: 2, prUrl: "https://github.com/a/b/pull/1" });
    await state.addSpend(1.5, "example-readme-badge");
    out = [];
    expect(await main(["status", "--repo", dir])).toBe(0);
    expect(out.join("\n")).toMatch(/done\s+example-readme-badge\s+2 att\s+\$\s*1\.50/);
    out = [];
    expect(await main(["status", "--repo", dir, "--json"])).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.spentTodayUsd).toBe(1.5);
    expect(j.tasks[0]).toMatchObject({ id: "example-readme-badge", status: "done" });
  });

  it("status shows configured models and a model-usage breakdown by cost share", async () => {
    await main(["init", "--repo", dir]);
    const state = await StateStore.open(path.join(dir, ".foreman"));
    await state.recordAttempt("example-readme-badge", { n: 1, model: "sonnet", outcome: "check_failed", summary: "x", costUsd: 0.1 });
    await state.recordAttempt("example-readme-badge", { n: 2, model: "opus", outcome: "pass", summary: "x", costUsd: 0.3 });
    out = [];
    expect(await main(["status", "--repo", dir])).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/Models configured:/);
    expect(text).toMatch(/planner\s+opus/);
    expect(text).toMatch(/coder\s+sonnet/);
    expect(text).toMatch(/Model usage/);
    expect(text).toMatch(/opus\s+1 calls\s+\$\s*0\.30\s+75\.0%/);
    expect(text).toMatch(/sonnet\s+1 calls\s+\$\s*0\.10\s+25\.0%/);

    out = [];
    expect(await main(["status", "--repo", dir, "--json"])).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.models).toMatchObject({ planner: "opus", coder: "sonnet" });
    expect(j.modelUsage).toEqual([
      { model: "opus", calls: 1, costUsd: 0.3, pctOfCost: 75 },
      { model: "sonnet", calls: 1, costUsd: 0.1, pctOfCost: 25 },
    ]);
  });

  it("status counts every agent call by its own model, not just the coder's", async () => {
    await main(["init", "--repo", dir]);
    const state = await StateStore.open(path.join(dir, ".foreman"));
    await state.addSpend(0.13, "example-readme-badge", "r1", { role: "planner", model: "opus" });
    await state.addSpend(0.14, "example-readme-badge", "r1", { role: "coder", model: "sonnet" });
    await state.addSpend(0.2, "example-readme-badge", "r1", { role: "reviewer", model: "opus" });
    out = [];
    expect(await main(["status", "--repo", dir, "--json"])).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.modelUsage).toEqual([
      { model: "opus", calls: 2, roles: ["planner", "reviewer"], costUsd: 0.33, pctOfCost: 70.2 },
      { model: "sonnet", calls: 1, roles: ["coder"], costUsd: 0.14, pctOfCost: 29.8 },
    ]);
  });

  it("status omits the model-usage section when nothing has run yet", async () => {
    await main(["init", "--repo", dir]);
    out = [];
    expect(await main(["status", "--repo", dir])).toBe(0);
    expect(out.join("\n")).not.toMatch(/Model usage/);
  });

  it("dashboard writes a self-contained HTML snapshot under .foreman/", async () => {
    await main(["init", "--repo", dir]);
    const state = await StateStore.open(path.join(dir, ".foreman"));
    await state.recordAttempt("example-readme-badge", { n: 1, model: "opus", outcome: "pass", summary: "x", costUsd: 0.3 });
    out = [];
    expect(await main(["dashboard", "--repo", dir])).toBe(0);
    expect(out.join("\n")).toMatch(/Wrote .*dashboard\.html/);
    expect(out.join("\n")).toMatch(/rerun with --open/);
    const html = await readFile(path.join(dir, ".foreman", "dashboard.html"), "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("opus");
    expect(html).toContain("100.0%"); // only model used so far: 100% of tracked cost
  });

  it("dashboard --open never throws even if no GUI opener is available", async () => {
    await main(["init", "--repo", dir]);
    await expect(main(["dashboard", "--repo", dir, "--open"])).resolves.toBe(0);
  });

  it("dashboard --watch keeps refreshing the file until interrupted, then exits cleanly", async () => {
    await main(["init", "--repo", dir]);
    const run = main(["dashboard", "--repo", dir, "--watch", "--interval", "1"]);
    await new Promise((r) => setTimeout(r, 150));

    const html = await readFile(path.join(dir, ".foreman", "dashboard.html"), "utf8");
    expect(html).toContain('<meta http-equiv="refresh" content="1">');
    expect(out.join("\n")).toMatch(/Watching — refreshing/);

    process.emit("SIGINT");
    expect(await run).toBe(0);
  });

  it("dashboard rejects a non-positive --interval", async () => {
    await main(["init", "--repo", dir]);
    out = [];
    expect(await main(["dashboard", "--repo", dir, "--watch", "--interval", "0"])).toBe(2);
    expect(out.join("\n")).toMatch(/--interval must be a positive number/);
  });

  it("logs shows the end of the run log, and says so when there is none yet", async () => {
    expect(await main(["logs", "--repo", dir])).toBe(0);
    expect(out.join("\n")).toMatch(/No log yet/);

    await mkdir(path.join(dir, ".foreman", "logs"), { recursive: true });
    await writeFile(path.join(dir, ".foreman", "logs", "foreman.log"), Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    out = [];
    expect(await main(["logs", "--repo", dir, "-n", "2"])).toBe(0);
    expect(out.join("\n")).toBe("line 4\nline 5");
  });

  it("logs rejects a bad --lines", async () => {
    out = [];
    expect(await main(["logs", "--repo", dir, "-n", "0"])).toBe(2);
    expect(out.join("\n")).toMatch(/--lines must be a positive whole number/);
    expect(await main(["logs", "--repo", dir, "-n", "abc"])).toBe(2);
  });

  it("init tells teammates who don't use foreman they can ignore the files", async () => {
    await main(["init", "--repo", dir]);
    expect(await readFile(path.join(dir, "foreman.config.yaml"), "utf8")).toMatch(/optional CLI.*\n.*ignore this file/s);
    expect(await readFile(path.join(dir, "tasks.yaml"), "utf8")).toMatch(/Not using foreman\? Ignore this file/);
  });

  it("init warns about .dockerignore only when there is a Dockerfile that doesn't already exclude tasks.yaml", async () => {
    await main(["init", "--repo", dir]);
    expect(out.join("\n")).not.toMatch(/dockerignore/);

    await writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nCOPY . .\n");
    out = [];
    await main(["init", "--repo", dir, "--force"]);
    expect(out.join("\n")).toMatch(/Add foreman\.config\.yaml, tasks\.yaml and \.foreman\/ to \.dockerignore/);

    await writeFile(path.join(dir, ".dockerignore"), "node_modules\ntasks.yaml\nforeman.config.yaml\n.foreman/\n");
    out = [];
    await main(["init", "--repo", dir, "--force"]);
    expect(out.join("\n")).not.toMatch(/dockerignore/);
  });

  it("story needs an idea, and will not overwrite an existing story", async () => {
    await main(["init", "--repo", dir]);
    out = [];
    expect(await main(["story", "--repo", dir])).toBe(2);
    expect(out.join("\n")).toMatch(/Give the idea as text/);

    await mkdir(path.join(dir, "docs", "stories"), { recursive: true });
    await writeFile(path.join(dir, "docs", "stories", "pdf-export.md"), "# mine\n");
    out = [];
    expect(await main(["story", "--repo", dir, "--id", "pdf-export", "export", "reports", "as", "PDF"])).toBe(1);
    expect(out.join("\n")).toMatch(/pdf-export\.md already exists/);
    expect(await readFile(path.join(dir, "docs", "stories", "pdf-export.md"), "utf8")).toBe("# mine\n");
  });

  it("prototype and approve need a story id, and prototype needs a story to exist", async () => {
    await main(["init", "--repo", dir]);
    out = [];
    expect(await main(["prototype", "--repo", dir])).toBe(2);
    expect(out.join("\n")).toMatch(/Give the story id/);
    expect(await main(["approve", "--repo", dir])).toBe(2);
    expect(await main(["prototype", "--repo", dir, "../evil"])).toBe(2);
    expect(out.join("\n")).toMatch(/not a usable story id/);

    out = [];
    expect(await main(["prototype", "--repo", dir, "pdf"])).toBe(1); // no story yet
    expect(out.join("\n")).toMatch(/no story at docs\/stories\/pdf\.md/);
    expect(await main(["approve", "--repo", dir, "pdf"])).toBe(1); // no prototype yet
    expect(out.join("\n")).toMatch(/no prototype for pdf/);
  });

  it("walks a prototype from draft to approved to stale without calling an agent", async () => {
    await main(["init", "--repo", dir]);
    await mkdir(path.join(dir, "docs", "stories"), { recursive: true });
    await mkdir(path.join(dir, "docs", "prototypes", "pdf"), { recursive: true });
    await writeFile(path.join(dir, "docs", "stories", "pdf.md"), "# Export reports as PDF\n\nBody.\n\n## Acceptance criteria\n- A button\n");
    const index = path.join(dir, "docs", "prototypes", "pdf", "index.html");
    await writeFile(index, "<html><body>v1</body></html>");

    out = [];
    expect(await main(["prototype", "--repo", dir, "pdf"])).toBe(0);
    expect(out.join("\n")).toMatch(/pdf is draft/);
    expect(out.join("\n")).toMatch(/foreman approve pdf/);

    out = [];
    expect(await main(["approve", "--repo", dir, "pdf"])).toBe(0);
    expect(out.join("\n")).toMatch(/Approved docs\/prototypes\/pdf\/index\.html/);
    expect(out.join("\n")).toMatch(/- id: pdf\n\s+title: "Export reports as PDF"/);
    expect(out.join("\n")).toMatch(/docs\.enabled: true/);
    expect(await readFile(path.join(dir, "docs", "prototypes", "pdf", "approval.json"), "utf8")).toMatch(/"sha256"/);

    out = [];
    expect(await main(["prototype", "--repo", dir, "pdf"])).toBe(0);
    expect(out.join("\n")).toMatch(/pdf is approved/);
    expect(out.join("\n")).toMatch(/Commit and push docs\/prototypes\/pdf\//);
    out = [];
    expect(await main(["approve", "--repo", dir, "pdf"])).toBe(0);
    expect(out.join("\n")).toMatch(/Already approved/);

    await writeFile(index, "<html><body>v2 edited by hand</body></html>");
    out = [];
    expect(await main(["prototype", "--repo", dir, "pdf"])).toBe(0);
    expect(out.join("\n")).toMatch(/pdf is stale/);
  });

  it("status says what foreman is doing right now", async () => {
    await main(["init", "--repo", dir]);
    out = [];
    await main(["status", "--repo", dir]);
    expect(out.join("\n")).toMatch(/Now:\s+not running/);

    const live = new LiveWriter(path.join(dir, ".foreman", "live.json"), { command: "run" }, { minIntervalMs: 5 });
    live.set({ taskId: "example-readme-badge", title: "Add a badge", stage: "Writing the code", step: "code", model: "sonnet", attempt: 2, maxAttempts: 5 });
    await live.flush();
    out = [];
    await main(["status", "--repo", dir]);
    expect(out.join("\n")).toMatch(/Now:\s+working on Add a badge: Writing the code \(sonnet, attempt 2 of 5, \d+s in this step\)/);

    live.set({ idle: true, stage: "Waiting for the next task", taskId: undefined, title: undefined });
    await live.flush();
    out = [];
    await main(["status", "--repo", dir]);
    expect(out.join("\n")).toMatch(/Now:\s+running, waiting for the next task/);

    out = [];
    await main(["dashboard", "--repo", dir]);
    expect(await readFile(path.join(dir, ".foreman", "dashboard.html"), "utf8")).toContain("<strong>Waiting</strong>");
    await live.clear();
  });

  it("status and the dashboard count story-stage spend by model and list each story with its prototype", async () => {
    await main(["init", "--repo", dir]);
    await mkdir(path.join(dir, "docs", "stories"), { recursive: true });
    await mkdir(path.join(dir, "docs", "prototypes", "tickets"), { recursive: true });
    await writeFile(path.join(dir, "docs", "stories", "tickets.md"), "# Ticket queue\n\nBody.\n\n## Acceptance criteria\n- x\n");
    await writeFile(path.join(dir, "docs", "prototypes", "tickets", "index.html"), "<html><body>v1</body></html>");
    const state = await StateStore.open(path.join(dir, ".foreman"));
    await state.addStageSpend("tickets", { role: "analyst", model: "opus", costUsd: 0.4 });
    await state.addStageSpend("tickets", { role: "designer", model: "opus", costUsd: 0.9 });
    await state.addStageSpend("tickets", { role: "critic", model: "sonnet", costUsd: 0.1 });

    out = [];
    expect(await main(["status", "--repo", dir, "--json"])).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.modelUsage).toEqual([
      { model: "opus", calls: 2, roles: ["analyst", "designer"], costUsd: 1.3, pctOfCost: 92.9 },
      { model: "sonnet", calls: 1, roles: ["critic"], costUsd: 0.1, pctOfCost: 7.1 },
    ]);
    expect(j.tasks.map((t: { id: string }) => t.id)).not.toContain("story:tickets"); // not a task
    expect(j.stories).toEqual([{ id: "tickets", title: "Ticket queue", prototype: "draft", costUsd: 1.4, calls: 3 }]);

    out = [];
    await main(["status", "--repo", dir]);
    const text = out.join("\n");
    expect(text).toMatch(/opus\s+2 calls\s+\$\s*1\.30\s+92\.9%\s+analyst, designer/);
    expect(text).toMatch(/Stories and prototypes:\n\s+tickets\s+Needs your approval\s+\$\s*1\.40\s+Ticket queue/);
    expect(text).not.toContain("story:tickets");

    out = [];
    await main(["dashboard", "--repo", dir]);
    const html = await readFile(path.join(dir, ".foreman", "dashboard.html"), "utf8");
    expect(html).toContain("<h2>Stories and prototypes</h2>");
    expect(html).toContain("Needs your approval");
    expect(html).toContain("92.9%");
    expect(html).toContain("analyst, designer");
  });

  it("dashboard --watch refreshes every 3 seconds unless told otherwise", async () => {
    await main(["init", "--repo", dir]);
    const run = main(["dashboard", "--repo", dir, "--watch"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await readFile(path.join(dir, ".foreman", "dashboard.html"), "utf8")).toContain('<meta http-equiv="refresh" content="3">');
    process.emit("SIGINT");
    expect(await run).toBe(0);
  });

  it("reports config errors with exit code 2", async () => {
    expect(await main(["status", "--repo", dir])).toBe(2);
    expect(out.join("\n")).toMatch(/foreman init/);
    expect(await main(["run", "--retry", "--repo", dir])).toBe(2);
  });
});

describe("detectProject", () => {
  it("detects common ecosystems", async () => {
    await writeFile(path.join(dir, "go.mod"), "module x");
    expect(detectProject(dir).checks.map((c) => c.run)).toContain("go test ./...");
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(detectProject(dir)).toEqual({ kind: "node (pnpm)", checks: [{ name: "test", run: "pnpm test" }] });
  });
});
