import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentCall, AgentResult, AgentRunner } from "../src/claude.js";
import {
  approvalText,
  approvePrototype,
  decideGate,
  externalReferences,
  localPrototypeState,
  lockdownHtml,
  PrototypeError,
  prototypeLayout,
  stateFromFiles,
  writePrototype,
} from "../src/prototype.js";
import { makeProtectedMatcher } from "../src/safety.js";
import { makeConfig } from "./helpers/fakes.js";

const HTML = "<!doctype html>\n<html><head><title>x</title></head><body><button>Go</button></body></html>\n";

describe("prototypeLayout", () => {
  it("puts the prototype under prototype.dir/<id> and the story under docs.dir", () => {
    expect(prototypeLayout(makeConfig(""), "pdf")).toEqual({
      dir: "docs/prototypes/pdf",
      index: "docs/prototypes/pdf/index.html",
      approval: "docs/prototypes/pdf/approval.json",
      story: "docs/stories/pdf.md",
    });
  });

  it("normalizes a leading ./ and trailing slash in the configured folders", () => {
    const l = prototypeLayout(makeConfig("prototype: { dir: ./ui/protos/ }\ndocs: { dir: /specs/ }"), "a");
    expect(l.dir).toBe("ui/protos/a");
    expect(l.story).toBe("specs/a.md");
  });
});

describe("stateFromFiles", () => {
  it("is none without an index, draft without an approval, approved when the hash matches", () => {
    expect(stateFromFiles(undefined, undefined)).toBe("none");
    expect(stateFromFiles("   ", approvalText(HTML))).toBe("none");
    expect(stateFromFiles(HTML, undefined)).toBe("draft");
    expect(stateFromFiles(HTML, approvalText(HTML))).toBe("approved");
  });

  it("is stale when index.html changed after it was approved", () => {
    expect(stateFromFiles(HTML + "<!-- edited -->", approvalText(HTML))).toBe("stale");
  });

  it("an unreadable approval approves nothing", () => {
    expect(stateFromFiles(HTML, "not json")).toBe("draft");
    expect(stateFromFiles(HTML, "{}")).toBe("stale");
  });

  it("ignores line endings, so git's autocrlf can't make an approved file look changed", () => {
    expect(stateFromFiles(HTML.replace(/\n/g, "\r\n"), approvalText(HTML))).toBe("approved");
  });
});

describe("decideGate", () => {
  const l = prototypeLayout(makeConfig(""), "pdf");
  const gate = (committed: Parameters<typeof decideGate>[2], local: Parameters<typeof decideGate>[3] = "none") =>
    decideGate("pdf", l, committed, local, "main");

  it("builds against an approved, committed prototype", () => {
    expect(gate("approved")).toEqual({ proceed: true, prototypeDir: "docs/prototypes/pdf" });
  });

  it("builds normally when there is no prototype anywhere", () => {
    expect(gate("none", "none")).toEqual({ proceed: true });
  });

  it("waits for approval of a draft, and says how to give it", () => {
    const g = gate("draft");
    expect(g).toMatchObject({ proceed: false });
    expect((g as { reason: string }).reason).toMatch(/not approved yet.*foreman approve pdf.*commit and push/s);
  });

  it("makes a changed-after-approval prototype be approved again", () => {
    expect((gate("stale") as { reason: string }).reason).toMatch(/changed after it was approved.*foreman approve pdf/s);
  });

  it("refuses to silently skip a prototype that exists only in the user's checkout", () => {
    for (const local of ["draft", "approved", "stale"] as const) {
      const g = gate("none", local);
      expect(g).toMatchObject({ proceed: false });
      expect((g as { reason: string }).reason).toMatch(/in your checkout but not on main/);
    }
  });
});

