import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFile, type ExecResult } from "./exec.js";

export const BRANCH_PREFIX = "foreman/";

export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    readonly result?: ExecResult,
  ) {
    super(message);
  }
}

/** Raised when an operation would violate a branch safety rule. Never retried. */
export class BranchSafetyError extends Error {
  override name = "BranchSafetyError";
}

export interface ChangedFile {
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U";
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export const FOREMAN_AUTHOR: CommitAuthor = {
  name: "foreman[bot]",
  email: "foreman-bot@users.noreply.github.com",
};

export function branchFor(taskId: string): string {
  return `${BRANCH_PREFIX}${taskId}`;
}

/**
 * Parse owner/repo from a GitHub remote URL (https, ssh, or scp-like).
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const m = url
    .trim()
    .match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : undefined;
}

/**
 * Thin git wrapper. Every command runs via execFile (no shell). Hooks are
 * disabled for every invocation so code written by the agent (e.g. a planted
 * hook) never runs with the runner's credentials.
 */
export class Git {
  constructor(
    readonly repoDir: string,
    readonly remote: string,
    readonly baseBranch: string,
    private readonly opts: { auth?: GitHttpAuth; env?: NodeJS.ProcessEnv } = {},
  ) {
    assertSafeRefName(baseBranch);
  }

  async run(
    args: string[],
    cwd = this.repoDir,
    extraConfig: string[] = [],
    input?: string,
  ): Promise<ExecResult> {
    const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null";
    const full = ["-c", `core.hooksPath=${nullHooks}`, "-c", "core.quotePath=false", ...extraConfig, ...args];
    return execFile("git", full, {
      cwd,
      env: { ...(this.opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 10 * 60_000,
      ...(input !== undefined ? { input } : {}),
    });
  }

  async must(args: string[], cwd = this.repoDir, extraConfig: string[] = []): Promise<string> {
    const res = await this.run(args, cwd, extraConfig);
    if (res.code !== 0) {
      throw new GitError(`git ${args.join(" ")} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`, res);
    }
    return res.stdout;
  }

  async remoteUrl(): Promise<string> {
    return (await this.must(["remote", "get-url", this.remote])).trim();
  }

  async fetch(): Promise<void> {
    await this.must(["fetch", "--prune", this.remote], this.repoDir, this.authConfig());
  }

  remoteRef(branch: string): string {
    return `refs/remotes/${this.remote}/${branch}`;
  }

  async refExists(ref: string, cwd = this.repoDir): Promise<boolean> {
    return (await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)).code === 0;
  }

  worktreePath(taskId: string): string {
    return path.join(this.repoDir, ".foreman", "worktrees", taskId);
  }

  /**
   * Create a fresh worktree for the task on branch foreman/<id>. If the remote
   * already has that branch (a previous run pushed it) we continue from it and
   * merge the base in, so the later push is a fast-forward and never needs force.
   */
  async createWorktree(taskId: string): Promise<{ dir: string; branch: string; baseSha: string }> {
    const branch = branchFor(taskId);
    this.assertPushable(branch);
    const dir = this.worktreePath(taskId);
    await this.removeWorktree(taskId);
    await mkdir(path.dirname(dir), { recursive: true });

    const baseRef = this.remoteRef(this.baseBranch);
    if (!(await this.refExists(baseRef))) {
      throw new GitError(`Base branch ${this.remote}/${this.baseBranch} not found. Did fetch succeed?`);
    }
    const remoteBranch = this.remoteRef(branch);
    const continuing = await this.refExists(remoteBranch);
    await this.must(["worktree", "add", "--force", "-B", branch, dir, continuing ? remoteBranch : baseRef]);
    if (continuing) {
      const merge = await this.run(
        ["-c", `user.name=${FOREMAN_AUTHOR.name}`, "-c", `user.email=${FOREMAN_AUTHOR.email}`,
          "merge", "--no-edit", "--no-verify", baseRef],
        dir,
      );
      if (merge.code !== 0) {
        await this.run(["merge", "--abort"], dir);
        throw new GitError(
          `Remote branch ${branch} exists and cannot be merged cleanly with ${this.baseBranch}. ` +
            `Delete the remote branch or rename the task.`,
          merge,
        );
      }
    }
    const baseSha = (await this.must(["merge-base", "HEAD", baseRef], dir)).trim();
    return { dir, branch, baseSha };
  }

  async removeWorktree(taskId: string): Promise<void> {
    const dir = this.worktreePath(taskId);
    await this.run(["worktree", "remove", "--force", dir]);
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    await this.run(["worktree", "prune"]);
  }

  /** Undo changes to specific paths (used to revert protected-path edits before retrying). */
  async restorePaths(dir: string, sinceRef: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.run(["reset", "-q", "--", ...paths], dir);
    // restore tracked files from sinceRef; remove files that did not exist there
    for (const p of paths) {
      const existed = (await this.run(["cat-file", "-e", `${sinceRef}:${p}`], dir)).code === 0;
      if (existed) await this.must(["checkout", sinceRef, "--", p], dir);
      else await rm(path.join(dir, p), { force: true, recursive: true });
    }
  }

  /** Stage everything and list changes relative to `sinceRef` (default: the merge-base with base). */
  async stagedChanges(dir: string, sinceRef: string): Promise<ChangedFile[]> {
    await this.must(["add", "-A", "--", "."], dir);
    const out = await this.must(["diff", "--cached", "-M", "--name-status", "-z", sinceRef], dir);
    return parseNameStatusZ(out);
  }

  /** Unified diff (zero context) of staged changes vs `sinceRef`. */
  async stagedDiff(dir: string, sinceRef: string, context = 0): Promise<string> {
    return this.must(["diff", "--cached", "-M", "--no-color", "--no-ext-diff", `-U${context}`, sinceRef], dir);
  }

  async diffStat(dir: string, sinceRef: string): Promise<string> {
    return this.must(["diff", "--cached", "--stat", "--no-color", sinceRef], dir);
  }

  async hasStagedChanges(dir: string): Promise<boolean> {
    return (await this.run(["diff", "--cached", "--quiet"], dir)).code === 1;
  }

  /** Commit staged changes as the foreman bot; message is passed on stdin. Returns the new sha. */
  async commit(dir: string, message: string, author: CommitAuthor = FOREMAN_AUTHOR): Promise<string> {
    const args = [
      "-c", `user.name=${author.name}`,
      "-c", `user.email=${author.email}`,
      "commit", "--no-verify", "--no-gpg-sign", "-F", "-",
    ];
    const res = await this.run(args, dir, [], message);
    if (res.code !== 0) {
      throw new GitError(`git commit failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`, res);
    }
    return this.headSha(dir);
  }

  async readFileAt(dir: string, ref: string, file: string): Promise<string | undefined> {
    const res = await this.run(["show", `${ref}:${file}`], dir);
    return res.code === 0 ? res.stdout : undefined;
  }

  async readWorkingFile(dir: string, file: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(dir, file), "utf8");
    } catch {
      return undefined;
    }
  }

