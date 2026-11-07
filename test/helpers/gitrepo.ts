import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "../../src/exec.js";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await execFile("git", args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

/**
 * A bare "remote" plus a clone with one commit on `main`.
 * Returns paths and a cleanup function.
 */
export async function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "foreman-git-"));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-q", "-b", "main");
  await git(root, "clone", "-q", remote, work);
  await git(work, "config", "user.name", "Test");
  await git(work, "config", "user.email", "test@example.com");
  await git(work, "config", "core.autocrlf", "false");
  await git(work, "checkout", "-q", "-b", "main");
  for (const [p, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, p)), { recursive: true });
    await writeFile(path.join(work, p), c);
  }
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "init");
  await git(work, "push", "-q", "origin", "main");
  await git(work, "fetch", "-q", "origin");
  return {
    root,
    remote,
    work,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 5 }),
  };
}
