import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VIEWPORTS, type RenderResult } from "../src/browser.js";
import type { AgentCall, AgentResult, AgentRunner } from "../src/claude.js";
import { critiqueAndRefine, type CritiqueRequest } from "../src/critique.js";
import { critiqueFeedback, critiquePrompt, parseCritique, type Critique } from "../src/prompts.js";
import { makeConfig } from "./helpers/fakes.js";

const issue = (over: Record<string, unknown> = {}) => ({ severity: "major", where: "mobile", problem: "The table overflows the screen", fix: "Stack the rows as cards", ...over });
const verdict = (over: Record<string, unknown> = {}) => ({ sawScreenshots: true, verdict: "approve", summary: "Looks good.", issues: [], ...over });

describe("parseCritique", () => {
  it("reads a structured verdict", () => {
    const c = parseCritique(verdict({ verdict: "revise", issues: [issue(), issue({ severity: "minor", problem: "Dates are low contrast", fix: "Use the primary text color" })] }), "");
    expect(c).toMatchObject({ sawScreenshots: true, verdict: "revise", summary: "Looks good." });
    expect(c!.issues).toHaveLength(2);
    expect(c!.issues[0]).toEqual({ severity: "major", where: "mobile", problem: "The table overflows the screen", fix: "Stack the rows as cards" });
  });

  it("is tolerant of loose issues: drops empty ones, defaults severity to minor, trims", () => {
    const c = parseCritique(verdict({ verdict: "revise", issues: [{ problem: "  no severity  ", fix: "x" }, { severity: "major", problem: "" }, "junk", null, { severity: "major", problem: "ok", where: "  " }] }), "")!;
    expect(c.issues).toEqual([
      { severity: "minor", problem: "no severity", fix: "x" },
      { severity: "major", problem: "ok", fix: "" },
    ]);
  });

  it("rejects an unknown verdict, and falls back to a JSON object in the text", () => {
    expect(parseCritique({ verdict: "maybe" }, "")).toBeUndefined();
    expect(parseCritique(undefined, "no json here")).toBeUndefined();
    const fromText = parseCritique(undefined, `Here you go: ${JSON.stringify(verdict({ verdict: "revise", issues: [issue()] }))}`);
    expect(fromText).toMatchObject({ verdict: "revise" });
    expect(fromText!.issues).toHaveLength(1);
  });

  it("treats a missing sawScreenshots as seen, but an explicit false as not seen", () => {
    expect(parseCritique({ verdict: "approve", summary: "", issues: [] }, "")!.sawScreenshots).toBe(true);
    expect(parseCritique(verdict({ sawScreenshots: false }), "")!.sawScreenshots).toBe(false);
  });
});

describe("critiqueFeedback and critiquePrompt", () => {
  it("feedback puts major issues first, caps at eight, and includes each fix", () => {
    const issues = [
      ...Array.from({ length: 6 }, (_, i) => issue({ severity: "minor", problem: `minor ${i}`, fix: `fix m${i}` })),
      ...Array.from({ length: 4 }, (_, i) => issue({ problem: `major ${i}`, fix: `fix M${i}` })),
    ];
    const c = parseCritique(verdict({ verdict: "revise", summary: "Needs work", issues }), "") as Critique;
    const text = critiqueFeedback(c);
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 4).every((l) => l.startsWith("- [major]"))).toBe(true);
    expect(text).toContain("Fix: fix M0");
    expect(text).toContain("Reviewer's summary: Needs work");
    expect(text).toMatch(/keep everything that already works/);
  });

  it("feedback and prompt leave out the measured-facts sections when nothing was measured", () => {
    const c = parseCritique(verdict({ verdict: "revise", issues: [issue()] }), "") as Critique;
    expect(critiqueFeedback(c)).not.toContain("Measured in a real browser");
    expect(critiquePrompt({ path: "s.md", content: "x" }, [], 1, [])).not.toContain("Measured by the browser");
    expect(critiqueFeedback(c, ["A fact."])).toContain("- A fact.");
  });

  it("the prompt lists every screenshot to open, plus console output and last review's issues when there are any", () => {
    const shots = [
      { path: ".foreman/screens/pdf/r2-desktop.png", description: "desktop, 1280px wide, light mode" },
      { path: ".foreman/screens/pdf/r2-mobile.png", description: "mobile, 390px wide, light mode" },
    ];
    const first = critiquePrompt({ path: "docs/stories/pdf.md", content: "# Export\n\n## Acceptance criteria\n- A button\n" }, shots, 1, []);
    expect(first).toContain("(review 1)");
    expect(first).toContain("- A button");
    expect(first).toContain("`.foreman/screens/pdf/r2-desktop.png`: desktop, 1280px wide, light mode");
    expect(first).not.toContain("logged in the browser");
    expect(first).not.toContain("Reported last review");

    const second = critiquePrompt({ path: "s.md", content: "x" }, shots, 2, ["Uncaught Error: boom"], [{ severity: "major", where: "mobile", problem: "Overflow", fix: "" }]);
    expect(second).toContain("(review 2)");
    expect(second).toContain("- Uncaught Error: boom");
    expect(second).toContain("- [major] (mobile) Overflow");
  });
});

