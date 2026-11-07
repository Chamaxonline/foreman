import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoForce,
  BranchSafetyError,
  Git,
  parseGitHubRemote,
  parseNameStatusZ,
} from "../src/git.js";
import { git, makeRepo } from "./helpers/gitrepo.js";

let repo: Awaited<ReturnType<typeof makeRepo>>;
let g: Git;

beforeEach(async () => {
  repo = await makeRepo({ "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" });
  g = new Git(repo.work, "origin", "main");
});
afterEach(async () => {
  await repo.cleanup();
});

describe("Git worktrees, commits and pushes", () => {
  it("creates a worktree on foreman/<id>, commits as the bot and pushes", async () => {
    await g.fetch();
    const wt = await g.createWorktree("t1");
    expect(wt.branch).toBe("foreman/t1");
    expect(wt.dir).toBe(path.join(repo.work, ".foreman", "worktrees", "t1"));

    await writeFile(path.join(wt.dir, "src/a.ts"), "export const a = 2;\n");
    await writeFile(path.join(wt.dir, "src/b.ts"), "export const b = 1;\n");
    await unlink(path.join(wt.dir, "README.md"));

    const changes = await g.stagedChanges(wt.dir, wt.baseSha);
    expect(changes).toEqual(
      expect.arrayContaining([
        { status: "M", path: "src/a.ts" },
        { status: "A", path: "src/b.ts" },
        { status: "D", path: "README.md" },
      ]),
    );
    expect(await g.stagedDiff(wt.dir, wt.baseSha)).toContain("+export const a = 2;");

    const sha = await g.commit(wt.dir, "foreman: t1\n\nbody");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(wt.dir, "log", "-1", "--format=%an <%ae>|%s")).trim()).toBe(
      "foreman[bot] <foreman-bot@users.noreply.github.com>|foreman: t1",
    );

    await g.push(wt.dir, wt.branch);
    expect((await git(repo.remote, "rev-parse", "refs/heads/foreman/t1")).trim()).toBe(sha);
    // base branch on the remote is untouched
    expect((await git(repo.remote, "log", "-1", "--format=%s", "main")).trim()).toBe("init");
  });

  it("continues from an existing remote branch so the next push is a fast-forward", async () => {
    await g.fetch();
    let wt = await g.createWorktree("t2");
    await writeFile(path.join(wt.dir, "x.txt"), "1\n");
    await g.stagedChanges(wt.dir, wt.baseSha);
    const first = await g.commit(wt.dir, "first");
    await g.push(wt.dir, wt.branch);

    // base moves on meanwhile
    await writeFile(path.join(repo.work, "README.md"), "hello again\n");
    await git(repo.work, "commit", "-qam", "base moves");
    await git(repo.work, "push", "-q", "origin", "main");

    await g.fetch();
    wt = await g.createWorktree("t2");
    expect(await readFile(path.join(wt.dir, "x.txt"), "utf8")).toBe("1\n");
    expect(await readFile(path.join(wt.dir, "README.md"), "utf8")).toBe("hello again\n");
    await writeFile(path.join(wt.dir, "x.txt"), "2\n");
    await g.stagedChanges(wt.dir, wt.baseSha);
    await g.commit(wt.dir, "second");
    await g.push(wt.dir, wt.branch); // would fail without force if history diverged
    const log = await git(repo.remote, "log", "--format=%s", "foreman/t2");
    expect(log).toContain("first");
    expect(log).toContain("second");
    expect(first).toMatch(/^[0-9a-f]{40}$/);
  });

  it("restorePaths reverts edits and removes new files", async () => {
    await g.fetch();
    const wt = await g.createWorktree("t3");
    await writeFile(path.join(wt.dir, "README.md"), "tampered\n");
    await writeFile(path.join(wt.dir, "new.txt"), "x\n");
    await g.stagedChanges(wt.dir, wt.baseSha);
    await g.restorePaths(wt.dir, wt.baseSha, ["README.md", "new.txt"]);
    expect(await readFile(path.join(wt.dir, "README.md"), "utf8")).toBe("hello\n");
    expect(await g.stagedChanges(wt.dir, wt.baseSha)).toEqual([]);
  });

  it("removeWorktree cleans up", async () => {
    await g.fetch();
    const wt = await g.createWorktree("t4");
    await g.removeWorktree("t4");
    const list = await git(repo.work, "worktree", "list");
    expect(list).not.toContain(wt.dir.replace(/\\/g, "/"));
  });

  it("does not run repository git hooks", async () => {
    await g.fetch();
    const wt = await g.createWorktree("t5");
    const hooksDir = path.join(repo.work, ".git", "hooks");
    await writeFile(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(path.join(wt.dir, "y.txt"), "y\n");
    await g.stagedChanges(wt.dir, wt.baseSha);
    await expect(g.commit(wt.dir, "with hooks")).resolves.toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("branch safety", () => {
  it("never pushes the base branch or non-foreman branches", async () => {
    expect(() => g.assertPushable("main")).toThrow(BranchSafetyError);
    expect(() => g.assertPushable("feature/x")).toThrow(BranchSafetyError);
    expect(() => g.assertPushable("foreman/ok")).not.toThrow();
    const g2 = new Git(repo.work, "origin", "foreman/base");
    expect(() => g2.assertPushable("foreman/base")).toThrow(/base branch/);
    await expect(g.push(repo.work, "main")).rejects.toThrow(BranchSafetyError);
  });

  it("rejects unsafe ref names", () => {
    for (const b of ["foreman/../main", "foreman/x.lock", "-f", "foreman/a b", "foreman/x/"]) {
      expect(() => g.assertPushable(b), b).toThrow(BranchSafetyError);
    }
  });

  it("rejects force-like push arguments", () => {
    for (const a of ["-f", "--force", "--force-with-lease", "+refs/heads/x:refs/heads/x", ":refs/heads/main", "--mirror", "--delete"]) {
      expect(() => assertNoForce(["push", a]), a).toThrow(BranchSafetyError);
    }
    expect(() => assertNoForce(["push", "origin", "refs/heads/foreman/a:refs/heads/foreman/a"])).not.toThrow();
  });
});

describe("parsers", () => {
  it("parseGitHubRemote", () => {
    expect(parseGitHubRemote("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitHubRemote("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitHubRemote("ssh://git@github.com/acme/w.x")).toEqual({ owner: "acme", repo: "w.x" });
    expect(parseGitHubRemote("https://gitlab.com/a/b")).toBeUndefined();
  });

  it("parseNameStatusZ handles renames", () => {
    expect(parseNameStatusZ("M\0a.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R", path: "new.ts", oldPath: "old.ts" },
      { status: "D", path: "gone.ts" },
    ]);
  });
});
