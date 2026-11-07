import { Octokit } from "@octokit/rest";
import { BRANCH_PREFIX, BranchSafetyError } from "./git.js";
import { logTail, withRetry, type CiRef, type CiState, type CiStatus, type CreatePrInput, type PullRequestRef, type RepoHost } from "./host.js";
import { taskFromIssue, type IssueLike, type Task } from "./tasks.js";

export { withRetry } from "./host.js";
export type { CiState, CiStatus, CreatePrInput, PullRequestRef } from "./host.js";

export class OctokitGitHub implements RepoHost {
  readonly kind = "github" as const;
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

  issueRef(number: number): string {
    return `Closes #${number}`;
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
    if (input.labels.length) await this.addPrLabels(data.number, input.labels);
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

  async addPrLabels(number: number, labels: string[]): Promise<void> {
    await this.addLabels(number, labels);
  }

  async addIssueLabels(number: number, labels: string[]): Promise<void> {
    await this.addLabels(number, labels);
  }

  private async addLabels(number: number, labels: string[]): Promise<void> {
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

  async commentPr(number: number, body: string): Promise<void> {
    await this.comment(number, body);
  }

  async commentIssue(number: number, body: string): Promise<void> {
    await this.comment(number, body);
  }

  private async comment(number: number, body: string): Promise<void> {
    await withRetry(() =>
      this.gh.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: number, body }),
    );
  }

  async listTaskIssues(label: string): Promise<Task[]> {
    return (await this.listLabeledIssues(label)).map(taskFromIssue);
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
   * Combine check runs and legacy commit statuses for the commit. On failure,
   * collect failing check names, their output summaries and the tail of
   * failed GitHub Actions job logs.
   */
  async ciStatus(ref: CiRef): Promise<CiStatus> {
    const sha = ref.sha;
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
  private async jobLogTail(jobId: number): Promise<string | undefined> {
    try {
      const res = await this.gh.actions.downloadJobLogsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        job_id: jobId,
      });
      return logTail(typeof res.data === "string" ? res.data : String(res.data));
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
