import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAuth, SdkAgentRunner, type AgentRunner } from "./claude.js";
import { ShellCheckRunner } from "./checks.js";
import { loadConfig, type ForemanConfig } from "./config.js";
import { Git, parseGitHubRemote } from "./git.js";
import { OctokitGitHub, type GitHubApi } from "./github.js";
import { TaskRunner, type Logger } from "./loop.js";
import { Orchestrator } from "./orchestrator.js";
import { loadRoles } from "./roles.js";
import { makeProtectedMatcher, SafetyGate } from "./safety.js";
import { StateStore, STATE_DIR } from "./state.js";
import { loadTasks, parseTasks, type Task } from "./tasks.js";

export interface RuntimeOptions {
  repoDir: string;
  dryRun: boolean;
  verbose?: boolean;
  keepWorktrees?: boolean;
  /** Read tasks.yaml from the remote base branch instead of the working tree. */
  tasksFromRemote?: boolean;
  /** Injected for tests. */
  agents?: AgentRunner;
  github?: GitHubApi;
}

export function githubToken(env = process.env): string | undefined {
  return env.FOREMAN_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

export function makeLogger(file: string | undefined, verbose = false): Logger {
  if (file) mkdirSync(path.dirname(file), { recursive: true });
  const write = (level: string, msg: string, toConsole: boolean) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
    if (toConsole) (level === "ERROR" || level === "WARN" ? console.error : console.log)(line);
    if (file) {
      try {
        appendFileSync(file, line + "\n");
      } catch {
        /* logging must never crash the runner */
      }
    }
  };
  return {
    info: (m) => write("INFO", m, true),
    warn: (m) => write("WARN", m, true),
    error: (m) => write("ERROR", m, true),
    debug: (m) => write("DEBUG", m, verbose),
  };
}

/** Make sure `.foreman/` never shows up as untracked in the user's checkout. */
export async function ensureLocalExclude(repoDir: string, git: Git): Promise<void> {
  try {
    const gitDir = (await git.must(["rev-parse", "--git-common-dir"], repoDir)).trim();
    const exclude = path.resolve(repoDir, gitDir, "info", "exclude");
    let text = "";
    try {
      text = await readFile(exclude, "utf8");
    } catch {
      /* missing */
    }
    if (!/^\/?\.foreman\/?$/m.test(text)) {
      mkdirSync(path.dirname(exclude), { recursive: true });
      await writeFile(exclude, `${text.replace(/\n?$/, "\n")}/.foreman/\n`);
    }
  } catch {
    /* not fatal */
  }
}

export interface Runtime {
  config: ForemanConfig;
  state: StateStore;
  git: Git;
  github?: GitHubApi;
  log: Logger;
  orchestrator: Orchestrator;
  stateDir: string;
}

export async function createRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const repoDir = path.resolve(opts.repoDir);
  const config = await loadConfig(repoDir);
  const stateDir = path.join(repoDir, STATE_DIR);
  const log = makeLogger(path.join(stateDir, "logs", "foreman.log"), opts.verbose);
  const state = await StateStore.open(stateDir, { dayBoundary: config.dayBoundary });

  const token = githubToken();
  const git = new Git(repoDir, config.remote, config.baseBranch, token ? { token } : {});
  await ensureLocalExclude(repoDir, git);

  let github = opts.github;
  if (!github) {
    let owner: string | undefined;
    let repo: string | undefined;
    if (config.repo) [owner, repo] = config.repo.split("/");
    else {
      const parsed = parseGitHubRemote(await git.remoteUrl().catch(() => ""));
      owner = parsed?.owner;
      repo = parsed?.repo;
    }
    if (token && owner && repo) {
      github = new OctokitGitHub(owner, repo, token, config.baseBranch);
    } else if (!opts.dryRun) {
      throw new Error(
        !token
          ? "No GitHub token. Set GITHUB_TOKEN (or FOREMAN_GITHUB_TOKEN), or use `foreman dry-run`."
          : "Could not determine the GitHub repository. Set `repo: owner/name` in foreman.config.yaml.",
      );
    }
  }

  const auth = resolveAuth(config.agent.auth);
  log.info(`Claude auth: ${auth.description}`);
  if (auth.kind === "claude-login") {
    log.warn("No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set; relying on a stored `claude login`. Run `claude setup-token` for unattended use.");
  }

  const roles = await loadRoles();
  const isProtected = makeProtectedMatcher(config);
  const agents =
    opts.agents ??
    new SdkAgentRunner({ envPassthrough: config.agent.envPassthrough, sandbox: config.agent.sandbox, auth });
  const checks = new ShellCheckRunner(config.checks, config.limits.checkTimeoutMinutes, config.agent.envPassthrough);
  const gate = new SafetyGate(isProtected);
  const tasksPath = path.join(repoDir, config.tasksFile);

  const loadFileTasks = async (): Promise<Task[]> => {
    if (opts.tasksFromRemote) {
      await git.fetch();
      const text = await git.readFileAt(repoDir, `${config.remote}/${config.baseBranch}`, config.tasksFile.replace(/\\/g, "/"));
      return text ? parseTasks(text, `${config.remote}/${config.baseBranch}:${config.tasksFile}`) : [];
    }
    return loadTasks(tasksPath);
  };

  const orchestrator = new Orchestrator({
    config,
    state,
    ...(github ? { github } : {}),
    log,
    dryRun: opts.dryRun,
    reportsDir: path.join(stateDir, "reports"),
    loadFileTasks,
    makeExecutor: (runId) =>
      new TaskRunner({
        config,
        state,
        git,
        ...(github ? { github } : {}),
        agents,
        checks,
        gate,
        roles,
        isProtected,
        runId,
        dryRun: opts.dryRun,
        log,
        keepWorktrees: opts.keepWorktrees ?? false,
        taskLog: (taskId) => {
          const file = path.join(stateDir, "logs", runId, `${taskId}.log`);
          mkdirSync(path.dirname(file), { recursive: true });
          return (line) => {
            try {
              appendFileSync(file, line + "\n");
            } catch {
              /* ignore */
            }
            log.debug(`[${taskId}] ${line.split("\n")[0]}`);
          };
        },
      }),
  });

  return { config, state, git, ...(github ? { github } : {}), log, orchestrator, stateDir };
}
