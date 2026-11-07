import type { Task } from "./tasks.js";

/**
 * A git hosting service foreman opens pull requests on (GitHub or Azure
 * DevOps). The runner talks to it only through this interface. It
 * deliberately has no merge capability.
 */
export type HostKind = "github" | "azure-devops";

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
  /** Issue / work item this PR resolves (linked natively where the host supports it). */
  issueNumber?: number;
}

export type CiState = "pending" | "success" | "failure" | "none";

export interface CiStatus {
  state: CiState;
  /** Human-readable summary of failing checks plus log tails, for feeding back to the coder. */
  details: string;
}

export interface CiRef {
  sha: string;
  branch: string;
  prNumber?: number;
}

export interface RepoHost {
  readonly kind: HostKind;
  /** Most recent PR (any state) whose source branch is `branch`, if any. */
  findPrForBranch(branch: string): Promise<PullRequestRef | undefined>;
  createPr(input: CreatePrInput): Promise<PullRequestRef>;
  updatePr(number: number, patch: { body?: string; title?: string }): Promise<void>;
  addPrLabels(number: number, labels: string[]): Promise<void>;
  commentPr(number: number, body: string): Promise<void>;
  /** Open issues / work items labeled (tagged) for foreman, as tasks. */
  listTaskIssues(label: string): Promise<Task[]>;
  commentIssue(number: number, body: string): Promise<void>;
  addIssueLabels(number: number, labels: string[]): Promise<void>;
  ciStatus(ref: CiRef): Promise<CiStatus>;
  /** Text for a PR body that references the issue / work item. */
  issueRef(number: number): string;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP-ish error shape used by both Octokit and our fetch client. */
export interface HttpErrorLike {
  status?: number;
  response?: { headers?: Record<string, string> };
  code?: string;
}

/** Retry transient failures (5xx, 429, secondary rate limits, network). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? sleepReal;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as HttpErrorLike;
      const status = err.status ?? 0;
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const rateLimited =
        status === 429 ||
        (status === 403 && err.response?.headers?.["x-ratelimit-remaining"] === "0") ||
        (status === 403 && /secondary rate limit/i.test(String((e as Error).message)));
      const transient =
        status >= 500 ||
        rateLimited ||
        ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(err.code ?? "");
      if (!transient || attempt >= retries) throw e;
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt;
      await sleep(Math.min(delay, 5 * 60_000));
    }
  }
}

/** Keep the last `lines` lines of a log. */
export function logTail(text: string, lines = 120): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(-lines)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, ""))
    .join("\n");
}
