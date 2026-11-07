import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { parseConfig } from "../src/config.js";
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
