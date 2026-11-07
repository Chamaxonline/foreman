import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAuth, SdkAgentRunner, type AgentRunner, type AuthMode } from "./claude.js";
import { ShellCheckRunner } from "./checks.js";
import { envValue } from "./env.js";
import { loadConfig, type ForemanConfig } from "./config.js";
import { AzureDevOpsHost, azureGitAuth, azureToken, isAzureRemote, parseAzureRemote, type AzureRepoRef } from "./azure.js";
import { Git, githubGitAuth, parseGitHubRemote, type GitHttpAuth } from "./git.js";
import { OctokitGitHub } from "./github.js";
import type { HostKind, RepoHost } from "./host.js";
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
  /** Overrides agent.auth from the config. */
  auth?: AuthMode;
  /** Injected for tests. */
  agents?: AgentRunner;
  host?: RepoHost;
}

export function githubToken(env = process.env): string | undefined {
  return envValue(env, "FOREMAN_GITHUB_TOKEN") ?? envValue(env, "GITHUB_TOKEN") ?? envValue(env, "GH_TOKEN");
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

export interface ResolvedHost {
  kind: HostKind;
  host?: RepoHost;
  gitAuth?: GitHttpAuth;
  description: string;
}

/**
 * Pick GitHub or Azure DevOps (config.provider, else the remote URL), find the
 * repository coordinates and the runner's token. Without a token this only
 * works for dry runs.
 */
export function resolveHost(config: ForemanConfig, remoteUrl: string, env: NodeJS.ProcessEnv, dryRun: boolean): ResolvedHost {
  const kind: HostKind =
    config.provider !== "auto"
      ? config.provider
      : isAzureRemote(remoteUrl) || config.azureDevOps.orgUrl
        ? "azure-devops"
        : "github";

  if (kind === "azure-devops") {
    const parsed = parseAzureRemote(remoteUrl);
    const az = config.azureDevOps;
    const ref = {
      orgUrl: az.orgUrl ?? parsed?.orgUrl,
      project: az.project ?? parsed?.project,
      repository: az.repository ?? parsed?.repository,
    };
    const token = azureToken(env, az.tokenType);
    if (!ref.orgUrl || !ref.project || !ref.repository) {
      if (dryRun) return { kind, description: "Azure DevOps (repository unknown; dry run)" };
      throw new Error(
        "Could not determine the Azure DevOps repository from the remote URL. Set azureDevOps.orgUrl, project and repository in foreman.config.yaml.",
      );
    }
    const full = ref as AzureRepoRef;
    const where = `${full.orgUrl}/${full.project}/_git/${full.repository}`;
    if (!token) {
      if (dryRun) return { kind, description: `Azure DevOps ${where} (no token; dry run)` };
      throw new Error(
        "No Azure DevOps token. Set FOREMAN_AZURE_TOKEN (or AZURE_DEVOPS_EXT_PAT) to a PAT, or SYSTEM_ACCESSTOKEN in Azure Pipelines; or use `foreman dry-run`.",
      );
    }
    return {
      kind,
      host: new AzureDevOpsHost(full, token, config.baseBranch),
      gitAuth: azureGitAuth(full, token),
      description: `Azure DevOps ${where} (token from ${token.source})`,
    };
  }

  const token = githubToken(env);
  let owner: string | undefined;
  let repo: string | undefined;
  if (config.repo) [owner, repo] = config.repo.split("/");
  else ({ owner, repo } = parseGitHubRemote(remoteUrl) ?? {});
  if (token && owner && repo) {
    return {
      kind,
      host: new OctokitGitHub(owner, repo, token, config.baseBranch),
      gitAuth: githubGitAuth(token),
      description: `GitHub ${owner}/${repo}`,
    };
  }
  if (dryRun) return { kind, description: `GitHub ${owner && repo ? `${owner}/${repo}` : "(repository unknown)"} (no token; dry run)` };
  throw new Error(
    !token
      ? "No GitHub token. Set GITHUB_TOKEN (or FOREMAN_GITHUB_TOKEN), or use `foreman dry-run`."
      : "Could not determine the GitHub repository. Set `repo: owner/name` in foreman.config.yaml.",
  );
}

export interface Runtime {
  config: ForemanConfig;
  state: StateStore;
  git: Git;
  host?: RepoHost;
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

  const remoteUrl = await new Git(repoDir, config.remote, config.baseBranch).remoteUrl().catch(() => "");
  // An injected host (tests, embedding) needs no token.
  const resolved = resolveHost(config, remoteUrl, process.env, opts.dryRun || Boolean(opts.host));
  const host = opts.host ?? resolved.host;
  const git = new Git(repoDir, config.remote, config.baseBranch, resolved.gitAuth ? { auth: resolved.gitAuth } : {});
  await ensureLocalExclude(repoDir, git);
  log.info(`Repository host: ${resolved.description}`);

  const auth = resolveAuth(opts.auth ?? config.agent.auth);
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
    ...(host ? { host } : {}),
    log,
    dryRun: opts.dryRun,
    reportsDir: path.join(stateDir, "reports"),
    loadFileTasks,
    makeExecutor: (runId) =>
      new TaskRunner({
        config,
        state,
        git,
        ...(host ? { host } : {}),
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

  return { config, state, git, ...(host ? { host } : {}), log, orchestrator, stateDir };
}
