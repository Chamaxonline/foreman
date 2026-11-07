import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pluginDir } from "../src/roles.js";
import { BUILTIN_PROTECTED } from "../src/safety.js";
import { templatesConfigSample } from "./helpers/samples.js";

const plugin = pluginDir();
const scripts = path.join(plugin, "scripts");
interface Lib {
  BUILTIN_PROTECTED: string[];
  readForemanConfig(dir: string): { checks: Array<{ name: string; run: string }>; protectedPaths: string[]; tasksFile: string } | undefined;
}
let lib: Lib;
let proj: string;

beforeAll(async () => {
  lib = (await import(path.join(scripts, "lib.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"))) as Lib;
  proj = await mkdtemp(path.join(os.tmpdir(), "foreman-plugin-"));
  await writeFile(
    path.join(proj, "foreman.config.yaml"),
    `checks:\n  lint: "node -e \\"process.exit(0)\\""\n  test: node fail.js # comment\ntasksFile: work/tasks.yaml\nprotectedPaths:\n  - db/migrations/**\n`,
  );
  await writeFile(path.join(proj, "fail.js"), "console.error('boom: expected 1'); process.exit(1)\n");
  spawnSync("git", ["init", "-q"], { cwd: proj });
});
afterAll(async () => {
  await rm(proj, { recursive: true, force: true });
});

function runHook(script: string, input: object, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(scripts, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
  });
}

describe("plugin layout", () => {
  it("has a manifest, three agents with models, a command and hooks", () => {
    const manifest = JSON.parse(readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("foreman");
    for (const a of ["planner", "coder", "reviewer"]) {
      const text = readFileSync(path.join(plugin, "agents", `${a}.md`), "utf8");
      expect(text).toMatch(new RegExp(`^---\\r?\\nname: ${a}\\r?\\n`));
      expect(text).toMatch(/\nmodel: (opus|sonnet|haiku)\r?\n/);
    }
    expect(existsSync(path.join(plugin, "commands", "foreman.md"))).toBe(true);
    const hooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(hooks.hooks)).toEqual(["PreToolUse", "Stop"]);
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    const pkg = JSON.parse(readFileSync(path.join(plugin, "..", "package.json"), "utf8"));
    expect(manifest.version).toBe(pkg.version);
  });

  it("plugin protected list matches the runner's", () => {
    expect(lib.BUILTIN_PROTECTED).toEqual(BUILTIN_PROTECTED);
  });
});

describe("plugin config reader", () => {
  it("reads checks (map form, quoted, comments), tasksFile and protectedPaths", () => {
    const cfg = lib.readForemanConfig(proj)!;
    expect(cfg.checks).toEqual([
      { name: "lint", run: 'node -e "process.exit(0)"' },
      { name: "test", run: "node fail.js" },
    ]);
    expect(cfg.tasksFile).toBe("work/tasks.yaml");
    expect(cfg.protectedPaths).toEqual(["db/migrations/**"]);
  });

  it("reads list-form checks and the init template", async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), "foreman-plugin-cfg-"));
    await writeFile(
      path.join(d, "foreman.config.yaml"),
      "checks:\n  - name: build\n    run: npm run build\n    timeoutMinutes: 5\n  - { name: test, run: \"npm test\" }\nprotectedPaths: [a/**, 'b/*']\n",
    );
    const cfg = lib.readForemanConfig(d)!;
    expect(cfg.checks).toEqual([
      { name: "build", run: "npm run build" },
      { name: "test", run: "npm test" },
    ]);
    expect(cfg.protectedPaths).toEqual(["a/**", "b/*"]);
    await writeFile(path.join(d, "foreman.config.yaml"), templatesConfigSample());
    expect(lib.readForemanConfig(d)!.checks).toEqual([{ name: "build", run: "npm run build" }, { name: "test", run: "npm test" }]);
    await rm(d, { recursive: true, force: true });
  });
});

describe("guard hook", () => {
  it("blocks edits to protected paths with exit 2", () => {
    for (const f of ["vitest.config.ts", ".github/workflows/ci.yml", "work/tasks.yaml", "db/migrations/1.sql", "foreman.config.yaml"]) {
      const r = runHook("guard.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(proj, f) } });
      expect(r.status, f).toBe(2);
      expect(r.stderr).toMatch(/protected/);
    }
  });

  it("allows ordinary edits", () => {
    const r = runHook("guard.mjs", { tool_name: "Write", tool_input: { file_path: path.join(proj, "src/x.ts") } });
    expect(r.status).toBe(0);
  });

  it("blocks force pushes, pushes to main and merges", () => {
    for (const command of ["git push --force origin foreman/x", "git push origin HEAD:main", "git push -f", "gh pr merge 3"]) {
      expect(runHook("guard.mjs", { tool_name: "Bash", tool_input: { command } }).status, command).toBe(2);
    }
    expect(runHook("guard.mjs", { tool_name: "Bash", tool_input: { command: "git push origin foreman/x" } }).status).toBe(0);
    expect(runHook("guard.mjs", { tool_name: "Bash", tool_input: { command: "npm test" } }).status).toBe(0);
  });
});

describe("stop hook (run-checks)", () => {
  it("does nothing when the tree is clean", () => {
    spawnSync("git", ["add", "-A"], { cwd: proj });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: proj });
    expect(runHook("run-checks.mjs", { session_id: "clean" }).status).toBe(0);
  });

  it("blocks stopping while checks fail, then gives up after the retry cap", async () => {
    await writeFile(path.join(proj, "changed.txt"), "x");
    const sid = `s${Date.now()}`;
    const first = runHook("run-checks.mjs", { session_id: sid }, { FOREMAN_MAX_STOP_RETRIES: "2" });
    expect(first.status).toBe(2);
    expect(first.stderr).toContain("boom: expected 1");
    expect(runHook("run-checks.mjs", { session_id: sid }, { FOREMAN_MAX_STOP_RETRIES: "2" }).status).toBe(2);
    expect(runHook("run-checks.mjs", { session_id: sid }, { FOREMAN_MAX_STOP_RETRIES: "2" }).status).toBe(0);
  });

  it("can be disabled", () => {
    expect(runHook("run-checks.mjs", { session_id: "off" }, { FOREMAN_PLUGIN_CHECKS: "0" }).status).toBe(0);
  });
});
