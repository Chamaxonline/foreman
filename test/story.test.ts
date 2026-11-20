import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentCall, AgentResult, AgentRunner } from "../src/claude.js";
import { storyIdFromIdea, StoryError, writeStory } from "../src/story.js";
import { TASK_ID_RE } from "../src/tasks.js";
import { makeConfig } from "./helpers/fakes.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "foreman-story-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STORY = `# Export reports as PDF

Users need to download a report as a PDF from the reports page.

## Out of scope
- Scheduled exports

## Acceptance criteria
- A "Download PDF" button appears on the report page
- The PDF contains the same rows as the table
- Covered by a test
`;

const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  ok: true, text: "", costUsd: 0.21, turns: 5, subtype: "success", deniedToolCalls: 0, ...over,
});

/** An analyst that writes `content` to the story path it was given, on the real disk. */
function fakeAnalyst(content: string | undefined, over: Partial<AgentResult> = {}) {
  const calls: AgentCall[] = [];
  const runner: AgentRunner = {
    async run(call) {
      calls.push(call);
      if (content !== undefined) {
        const file = /Story file: `([^`]+)`/.exec(call.prompt)![1]!;
        await mkdir(path.dirname(path.join(call.cwd, file)), { recursive: true });
        await writeFile(path.join(call.cwd, file), content);
      }
      return result(over);
    },
  };
  return { runner, calls };
}

const base = (agents: AgentRunner, over: Record<string, unknown> = {}) => ({
  repoDir: dir,
  idea: "Let users export reports as PDF",
  config: makeConfig(""),
  agents,
  systemPrompt: "you are the analyst",
  isProtected: () => false,
  maxBudgetUsd: 5,
  ...over,
});

describe("storyIdFromIdea", () => {
  it("makes a short file-safe id from the first words", () => {
    expect(storyIdFromIdea("Let users export reports as PDF")).toBe("let-users-export-reports-as-pdf");
    expect(storyIdFromIdea("  Add a /health endpoint!!  ")).toBe("add-a-health-endpoint");
  });

  it("caps the length, never ends in a dash, and always yields a valid task id", () => {
    const id = storyIdFromIdea("internationalization-internationalization-internationalization and more words after");
    expect(id.length).toBeLessThanOrEqual(48);
    expect(id.endsWith("-")).toBe(false);
    expect(TASK_ID_RE.test(id)).toBe(true);
  });

  it("falls back to a generated id when the idea has no usable letters", () => {
    const id = storyIdFromIdea("日本語 !!!");
    expect(id).toMatch(/^story-[a-z0-9]+$/);
    expect(TASK_ID_RE.test(id)).toBe(true);
  });
});

describe("writeStory", () => {
  it("runs one analyst call scoped to the docs folder and returns what it wrote", async () => {
    const { runner, calls } = fakeAnalyst(STORY);
    const r = await writeStory(base(runner));

    expect(r).toEqual({
      id: "let-users-export-reports-as-pdf",
      file: "docs/stories/let-users-export-reports-as-pdf.md",
      title: "Export reports as PDF",
      acceptance: ['A "Download PDF" button appears on the report page', "The PDF contains the same rows as the table", "Covered by a test"],
      costUsd: 0.21,
    });
    expect(await readFile(path.join(dir, r.file), "utf8")).toBe(STORY);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "analyst",
      model: "opus",
      cwd: dir,
      readOnly: false,
      allowBash: false,
      allowedCommands: [],
      writeScope: ["docs/stories"],
      maxBudgetUsd: 5,
    });
    expect(calls[0]!.prompt).toContain("Let users export reports as PDF");
    expect(calls[0]!.prompt).toContain("docs/stories/let-users-export-reports-as-pdf.md");
    expect(calls[0]!.systemPrompt).toBe("you are the analyst");
  });

  it("honours --id and a custom docs.dir", async () => {
    const { runner, calls } = fakeAnalyst(STORY);
    const r = await writeStory(base(runner, { id: "pdf-export", config: makeConfig("docs: { dir: notes/stories/ }") }));
    expect(r.file).toBe("notes/stories/pdf-export.md");
    expect(calls[0]!.writeScope).toEqual(["notes/stories"]);
  });

  it("refuses to overwrite an existing story, without calling the agent", async () => {
    await mkdir(path.join(dir, "docs/stories"), { recursive: true });
    await writeFile(path.join(dir, "docs/stories/pdf-export.md"), "# mine\n");
    const { runner, calls } = fakeAnalyst(STORY);
    await expect(writeStory(base(runner, { id: "pdf-export" }))).rejects.toThrow(/already exists/);
    expect(calls).toHaveLength(0);
    expect(await readFile(path.join(dir, "docs/stories/pdf-export.md"), "utf8")).toBe("# mine\n");
  });

  it("rejects an unusable story name, an empty idea and a docs.dir outside the repo", async () => {
    const { runner, calls } = fakeAnalyst(STORY);
    await expect(writeStory(base(runner, { id: "../evil" }))).rejects.toThrow(/not a usable story name/);
    await expect(writeStory(base(runner, { id: "a/b" }))).rejects.toThrow(/not a usable story name/);
    await expect(writeStory(base(runner, { idea: "   " }))).rejects.toThrow(/Give the idea/);
    await expect(writeStory(base(runner, { config: makeConfig("docs: { dir: ../outside }") }))).rejects.toThrow(/inside the repository/);
    expect(calls).toHaveLength(0);
  });

  it("reports an analyst that wrote nothing, and still reports what that attempt cost", async () => {
    const { runner } = fakeAnalyst(undefined, { subtype: "error_max_turns", costUsd: 0.4 });
    const err = await writeStory(base(runner)).catch((e) => e);
    expect(err).toBeInstanceOf(StoryError);
    expect(err.message).toMatch(/did not write docs\/stories\//);
    expect(err.message).toMatch(/error_max_turns/);
    expect(err.costUsd).toBe(0.4);
  });

  it("turns a usage limit and an API failure into clear errors that carry their cost", async () => {
    const limited = await writeStory(base(fakeAnalyst(undefined, { ok: false, subtype: "rate_limited", costUsd: 0 }).runner)).catch((e) => e);
    expect(limited.message).toMatch(/usage limit/);
    const failed = await writeStory(base(fakeAnalyst(undefined, { ok: false, subtype: "exception", error: "boom", costUsd: 0.02 }).runner)).catch((e) => e);
    expect(failed.message).toMatch(/failed: boom/);
    expect(failed.costUsd).toBe(0.02);
  });

  it("still returns a story that has no acceptance criteria, so the caller can warn", async () => {
    const { runner } = fakeAnalyst("# Just a title\n\nSome context.\n");
    const r = await writeStory(base(runner));
    expect(r.title).toBe("Just a title");
    expect(r.acceptance).toEqual([]);
  });
});
