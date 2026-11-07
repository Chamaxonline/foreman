import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseConfig } from "../src/config.js";
import { makeProtectedMatcher } from "../src/safety.js";
import { parseTasks } from "../src/tasks.js";

const ex = path.resolve(import.meta.dirname, "..", "examples", "node-service");

describe("examples/node-service", () => {
  const cfg = parseConfig(readFileSync(path.join(ex, "foreman.config.yaml"), "utf8"));

  it("has a valid config and task list", () => {
    expect(cfg.checks.map((c) => c.run)).toEqual(["npm run lint", "npm test"]);
    const tasks = parseTasks(readFileSync(path.join(ex, "tasks.yaml"), "utf8"));
    expect(tasks.map((t) => t.id)).toEqual(["mean-empty-list", "add-median", "readme"]);
    expect(tasks[2]!.model).toBe("haiku");
  });

  it("protects its check scripts", () => {
    const p = makeProtectedMatcher(cfg);
    expect(p("scripts/lint.js")).toBe(true);
    expect(p("src/math.js")).toBe(false);
  });

  it("checks pass on the example as shipped", () => {
    for (const script of ["lint", "test"]) {
      const r = spawnSync("npm", ["run", script], { cwd: ex, shell: true, encoding: "utf8" });
      expect(r.status, `${script}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });

  it("workflow is valid YAML with least-privilege permissions and no persisted credentials", () => {
    const wf = YAML.parse(readFileSync(path.join(ex, ".github", "workflows", "foreman.yml"), "utf8"));
    expect(wf.permissions).toMatchObject({ contents: "write", "pull-requests": "write" });
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
    const checkout = wf.jobs.foreman.steps.find((s: { uses?: string }) => s.uses?.startsWith("actions/checkout"));
    expect(checkout.with["persist-credentials"]).toBe(false);
  });
});

describe("examples/azure-devops", () => {
  const dir = path.resolve(import.meta.dirname, "..", "examples", "azure-devops");

  it("config is valid and targets Azure DevOps", () => {
    const cfg = parseConfig(readFileSync(path.join(dir, "foreman.config.yaml"), "utf8"));
    expect(cfg.provider).toBe("azure-devops");
    expect(cfg.issues.enabled).toBe(true);
  });

  it("pipeline is valid YAML, keeps credentials out of the checkout and passes the job token only to foreman", () => {
    const p = YAML.parse(readFileSync(path.join(dir, "foreman-pipeline.yml"), "utf8"));
    const steps = p.jobs[0].steps as Array<Record<string, any>>;
    const checkoutStep = steps.find((s) => s.checkout);
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep!.persistCredentials).toBe(false);
    const run = steps.find((s) => s.displayName === "Run foreman")!;
    expect(run.env.SYSTEM_ACCESSTOKEN).toBe("$(System.AccessToken)");
    expect(run.script).toContain("claude-foreman");
    expect(p.lockBehavior).toBe("sequential");
  });
});
