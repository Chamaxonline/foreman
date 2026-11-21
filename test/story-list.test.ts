import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvalText } from "../src/prototype.js";
import { listStories } from "../src/story.js";
import { makeConfig } from "./helpers/fakes.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "foreman-stories-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PROTO = "<html><body>proto</body></html>";
const story = (id: string, title: string, when: number) =>
  mkdir(path.join(dir, "docs/stories"), { recursive: true })
    .then(() => writeFile(path.join(dir, `docs/stories/${id}.md`), `# ${title}\n\nBody.\n\n## Acceptance criteria\n- x\n`))
    .then(() => utimes(path.join(dir, `docs/stories/${id}.md`), when / 1000, when / 1000));
const prototype = async (id: string, approved: boolean) => {
  await mkdir(path.join(dir, `docs/prototypes/${id}`), { recursive: true });
  await writeFile(path.join(dir, `docs/prototypes/${id}/index.html`), PROTO);
  if (approved) await writeFile(path.join(dir, `docs/prototypes/${id}/approval.json`), approvalText(PROTO));
};

describe("listStories", () => {
  const cfg = makeConfig("");

  it("lists stories newest first with their title, prototype state and what they cost", async () => {
    await story("alpha", "Alpha story", Date.parse("2026-01-01T00:00:00Z"));
    await story("beta", "Beta story", Date.parse("2026-01-02T00:00:00Z"));
    await story("gamma", "Gamma story", Date.parse("2026-01-03T00:00:00Z"));
    await prototype("alpha", false); // built, not approved
    await prototype("beta", true); // approved
    // gamma has no prototype

    const rows = await listStories(dir, cfg, { alpha: { costUsd: 1.2, calls: 3 }, beta: { costUsd: 0.5, calls: 1 } });
    expect(rows).toEqual([
      { id: "gamma", title: "Gamma story", prototype: "none", costUsd: 0, calls: 0 },
      { id: "beta", title: "Beta story", prototype: "approved", costUsd: 0.5, calls: 1 },
      { id: "alpha", title: "Alpha story", prototype: "draft", costUsd: 1.2, calls: 3 },
    ]);
  });

  it("shows a prototype edited after approval as changed", async () => {
    await story("alpha", "Alpha", Date.now());
    await prototype("alpha", true);
    await writeFile(path.join(dir, "docs/prototypes/alpha/index.html"), PROTO + "<!-- hand edit -->");
    expect((await listStories(dir, cfg, {}))[0]!.prototype).toBe("stale");
  });

  it("ignores files that are not stories, falls back to the id when a story has no heading, and honours the limit", async () => {
    await story("one", "One", Date.parse("2026-01-01T00:00:00Z"));
    await story("two", "Two", Date.parse("2026-01-02T00:00:00Z"));
    await writeFile(path.join(dir, "docs/stories/notes.txt"), "not a story");
    await writeFile(path.join(dir, "docs/stories/has space.md"), "# Bad id");
    await writeFile(path.join(dir, "docs/stories/untitled.md"), "no heading here");
    const all = await listStories(dir, cfg, {});
    expect(all.map((r) => r.id).sort()).toEqual(["one", "two", "untitled"]);
    expect(all.find((r) => r.id === "untitled")!.title).toBe("untitled");
    expect(await listStories(dir, cfg, {}, 1)).toHaveLength(1);
  });

  it("follows a custom docs folder, and is empty when there is none", async () => {
    expect(await listStories(dir, cfg, {})).toEqual([]);
    await mkdir(path.join(dir, "specs"), { recursive: true });
    await writeFile(path.join(dir, "specs/x.md"), "# Custom");
    expect((await listStories(dir, makeConfig("docs: { dir: specs }"), {})).map((r) => r.title)).toEqual(["Custom"]);
  });
});
