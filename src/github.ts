import { Octokit } from "@octokit/rest";
import { BRANCH_PREFIX, BranchSafetyError } from "./git.js";
import type { IssueLike } from "./tasks.js";

export interface PullRequestRef {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  head: string;
}

export interface CreatePrInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
}

export type CiState = "pending" | "success" | "failure" | "none";

export interface CiStatus {
  state: CiState;
  /** Human-readable summary of failing checks plus log tails, for feeding back to the coder. */
  details: string;
}

/** Everything the runner needs from GitHub. Mocked in tests. */
export interface GitHubApi {
  /** Most recent PR (any state) whose head is `branch`, if any. */
  findPrForBranch(branch: string): Promise<PullRequestRef | undefined>;
  createPr(input: CreatePrInput): Promise<PullRequestRef>;
  updatePr(number: number, patch: { body?: string; title?: string }): Promise<void>;
  addLabels(number: number, labels: string[]): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  listLabeledIssues(label: string): Promise<IssueLike[]>;
  ciStatus(sha: string): Promise<CiStatus>;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry transient GitHub failures (5xx, 429, secondary rate limits, network). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? sleepReal;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { status?: number; response?: { headers?: Record<string, string> }; code?: string };
      const status = err.status ?? 0;
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const rateLimited =
        status === 429 ||
        (status === 403 && err.response?.headers?.["x-ratelimit-remaining"] === "0") ||
        (status === 403 && /secondary rate limit/i.test(String((e as Error).message)));
      const transient =
        status >= 500 || rateLimited || ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(err.code ?? "");
      if (!transient || attempt >= retries) throw e;
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt;
      await sleep(Math.min(delay, 5 * 60_000));
    }
  }
}

export class OctokitGitHub implements GitHubApi {
  private readonly gh: Octokit;

  constructor(
    readonly owner: string,
    readonly repo: string,
    token: string,
    private readonly baseBranch: string,
    octokit?: Octokit,
  ) {
    this.gh = octokit ?? new Octokit({ auth: token, userAgent: "claude-foreman" });
  }

  async findPrForBranch(branch: string): Promise<PullRequestRef | undefined> {
    const { data } = await withRetry(() =>
      this.gh.pulls.list({
        owner: this.owner,
        repo: this.repo,
        head: `${this.owner}:${branch}`,
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: 5,
      }),
    );
    const pr = data[0];
    if (!pr) return undefined;
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.state as "open" | "closed",
      merged: Boolean(pr.merged_at),
      draft: Boolean(pr.draft),
      head: pr.head.ref,
    };
  }

  async createPr(input: CreatePrInput): Promise<PullRequestRef> {
    if (!input.head.startsWith(BRANCH_PREFIX) || input.head === this.baseBranch) {
      throw new BranchSafetyError(`Refusing to open a PR from ${input.head}`);
    }
    const { data } = await withRetry(() =>
      this.gh.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        draft: input.draft,
        maintainer_can_modify: true,
      }),
    );
    if (input.labels.length) await this.addLabels(data.number, input.labels);
    return {
      number: data.number,
      url: data.html_url,
      state: "open",
      merged: false,
      draft: Boolean(data.draft),
      head: input.head,
    };
  }

  async updatePr(number: number, patch: { body?: string; title?: string }): Promise<void> {
    await withRetry(() =>
      this.gh.pulls.update({ owner: this.owner, repo: this.repo, pull_number: number, ...patch }),
    );
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    try {
      await withRetry(() =>
        this.gh.issues.addLabels({ owner: this.owner, repo: this.repo, issue_number: number, labels }),
      );
    } catch (e) {
      // Labels are best-effort (token may lack permission to create labels).
      process.emitWarning(`Could not add labels ${labels.join(", ")} to #${number}: ${(e as Error).message}`);
    }
  }

  async comment(number: number, body: string): Promise<void> {
    await withRetry(() =>
      this.gh.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: number, body }),
    );
  }

  async listLabeledIssues(label: string): Promise<IssueLike[]> {
    const items = await withRetry(() =>
      this.gh.paginate(this.gh.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        labels: label,
        state: "open",
        per_page: 100,
      }),
    );
    return items
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", labels: i.labels }));
  }

  /**
   * Combine check runs and legacy commit statuses for `sha`. On failure,
   * collect failing check names, their output summaries and the tail of
   * failed GitHub Actions job logs.
   */
  async ciStatus(sha: string): Promise<CiStatus> {
    const [runs, combined] = await Promise.all([
      withRetry(() =>
        this.gh.paginate(this.gh.checks.listForRef, { owner: this.owner, repo: this.repo, ref: sha, per_page: 100 }),
      ),
      withRetry(() => this.gh.repos.getCombinedStatusForRef({ owner: this.owner, repo: this.repo, ref: sha })),
    ]);
    const checkRuns = runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      summary: r.output?.summary ?? "",
      text: r.output?.text ?? "",
    }));
    const statuses = combined.data.statuses.map((s) => ({ context: s.context, state: s.state, description: s.description }));
    const state = summarizeCi(checkRuns, statuses);
    if (state !== "failure") return { state, details: "" };

    const failedRuns = checkRuns.filter((r) => isFailingConclusion(r.conclusion));
    const parts: string[] = [];
    for (const r of failedRuns.slice(0, 5)) {
      parts.push(`### ${r.name} (${r.conclusion})`);
      if (r.summary) parts.push(r.summary.slice(0, 2000));
      if (r.text) parts.push(r.text.slice(0, 2000));
      const log = await this.jobLogTail(r.id);
      if (log) parts.push("```\n" + log + "\n```");
    }
    for (const s of statuses.filter((s) => s.state === "failure" || s.state === "error")) {
      parts.push(`### ${s.context} (${s.state})\n${s.description ?? ""}`);
    }
    return { state, details: parts.join("\n\n") };
  }

  /** Check-run ids for GitHub Actions jobs equal job ids; fetch the log tail if available. */
  private async jobLogTail(jobId: number, lines = 120): Promise<string | undefined> {
    try {
      const res = await this.gh.actions.downloadJobLogsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        job_id: jobId,
      });
      const text = typeof res.data === "string" ? res.data : String(res.data);
      const all = text.replace(/\r\n/g, "\n").split("\n");
      // strip the timestamp prefix GitHub adds to every line
      return all
        .slice(-lines)
        .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, ""))
        .join("\n");
    } catch {
      return undefined; // not an Actions job, or logs expired
    }
  }
}

function isFailingConclusion(c: string | null | undefined): boolean {
  return c === "failure" || c === "timed_out" || c === "cancelled" || c === "action_required" || c === "startup_failure";
}

export function summarizeCi(
  runs: Array<{ status: string | null; conclusion: string | null | undefined }>,
  statuses: Array<{ state: string }>,
): CiState {
  if (runs.length === 0 && statuses.length === 0) return "none";
  if (runs.some((r) => isFailingConclusion(r.conclusion)) || statuses.some((s) => s.state === "failure" || s.state === "error")) {
    return "failure";
  }
  if (runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending")) return "pending";
  return "success";
}