describe("critiqueAndRefine", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "foreman-crit-"));
    await mkdir(path.join(dir, "docs/stories"), { recursive: true });
    await mkdir(path.join(dir, "docs/prototypes/pdf"), { recursive: true });
    await writeFile(path.join(dir, "docs/stories/pdf.md"), "# Export reports as PDF\n\nBody.\n\n## Acceptance criteria\n- A button\n");
    await writeFile(path.join(dir, "docs/prototypes/pdf/index.html"), "<html><head></head><body>v1</body></html>");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const result = (over: Partial<AgentResult> = {}): AgentResult => ({ ok: true, text: "", costUsd: 0.3, turns: 3, subtype: "success", deniedToolCalls: 0, ...over });

  interface Script {
    /** What the n-th critic call returns (1-based). The last entry repeats. */
    critic: Array<Partial<AgentResult>>;
    designer?: (n: number) => Partial<AgentResult>;
  }

  function agents(s: Script) {
    const calls: AgentCall[] = [];
    let critics = 0;
    let designers = 0;
    const runner: AgentRunner = {
      async run(call) {
        calls.push(call);
        if (call.role === "critic") {
          const r = s.critic[Math.min(critics++, s.critic.length - 1)]!;
          return result(r);
        }
        designers++;
        const over = s.designer?.(designers) ?? {};
        if (over.subtype !== "exception") {
          const folder = /Prototype folder: `([^`]+)`/.exec(call.prompt)![1]!;
          await writeFile(path.join(call.cwd, folder, "index.html"), `<html><head></head><body>v${designers + 1}</body></html>`);
        }
        return result({ costUsd: 0.5, ...over });
      },
    };
    return { runner, calls, critic: () => calls.filter((c) => c.role === "critic"), designer: () => calls.filter((c) => c.role === "designer") };
  }

  const structured = (v: Record<string, unknown>): Partial<AgentResult> => ({ structured: v });

  function render(over: Partial<RenderResult> = {}, log: string[] = []) {
    return async (_file: string, outDir: string, prefix: string): Promise<RenderResult> => {
      log.push(prefix);
      return {
        consoleIssues: [],
        layoutIssues: [],
        ...over,
        screens: VIEWPORTS.map((vp) => ({ viewport: vp, file: path.join(outDir, `${prefix}-${vp.name}.png`), width: vp.width, height: 900 })),
      };
    };
  }

  const req = (a: ReturnType<typeof agents>, over: Partial<CritiqueRequest> = {}): CritiqueRequest => ({
    repoDir: dir,
    id: "pdf",
    config: makeConfig(""),
    agents: a.runner,
    designerPrompt: "you are the designer",
    criticPrompt: "you are the critic",
    isProtected: () => false,
    maxBudgetUsd: 10,
    render: render(),
    ...over,
  });

  const index = () => readFile(path.join(dir, "docs/prototypes/pdf/index.html"), "utf8");

  it("approves in one review without calling the designer", async () => {
    const a = agents({ critic: [structured(verdict())] });
    const out = await critiqueAndRefine(req(a));

    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0]).toMatchObject({ round: 1, revised: false });
    expect(out.rounds[0]!.critique.verdict).toBe("approve");
    expect(out.stopped).toBeUndefined();
    expect(out.costUsd).toBeCloseTo(0.3);
    expect(out.screensDir).toBe(".foreman/screens/pdf");
    expect(a.designer()).toHaveLength(0);

    const c = a.critic()[0]!;
    expect(c).toMatchObject({ role: "critic", model: "opus", readOnly: true, allowBash: false, allowedCommands: [], cwd: dir });
    expect(c.outputSchema).toBeDefined();
    expect(c.systemPrompt).toBe("you are the critic");
    expect(c.prompt).toContain(".foreman/screens/pdf/r1-desktop.png");
    expect(c.prompt).toContain(".foreman/screens/pdf/r1-mobile.png");
    expect(c.prompt).toContain(".foreman/screens/pdf/r1-desktop-dark.png");
  });

  it("sends the issues to the designer, re-renders, and approves the fixed version", async () => {
    const a = agents({ critic: [structured(verdict({ verdict: "revise", summary: "Mobile is broken", issues: [issue()] })), structured(verdict())] });
    const rendered: string[] = [];
    const out = await critiqueAndRefine(req(a, { render: render({}, rendered) }));

    expect(out.rounds.map((r) => [r.round, r.revised, r.critique.verdict])).toEqual([[1, true, "revise"], [2, false, "approve"]]);
    expect(rendered).toEqual(["r1", "r2"]);
    expect(out.costUsd).toBeCloseTo(0.3 + 0.5 + 0.3);
    expect(a.designer()).toHaveLength(1);

    const d = a.designer()[0]!;
    expect(d.systemPrompt).toBe("you are the designer");
    expect(d.prompt).toContain("The table overflows the screen");
    expect(d.prompt).toContain("Fix: Stack the rows as cards");
    expect(d.prompt).toContain("Read `docs/prototypes/pdf/index.html` first");
    expect(d.writeScope).toEqual(["docs/prototypes/pdf"]);

    // the second review is told what it reported before
    expect(a.critic()[1]!.prompt).toContain("Reported last review");
    expect(a.critic()[1]!.prompt).toContain("- [major] (mobile) The table overflows the screen");
    // the revision is still locked down
    expect(await index()).toContain("v2");
    expect(await index()).toContain("Content-Security-Policy");
  });

  it("stops after maxRevisions fixes, and the last review always judges the final version", async () => {
    const a = agents({ critic: [structured(verdict({ verdict: "revise", issues: [issue()] }))] });
    const out = await critiqueAndRefine(req(a, { config: makeConfig("prototype: { critique: { maxRevisions: 1 } }") }));

    expect(a.critic()).toHaveLength(2); // before and after the one fix
    expect(a.designer()).toHaveLength(1);
    expect(out.rounds.map((r) => r.revised)).toEqual([true, false]);
    expect(out.rounds.at(-1)!.critique.issues).toHaveLength(1); // still open, and reported
    expect(out.stopped).toBeUndefined();
  });

  it("treats 'revise' with nothing actionable as an approval", async () => {
    const a = agents({ critic: [structured(verdict({ verdict: "revise", issues: [] }))] });
    const out = await critiqueAndRefine(req(a));
    expect(a.designer()).toHaveLength(0);
    expect(out.rounds).toHaveLength(1);
  });

  it("surfaces the page's console issues and shows them to the critic", async () => {
    const a = agents({ critic: [structured(verdict())] });
    const out = await critiqueAndRefine(req(a, { render: render({ consoleIssues: ["Uncaught TypeError: x is null"] }) }));
    expect(out.consoleIssues).toEqual(["Uncaught TypeError: x is null"]);
    expect(a.critic()[0]!.prompt).toContain("Uncaught TypeError: x is null");
  });

  it("lists every agent call it made with its role and model, and reports each step as it goes", async () => {
    const a = agents({ critic: [structured(verdict({ verdict: "revise", issues: [issue()] })), structured(verdict())] });
    const stages: string[] = [];
    const out = await critiqueAndRefine(req(a, { onStage: (s) => stages.push(`${s.label}|${s.role ?? ""}|${s.model ?? ""}`) }));

    expect(out.calls).toEqual([
      { role: "critic", model: "opus", costUsd: 0.3 },
      { role: "designer", model: "opus", costUsd: 0.5 },
      { role: "critic", model: "opus", costUsd: 0.3 },
    ]);
    expect(out.calls.reduce((sum, c) => sum + c.costUsd, 0)).toBeCloseTo(out.costUsd);
    expect(stages).toEqual([
      "Taking screenshots of the prototype||",
      "The critic is reviewing the design (review 1)|critic|opus",
      "The designer is fixing the issues (fix 1 of 2)|designer|opus",
      "Taking new screenshots||",
      "The critic is reviewing the design (review 2)|critic|opus",
    ]);
  });

  it("counts a designer fix that failed but still cost something", async () => {
    const a = agents({
      critic: [structured(verdict({ verdict: "revise", issues: [issue()] }))],
      designer: () => ({ ok: false, subtype: "exception", error: "api down", costUsd: 0.04 }),
    });
    const out = await critiqueAndRefine(req(a));
    expect(out.calls).toEqual([
      { role: "critic", model: "opus", costUsd: 0.3 },
      { role: "designer", model: "opus", costUsd: 0.04 },
    ]);
  });

  it("gives measured layout facts to the critic as defects and to the designer to fix first", async () => {
    const fact = "At 390px wide the page scrolls sideways: its content is 620px wide. Sticking out past the screen: div#tabs.tabs (reaches 620px, 620px wide).";
    const a = agents({ critic: [structured(verdict({ verdict: "revise", issues: [issue()] })), structured(verdict())] });
    const out = await critiqueAndRefine(req(a, { render: render({ layoutIssues: [fact] }) }));

    const first = a.critic()[0]!.prompt;
    expect(first).toContain("## Measured by the browser (facts, not opinions)");
    expect(first).toContain(fact);
    expect(first).toMatch(/report it as a major issue and name the elements/);

    const feedback = a.designer()[0]!.prompt;
    expect(feedback).toContain("Measured in a real browser (facts, not opinions; fix these first)");
    expect(feedback).toContain("div#tabs.tabs (reaches 620px, 620px wide)");
    expect(out.layoutIssues).toEqual([fact]);
  });

  it("tells the critic what each extra screenshot shows", async () => {
    const a = agents({ critic: [structured(verdict())] });
    const withScreens = async (outDir: string, prefix: string): Promise<RenderResult> => ({
      consoleIssues: [],
      layoutIssues: [],
      screens: [
        { viewport: VIEWPORTS[0]!, file: path.join(outDir, `${prefix}-desktop.png`), width: 1280, height: 900 },
        { viewport: VIEWPORTS[0]!, description: 'the "Ticket detail" screen (the page opened at #/tickets/1), desktop, 1280px wide, light mode', file: path.join(outDir, `${prefix}-ticket-detail-desktop.png`), width: 1280, height: 900 },
      ],
    });
    await critiqueAndRefine(req(a, { render: (_f, outDir, prefix) => withScreens(outDir, prefix) }));
    const prompt = a.critic()[0]!.prompt;
    expect(prompt).toContain("`.foreman/screens/pdf/r1-desktop.png`: desktop, 1280px wide, light mode");
    expect(prompt).toContain('`.foreman/screens/pdf/r1-ticket-detail-desktop.png`: the "Ticket detail" screen (the page opened at #/tickets/1)');
  });

  it("does not pretend a design was reviewed when the critic could not see the screenshots", async () => {
    const a = agents({ critic: [structured(verdict({ sawScreenshots: false, summary: "No image came back" }))] });
    const out = await critiqueAndRefine(req(a));
    expect(out.rounds).toEqual([]);
    expect(out.stopped).toMatch(/could not view the screenshots/);
    expect(out.stopped).toContain(".foreman/screens/pdf/");
    expect(out.costUsd).toBeCloseTo(0.3); // the call was still paid for
    expect(a.designer()).toHaveLength(0);
  });

  it("keeps going with a note when the browser fails, and never calls an agent", async () => {
    const a = agents({ critic: [structured(verdict())] });
    const out = await critiqueAndRefine(req(a, { render: async () => { throw new Error("the browser crashed"); } }));
    expect(out.stopped).toMatch(/Could not render the prototype: the browser crashed/);
    expect(out.rounds).toEqual([]);
    expect(out.costUsd).toBe(0);
    expect(a.calls).toHaveLength(0);
  });

  it("stops cleanly on an unusable verdict, a usage limit and an API failure", async () => {
    expect((await critiqueAndRefine(req(agents({ critic: [{ text: "I like it" }] })))).stopped).toMatch(/no usable verdict/);
    expect((await critiqueAndRefine(req(agents({ critic: [{ ok: false, subtype: "rate_limited", costUsd: 0 }] })))).stopped).toMatch(/usage limit/);
    const failed = await critiqueAndRefine(req(agents({ critic: [{ ok: false, subtype: "exception", error: "boom", costUsd: 0.02 }] })));
    expect(failed.stopped).toMatch(/critic call failed: boom/);
    expect(failed.costUsd).toBeCloseTo(0.02);
  });

  it("keeps the prototype and records the review when the designer's fix fails", async () => {
    const a = agents({
      critic: [structured(verdict({ verdict: "revise", issues: [issue()] }))],
      designer: () => ({ ok: false, subtype: "exception", error: "api down", costUsd: 0.04 }),
    });
    const out = await critiqueAndRefine(req(a));
    expect(out.stopped).toMatch(/designer's fix did not go through/);
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0]!.revised).toBe(false);
    expect(out.costUsd).toBeCloseTo(0.3 + 0.04);
    expect(await index()).toContain("v1"); // untouched
  });

  it("respects the spend limit before and during the loop", async () => {
    const none = agents({ critic: [structured(verdict())] });
    const before = await critiqueAndRefine(req(none, { maxBudgetUsd: 0.04 }));
    expect(before.stopped).toMatch(/spend limit/);
    expect(none.calls).toHaveLength(0);

    // the critic call uses up the budget, so there is nothing left to pay the designer with
    const mid = agents({ critic: [{ ...structured(verdict({ verdict: "revise", issues: [issue()] })), costUsd: 1 }] });
    const out = await critiqueAndRefine(req(mid, { maxBudgetUsd: 1 }));
    expect(out.stopped).toMatch(/spend limit was reached before the designer/);
    expect(mid.designer()).toHaveLength(0);
    expect(out.rounds).toHaveLength(1);
  });

  it("gives each call only what is left of the budget", async () => {
    const a = agents({ critic: [structured(verdict({ verdict: "revise", issues: [issue()] })), structured(verdict())] });
    await critiqueAndRefine(req(a, { maxBudgetUsd: 2 }));
    expect(a.calls.map((c) => c.maxBudgetUsd)).toEqual([2, 1.7, 1.2]);
  });

  it("stops when interrupted, and clears the previous run's screenshots first", async () => {
    await mkdir(path.join(dir, ".foreman/screens/pdf"), { recursive: true });
    await writeFile(path.join(dir, ".foreman/screens/pdf/stale.png"), "old");
    const ctl = new AbortController();
    ctl.abort();
    const a = agents({ critic: [structured(verdict())] });
    const out = await critiqueAndRefine(req(a, { signal: ctl.signal }));
    expect(out.stopped).toBe("Interrupted.");
    expect(a.calls).toHaveLength(0);
    await expect(readFile(path.join(dir, ".foreman/screens/pdf/stale.png"))).rejects.toThrow();
  });
});
