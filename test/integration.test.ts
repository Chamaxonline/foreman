import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { FakeAgents, FakeHost } from "./helpers/fakes.js";
import { git, makeRepo } from "./helpers/gitrepo.js";

/**
 * End-to-end through the real wiring: real git (bare remote), real shell
 * checks, real safety gate; Claude and GitHub are faked.
 */
let repo: Awaited<ReturnType<typeof makeRepo>>;

beforeEach(async () => {
  repo = await makeRepo({
    "foreman.config.yaml": "checks:\n  test: node check.js\nreview: { enabled: false }\nlimits: { maxAttemptsPerTask: 3 }\n",
    "tasks.yaml": "tasks:\n  - id: answer\n    title: Write the answer file\n    acceptance: [answer.txt contains 42]\n",
    "check.js": "const fs=require('fs');const v=fs.existsSync('answer.txt')&&fs.readFileSync('answer.txt','utf8').trim();if(v!=='42'){console.error('expected 42, got '+v);process.exit(1)}console.log('ok')\n",
    "package.json": '{"name":"t","private":true}\n',
  });
});
afterEach(async () => {
  await repo.cleanup();
});

describe("integration", () => {
  it("retries after a failing check, rejects protected edits, then opens a PR from a pushed branch", async () => {
    const agents = new FakeAgents({
      coder: async (call, n) => {
        if (n === 1) await writeFile(path.join(call.cwd, "answer.txt"), "41\n");
        if (n === 2) {
          await writeFile(path.join(call.cwd, "answer.txt"), "42\n");
          // sneak in a protected change: must be rejected and reverted
          await writeFile(path.join(call.cwd, "check.js"), "process.exit(0)\n");
        }
        if (n === 3) await writeFile(path.join(call.cwd, "answer.txt"), "42\n");
        return { text: `attempt ${n}` };
      },
    });
    const gh = new FakeHost();
    const rt = await createRuntime({ repoDir: repo.work, dryRun: false, agents, host: gh });
    const report = await rt.orchestrator.runOnce();

    expect(report.tasks[0]).toMatchObject({ taskId: "answer", status: "done", attempts: 3 });
    expect(report.tasks[0]!.history.map((h) => h.outcome)).toEqual(["check_failed", "rejected", "pass"]);
    expect(agents.byRole("coder")[1]!.prompt).toContain("expected 42, got 41");
    expect(agents.byRole("coder")[2]!.prompt).toMatch(/check\.js: modifies protected path/);

    // branch pushed to the remote with only the allowed change; base untouched
    const files = await git(repo.remote, "ls-tree", "-r", "--name-only", "foreman/answer");
    expect(files).toContain("answer.txt");
    expect((await git(repo.remote, "show", "foreman/answer:check.js")).trim()).toMatch(/^const fs=/);
    expect((await git(repo.remote, "log", "-1", "--format=%s", "main")).trim()).toBe("init");
    expect(gh.prs[0]).toMatchObject({ head: "foreman/answer", base: "main", draft: false });

    // worktree cleaned up; .foreman excluded locally; reports written
    expect(await git(repo.work, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(repo.work, ".foreman", "reports", "latest.md"), "utf8")).toContain("answer");
    expect(rt.state.get("answer")!.status).toBe("done");
  });

  it("dry run commits nothing to the remote and opens no PR", async () => {
    const agents = new FakeAgents({
      coder: async (call) => (await writeFile(path.join(call.cwd, "answer.txt"), "42\n"), {}),
    });
    const gh = new FakeHost();
    const rt = await createRuntime({ repoDir: repo.work, dryRun: true, agents, host: gh });
    const report = await rt.orchestrator.runOnce();
    expect(report.tasks[0]).toMatchObject({ status: "done", dryRun: true });
    expect(gh.prs).toEqual([]);
    expect((await git(repo.remote, "branch", "--list", "foreman/*")).trim()).toBe("");
  });
});