  async commitsAhead(dir: string, baseSha: string): Promise<number> {
    return Number((await this.must(["rev-list", "--count", `${baseSha}..HEAD`], dir)).trim());
  }

  async headSha(dir: string): Promise<string> {
    return (await this.must(["rev-parse", "HEAD"], dir)).trim();
  }

  /**
   * Push the task branch. Hard rules enforced here, not in prompts:
   *  - only `foreman/*` branches, never the base branch
   *  - explicit refspec, never `--force` / `+refspec` / `--mirror` / `--delete`
   */
  async push(dir: string, branch: string): Promise<void> {
    this.assertPushable(branch);
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const args = ["push", "--no-verify", "--porcelain", this.remote, refspec];
    assertNoForce(args);
    await this.must(args, dir, this.authConfig());
  }

  assertPushable(branch: string): void {
    assertSafeRefName(branch);
    if (!branch.startsWith(BRANCH_PREFIX)) {
      throw new BranchSafetyError(`Refusing to push ${branch}: only ${BRANCH_PREFIX}* branches may be pushed`);
    }
    const norm = (b: string) => b.replace(/^refs\/heads\//, "").toLowerCase();
    if (norm(branch) === norm(this.baseBranch) || ["main", "master"].includes(norm(branch))) {
      throw new BranchSafetyError(`Refusing to push to base branch ${branch}`);
    }
  }

  /** Auth for fetch/push only, via an http header the agent process never sees. */
  private authConfig(): string[] {
    const auth = this.opts.auth;
    if (!auth) return [];
    return ["-c", `http.${auth.urlPrefix}.extraheader=AUTHORIZATION: ${auth.header}`];
  }
}

/** HTTP auth for git fetch/push against a host: URL prefix the header applies to, and the header value. */
export interface GitHttpAuth {
  urlPrefix: string;
  header: string;
}

export function githubGitAuth(token: string): GitHttpAuth {
  return { urlPrefix: "https://github.com/", header: `basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` };
}

export function assertSafeRefName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..") || name.endsWith(".lock") || name.endsWith("/")) {
    throw new BranchSafetyError(`Unsafe ref name: ${JSON.stringify(name)}`);
  }
}

export function assertNoForce(args: string[]): void {
  for (const a of args) {
    if (/^(-f|--force.*|--mirror|--delete|-d|--prune)$/.test(a) || /^\+/.test(a) || /^:/.test(a)) {
      throw new BranchSafetyError(`Refusing destructive push argument: ${a}`);
    }
  }
}

export function parseNameStatusZ(out: string): ChangedFile[] {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]!;
    const status = code[0] as ChangedFile["status"];
    if (status === "R" || status === "C") {
      const oldPath = parts[i++]!;
      const newPath = parts[i++]!;
      files.push({ status, path: newPath, oldPath });
    } else {
      files.push({ status, path: parts[i++]! });
    }
  }
  return files;
}