describe("lockdownHtml", () => {
  it("puts a policy at the top of <head> that forbids every network request", () => {
    const out = lockdownHtml(HTML);
    expect(out).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    expect(out).toContain("default-src 'none'");
    expect(out).not.toMatch(/connect-src|script-src [^;]*https?:/);
    expect(out).toContain("<button>Go</button>");
  });

  it("is idempotent", () => {
    const once = lockdownHtml(HTML);
    expect(lockdownHtml(once)).toBe(once);
  });

  it("handles a document with no <head> and a bare fragment", () => {
    expect(lockdownHtml("<html><body>hi</body></html>")).toMatch(/<html>\s*<head><meta http-equiv="Content-Security-Policy"[^>]*><\/head><body>hi/);
    const frag = lockdownHtml("<div>hi</div>");
    expect(frag).toMatch(/^<!doctype html>/);
    expect(frag).toContain("Content-Security-Policy");
    expect(frag).toContain("<div>hi</div>");
  });

  it("keeps ours even when the agent added a looser policy of its own", () => {
    const loose = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>`;
    const out = lockdownHtml(loose);
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("default-src *"); // both are enforced; the browser applies the stricter of the two
  });
});

describe("externalReferences", () => {
  it("finds scripts, styles, images, css urls, imports and network calls", () => {
    const refs = externalReferences(`
      <script src="https://cdn.example.com/lib.js"></script>
      <link rel="stylesheet" href="//fonts.googleapis.com/css?family=Inter">
      <img src="https://images.example.com/a.png">
      <style>@import url("https://x.test/a.css"); body { background: url(https://x.test/bg.png) }</style>
      <script>fetch('/api'); new XMLHttpRequest(); </script>`);
    expect(refs).toEqual(
      expect.arrayContaining([
        "https://cdn.example.com/lib.js",
        "//fonts.googleapis.com/css?family=Inter",
        "https://images.example.com/a.png",
        "https://x.test/a.css",
        "https://x.test/bg.png",
        "script uses fetch",
        "script uses XMLHttpRequest",
      ]),
    );
  });

  it("ignores plain links, relative paths, data URIs and inline code", () => {
    expect(
      externalReferences(`<a href="https://example.com/docs">docs</a><img src="data:image/png;base64,AAAA"><a href="#top">top</a><script>const x = 1;</script>`),
    ).toEqual([]);
  });
});

describe("writePrototype and approvePrototype", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "foreman-proto-"));
    await mkdir(path.join(dir, "docs/stories"), { recursive: true });
    await writeFile(path.join(dir, "docs/stories/pdf.md"), "# Export reports as PDF\n\nUsers export.\n\n## Acceptance criteria\n- A button\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const result = (over: Partial<AgentResult> = {}): AgentResult => ({
    ok: true, text: "", costUsd: 0.5, turns: 4, subtype: "success", deniedToolCalls: 0, ...over,
  });

  /** A designer that writes `html` into the folder named in its prompt, on the real disk. */
  function fakeDesigner(html: string | undefined, over: Partial<AgentResult> = {}) {
    const calls: AgentCall[] = [];
    const runner: AgentRunner = {
      async run(call) {
        calls.push(call);
        if (html !== undefined) {
          const folder = /Prototype folder: `([^`]+)`/.exec(call.prompt)![1]!;
          await mkdir(path.join(call.cwd, folder), { recursive: true });
          await writeFile(path.join(call.cwd, folder, "index.html"), html);
        }
        return result(over);
      },
    };
    return { runner, calls };
  }

  const req = (agents: AgentRunner, over: Record<string, unknown> = {}) => ({
    repoDir: dir,
    id: "pdf",
    config: makeConfig(""),
    agents,
    systemPrompt: "you are the designer",
    isProtected: () => false,
    maxBudgetUsd: 5,
    ...over,
  });

  const index = () => readFile(path.join(dir, "docs/prototypes/pdf/index.html"), "utf8");

  it("runs one designer call scoped to the prototype folder, then locks the page down", async () => {
    const { runner, calls } = fakeDesigner(`<html><head></head><body><script src="https://cdn.x/y.js"></script></body></html>`);
    const r = await writePrototype(req(runner));

    expect(r).toMatchObject({ id: "pdf", revised: false, costUsd: 0.5 });
    expect(r.layout.index).toBe("docs/prototypes/pdf/index.html");
    expect(r.externalRefs).toEqual(["https://cdn.x/y.js"]);
    expect(await index()).toContain("Content-Security-Policy");
    expect(await localPrototypeState(dir, makeConfig(""), "pdf")).toBe("draft");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      role: "designer",
      model: "opus",
      cwd: dir,
      readOnly: false,
      allowBash: false,
      allowedCommands: [],
      writeScope: ["docs/prototypes/pdf"],
    });
    expect(calls[0]!.prompt).toContain("Export reports as PDF");
    expect(calls[0]!.prompt).toContain("This is a new prototype");
    expect(calls[0]!.prompt).toContain("study the project's existing UI");
    expect(calls[0]!.systemPrompt).toBe("you are the designer");
  });

  it("points the designer at the design brief when one is configured", async () => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs/design.md"), "# Brand\nPrimary #0a7\n");
    const { runner, calls } = fakeDesigner(HTML);
    await writePrototype(req(runner, { config: makeConfig("prototype: { designBrief: docs/design.md }") }));
    expect(calls[0]!.prompt).toContain("read `docs/design.md` first");
  });

  it("rejects a design brief that is missing or outside the repo, without calling the agent", async () => {
    const { runner, calls } = fakeDesigner(HTML);
    await expect(writePrototype(req(runner, { config: makeConfig("prototype: { designBrief: docs/nope.md }") }))).rejects.toThrow(/designBrief/);
    await expect(writePrototype(req(runner, { config: makeConfig("prototype: { designBrief: ../outside.md }") }))).rejects.toThrow(/designBrief/);
    expect(calls).toHaveLength(0);
  });

  it("needs a story first", async () => {
    await rm(path.join(dir, "docs/stories/pdf.md"));
    const { runner, calls } = fakeDesigner(HTML);
    await expect(writePrototype(req(runner))).rejects.toThrow(/no story at docs\/stories\/pdf\.md.*foreman story/s);
    expect(calls).toHaveLength(0);
  });

  it("rejects a bad id and a prototype.dir outside the repo", async () => {
    const { runner, calls } = fakeDesigner(HTML);
    await expect(writePrototype(req(runner, { id: "../evil" }))).rejects.toThrow(/not a usable story id/);
    await expect(writePrototype(req(runner, { config: makeConfig("prototype: { dir: ../outside }") }))).rejects.toThrow(/inside the repository/);
    expect(calls).toHaveLength(0);
  });

  it("will not start over an existing prototype, or revise one that doesn't exist", async () => {
    const first = fakeDesigner(HTML);
    await writePrototype(req(first.runner));
    const again = fakeDesigner(HTML);
    await expect(writePrototype(req(again.runner))).rejects.toThrow(/already exists \(draft\).*--feedback.*foreman approve pdf/s);
    expect(again.calls).toHaveLength(0);

    await rm(path.join(dir, "docs/prototypes"), { recursive: true });
    await expect(writePrototype(req(again.runner, { feedback: "bigger" }))).rejects.toThrow(/no prototype for pdf to revise/);
    expect(again.calls).toHaveLength(0);
  });

  it("a revision sends the feedback, is locked down again, and withdraws the approval", async () => {
    await writePrototype(req(fakeDesigner(HTML).runner));
    await approvePrototype(dir, makeConfig(""), "pdf");
    expect(await localPrototypeState(dir, makeConfig(""), "pdf")).toBe("approved");

    const { runner, calls } = fakeDesigner("<html><head></head><body>v2</body></html>");
    const r = await writePrototype(req(runner, { feedback: "make the table denser" }));
    expect(r.revised).toBe(true);
    expect(calls[0]!.prompt).toContain("make the table denser");
    expect(calls[0]!.prompt).toContain("Read `docs/prototypes/pdf/index.html` first");
    expect(await index()).toContain("Content-Security-Policy");
    expect(await localPrototypeState(dir, makeConfig(""), "pdf")).toBe("draft");
    await expect(readFile(path.join(dir, "docs/prototypes/pdf/approval.json"))).rejects.toThrow();
  });

  it("reports a designer that wrote nothing, a usage limit and an API failure, each with its cost", async () => {
    const none = await writePrototype(req(fakeDesigner(undefined, { subtype: "error_max_turns", costUsd: 0.7 }).runner)).catch((e) => e);
    expect(none).toBeInstanceOf(PrototypeError);
    expect(none.message).toMatch(/did not write docs\/prototypes\/pdf\/index\.html/);
    expect(none.costUsd).toBe(0.7);

    const limited = await writePrototype(req(fakeDesigner(undefined, { ok: false, subtype: "rate_limited", costUsd: 0 }).runner)).catch((e) => e);
    expect(limited.message).toMatch(/usage limit/);

    const failed = await writePrototype(req(fakeDesigner(undefined, { ok: false, subtype: "exception", error: "boom", costUsd: 0.02 }).runner)).catch((e) => e);
    expect(failed.message).toMatch(/failed: boom/);
    expect(failed.costUsd).toBe(0.02);
  });

  it("approval records this exact file, and any later edit makes it stale", async () => {
    await expect(approvePrototype(dir, makeConfig(""), "pdf")).rejects.toThrow(/no prototype for pdf.*foreman prototype pdf/s);

    await writePrototype(req(fakeDesigner(HTML).runner));
    const first = await approvePrototype(dir, makeConfig(""), "pdf");
    expect(first.alreadyApproved).toBe(false);
    expect(await localPrototypeState(dir, makeConfig(""), "pdf")).toBe("approved");
    expect((await approvePrototype(dir, makeConfig(""), "pdf")).alreadyApproved).toBe(true);

    await writeFile(path.join(dir, "docs/prototypes/pdf/index.html"), (await index()) + "<!-- hand edit -->");
    expect(await localPrototypeState(dir, makeConfig(""), "pdf")).toBe("stale");
    expect((await approvePrototype(dir, makeConfig(""), "pdf")).alreadyApproved).toBe(false);
    expect(await localPrototypeState(dir, makeConfig(""), "pdf")).toBe("approved");
  });
});

describe("approval markers are protected from every agent", () => {
  it("denies writes to approval.json but not to the prototype itself", () => {
    const isProtected = makeProtectedMatcher(makeConfig(""));
    expect(isProtected("docs/prototypes/pdf/approval.json")).toBe(true);
    expect(isProtected("docs/prototypes/pdf/index.html")).toBe(false);
    expect(isProtected("docs/stories/pdf.md")).toBe(false);
  });

  it("follows a custom prototype.dir", () => {
    const isProtected = makeProtectedMatcher(makeConfig("prototype: { dir: ui/protos/ }"));
    expect(isProtected("ui/protos/x/approval.json")).toBe(true);
    expect(isProtected("docs/prototypes/x/approval.json")).toBe(false);
  });
});
