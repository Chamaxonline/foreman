import { describe, expect, it } from "vitest";
import { TaskRunner } from "../src/loop.js";
import { approvalText, prototypeLayout, type PrototypeState } from "../src/prototype.js";
import { FakeAgents, FakeHost, makeConfig, makeDeps, makeTask, type World } from "./helpers/fakes.js";

const HTML = "<html><body>proto</body></html>";
const l = prototypeLayout(makeConfig(""), "t1");

/** `committed` = files already on the base branch (what the build's worktree sees). */
async function setup(committed: Record<string, string>, local?: PrototypeState) {
  let world!: World;
  const agents = new FakeAgents({ coder: () => (world.edit("src/a.ts"), {}) });
  const made = await makeDeps({ agents, ...(local ? { localPrototypeState: async () => local } : {}) });
  world = made.world;
  for (const [p, c] of Object.entries(committed)) world.seed(p, c);
  return { ...made, agents, host: made.deps.host as FakeHost };
}

describe("TaskRunner: prototype gate", () => {
  it("builds normally when the task has no prototype", async () => {
    const { deps, agents } = await setup({});
    const out = await new TaskRunner(deps).runTask(makeTask());
    expect(out.status).toBe("done");
    expect(agents.byRole("planner")[0]!.prompt).not.toContain("Approved prototype");
    expect(agents.byRole("coder")[0]!.prompt).not.toContain("Approved prototype");
  });

  it("builds to match an approved prototype that is committed on the base branch", async () => {
    const { deps, agents } = await setup({ [l.index]: HTML, [l.approval]: approvalText(HTML) });
    const out = await new TaskRunner(deps).runTask(makeTask());
    expect(out.status).toBe("done");

    for (const role of ["planner", "coder"] as const) {
      const prompt = agents.byRole(role)[0]!.prompt;
      expect(prompt, role).toContain("## Approved prototype");
      expect(prompt, role).toContain("docs/prototypes/t1/index.html");
    }
  });

  it("keeps the approved prototype read-only for every agent", async () => {
    const { deps, agents } = await setup({ [l.index]: HTML, [l.approval]: approvalText(HTML) });
    await new TaskRunner(deps).runTask(makeTask());
    for (const call of agents.calls) {
      expect(call.isProtected("docs/prototypes/t1/index.html"), call.role).toBe(true);
      expect(call.isProtected("docs/prototypes/t1/extra.css"), call.role).toBe(true);
      expect(call.isProtected("src/a.ts"), call.role).toBe(false);
    }
  });

  it("does not build against a draft: nothing is spent and the task waits", async () => {
    const { deps, agents, state, world, host } = await setup({ [l.index]: HTML });
    const out = await new TaskRunner(deps).runTask(makeTask());

    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/not approved yet.*foreman approve t1/s);
    expect(agents.calls).toHaveLength(0);
    expect(host.prs).toEqual([]);
    expect(world.removed).toBe(1); // worktree cleaned up
    expect(state.get("t1")).toMatchObject({ status: "pending", attempts: 0, costUsd: 0 });
    expect(state.get("t1")!.lastError).toMatch(/not approved yet/);
  });

  it("does not build when the prototype changed after it was approved", async () => {
    const { deps, agents } = await setup({ [l.index]: HTML, [l.approval]: approvalText("<html>an older version</html>") });
    const out = await new TaskRunner(deps).runTask(makeTask());
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/changed after it was approved/);
    expect(agents.calls).toHaveLength(0);
  });

  it("does not silently build without a prototype that exists only in the user's checkout", async () => {
    const { deps, agents, state } = await setup({}, "approved");
    const out = await new TaskRunner(deps).runTask(makeTask());
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/in your checkout but not on main/);
    expect(agents.calls).toHaveLength(0);
    expect(state.get("t1")!.status).toBe("pending");
  });

  it("trusts what is committed over the local copy", async () => {
    const { deps } = await setup({ [l.index]: HTML, [l.approval]: approvalText(HTML) }, "draft");
    expect((await new TaskRunner(deps).runTask(makeTask())).status).toBe("done");
  });

  it("a blocked task builds on the next run once the approval is committed", async () => {
    const { deps, agents, world } = await setup({ [l.index]: HTML });
    const runner = new TaskRunner(deps);
    expect((await runner.runTask(makeTask())).status).toBe("skipped");
    expect(agents.calls).toHaveLength(0);

    world.seed(l.approval, approvalText(HTML)); // the user approved and pushed
    const out = await runner.runTask(makeTask());
    expect(out.status).toBe("done");
    expect(agents.byRole("planner")[0]!.prompt).toContain("## Approved prototype");
  });
});
