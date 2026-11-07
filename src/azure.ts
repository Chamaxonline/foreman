import { BRANCH_PREFIX, BranchSafetyError, type GitHttpAuth } from "./git.js";
import { logTail, withRetry, type CiRef, type CiStatus, type CreatePrInput, type PullRequestRef, type RepoHost } from "./host.js";
import { taskFromIssue, type Task } from "./tasks.js";

/**
 * Azure DevOps (Services, and Server via an explicit orgUrl) implementation
 * of RepoHost, using the REST API (api-version 7.1) over fetch.
 *
 * Mapping:
 *   pull requests  → Azure Repos pull requests (labels = PR tags; work items linked natively)
 *   issues         → work items tagged with `issues.label`
 *   CI             → Azure Pipelines builds for the branch or the PR merge ref
 */

const API = "api-version=7.1";
/** Azure Repos rejects PR descriptions longer than 4000 characters. */
export const MAX_PR_DESCRIPTION = 4000;

export interface AzureRepoRef {
  /** https://dev.azure.com/<org>, https://<org>.visualstudio.com, or an Azure DevOps Server collection URL. */
  orgUrl: string;
  project: string;
  repository: string;
}

/** Parse an Azure Repos remote URL (https or ssh, dev.azure.com or *.visualstudio.com). */
export function parseAzureRemote(url: string): AzureRepoRef | undefined {
  const u = url.trim();
  const dec = (s: string) => decodeURIComponent(s.replace(/\.git$/, ""));
  let m = u.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]!), repository: dec(m[3]!) };
  m = u.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  if (m) return { orgUrl: `https://dev.azure.com/${m[1]}`, project: dec(m[2]!), repository: dec(m[3]!) };
  m = u.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { orgUrl: `https://${m[1]}.visualstudio.com`, project: dec(m[2]!), repository: dec(m[3]!) };
  m = u.match(/^(?:ssh:\/\/)?[^@]+@vs-ssh\.visualstudio\.com(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  if (m) return { orgUrl: `https://${m[1]}.visualstudio.com`, project: dec(m[2]!), repository: dec(m[3]!) };
  return undefined;
}

export function isAzureRemote(url: string): boolean {
  return /dev\.azure\.com|visualstudio\.com/i.test(url);
}

export type AzureTokenKind = "pat" | "bearer";

export interface AzureToken {
  value: string;
  kind: AzureTokenKind;
  source: string;
}

/**
 * Token for the runner (never for agents), in order:
 * FOREMAN_AZURE_TOKEN, AZURE_DEVOPS_EXT_PAT (az CLI convention), AZURE_DEVOPS_TOKEN
 * (all PATs unless kind says otherwise), then SYSTEM_ACCESSTOKEN (Azure Pipelines job token, bearer).
 */
export function azureToken(env: NodeJS.ProcessEnv = process.env, kind: "auto" | AzureTokenKind = "auto"): AzureToken | undefined {
  for (const [name, defKind] of [
    ["FOREMAN_AZURE_TOKEN", "pat"],
    ["AZURE_DEVOPS_EXT_PAT", "pat"],
    ["AZURE_DEVOPS_TOKEN", "pat"],
    ["SYSTEM_ACCESSTOKEN", "bearer"],
  ] as const) {
    const v = env[name];
    if (v) return { value: v, kind: kind === "auto" ? defKind : kind, source: name };
  }
  return undefined;
}

export function azureAuthHeader(t: AzureToken): string {
  return t.kind === "pat" ? `Basic ${Buffer.from(`:${t.value}`).toString("base64")}` : `Bearer ${t.value}`;
}

/** git http.extraheader auth for this organization's host. */
export function azureGitAuth(ref: AzureRepoRef, t: AzureToken): GitHttpAuth {
  return { urlPrefix: `${new URL(ref.orgUrl).origin}/`, header: azureAuthHeader(t) };
}

// ---- HTML helpers for work items -------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Work item rich-text fields are HTML; turn them into readable text with markdown-ish lists. */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr)\s*>/gi, "\n")
    .replace(/<\s*h([1-6])[^>]*>/gi, (_m, n: string) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return ENTITIES[e] ?? String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface WorkItemFields {
  "System.Title"?: string;
  "System.Description"?: string;
  "Microsoft.VSTS.TCM.ReproSteps"?: string;
  "Microsoft.VSTS.Common.AcceptanceCriteria"?: string;
  "System.Tags"?: string;
  "Microsoft.VSTS.Common.Priority"?: number;
  "System.WorkItemType"?: string;
}

/** Map a work item to a task `wi-<id>`. */
export function taskFromWorkItem(id: number, f: WorkItemFields): Task {
  const description = htmlToText(f["System.Description"] ?? f["Microsoft.VSTS.TCM.ReproSteps"]);
  const tags = (f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean);
  const base = taskFromIssue({ number: id, title: f["System.Title"] ?? `Work item ${id}`, body: description, labels: tags });
  const ac = htmlToText(f["Microsoft.VSTS.Common.AcceptanceCriteria"]);
  const acceptance = ac
    ? ac.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, "").trim()).filter(Boolean)
    : base.acceptance;
  // Work item Priority 1 (highest) .. 4, unless a priority:* tag set it
  let priority = base.priority;
  if (!tags.some((t) => /^priority[:/]/i.test(t))) {
    const p = f["Microsoft.VSTS.Common.Priority"];
    priority = p === 1 ? 50 : p === 3 ? -25 : p === 4 ? -50 : 0;
  }
  return { ...base, id: `wi-${id}`, acceptance, priority };
}

// ---- client -------------------------------------------------------------------

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export class AzureHttpError extends Error {
  override name = "AzureHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly response: { headers: Record<string, string> },
  ) {
    super(message);
  }
}

interface AzPr {
  pullRequestId: number;
  status: "active" | "abandoned" | "completed" | string;
  isDraft?: boolean;
  sourceRefName: string;
  creationDate?: string;
}

interface AzBuild {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  sourceVersion?: string;
  sourceBranch?: string;
  definition?: { id: number; name: string };
  triggerInfo?: Record<string, string>;
  queueTime?: string;
}

interface AzTimelineRecord {
  name: string;
  type: string;
  result?: string;
  issues?: Array<{ type: string; message: string }>;
  log?: { url: string };
}

export class AzureDevOpsHost implements RepoHost {
  readonly kind = "azure-devops" as const;
  private readonly auth: string;

  constructor(
    readonly ref: AzureRepoRef,
    token: AzureToken,
    private readonly baseBranch: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.auth = azureAuthHeader(token);
  }

  // ---- low level ---------------------------------------------------------

  private projectUrl(): string {
    return `${this.ref.orgUrl.replace(/\/+$/, "")}/${encodeURIComponent(this.ref.project)}`;
  }

  private repoApi(p: string): string {
    return `${this.projectUrl()}/_apis/git/repositories/${encodeURIComponent(this.ref.repository)}${p}`;
  }

  webPrUrl(id: number): string {
    return `${this.projectUrl()}/_git/${encodeURIComponent(this.ref.repository)}/pullrequest/${id}`;
  }

  private async request(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<string> {
    return withRetry(async () => {
      const res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: "application/json, text/plain",
          "User-Agent": "claude-foreman",
          ...(body !== undefined ? { "Content-Type": contentType } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      const ct = res.headers.get("content-type") ?? "";
      // Azure DevOps answers bad credentials with a 203 + HTML sign-in page instead of 401.
      if (res.status === 203 || (/text\/html/i.test(ct) && !url.includes("/logs/"))) {
        throw new AzureHttpError(`Azure DevOps rejected the credentials (HTTP ${res.status}) for ${method} ${url}`, 401, { headers: {} });
      }
      if (!res.ok) {
        const headers: Record<string, string> = {};
        const ra = res.headers.get("retry-after");
        if (ra) headers["retry-after"] = ra;
        let msg = text.slice(0, 500);
        try {
          msg = (JSON.parse(text) as { message?: string }).message ?? msg;
        } catch {
          /* not JSON */
        }
        throw new AzureHttpError(`Azure DevOps ${method} ${url} failed (${res.status}): ${msg}`, res.status, { headers });
      }
      return text;
    });
  }

  private async json<T>(method: string, url: string, body?: unknown, contentType?: string): Promise<T> {
    const text = await this.request(method, url, body, contentType);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---- pull requests -----------------------------------------------------

  issueRef(number: number): string {
    return `Resolves work item #${number}`;
  }

  private toRef(pr: AzPr): PullRequestRef {
    return {
      number: pr.pullRequestId,
      url: this.webPrUrl(pr.pullRequestId),
      state: pr.status === "active" ? "open" : "closed",
      merged: pr.status === "completed",
      draft: Boolean(pr.isDraft),
      head: pr.sourceRefName.replace(/^refs\/heads\//, ""),
    };
  }

  async findPrForBranch(branch: string): Promise<PullRequestRef | undefined> {
    const url = this.repoApi(
      `/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=all&$top=10&${API}`,
    );
    const { value } = await this.json<{ value: AzPr[] }>("GET", url);
    const sorted = [...(value ?? [])].sort((a, b) => (b.creationDate ?? "").localeCompare(a.creationDate ?? "") || b.pullRequestId - a.pullRequestId);
    return sorted[0] ? this.toRef(sorted[0]) : undefined;
  }

  /** Fit the body into Azure's description limit; the full text goes in a comment. */
  private fit(body: string): { description: string; overflow?: string } {
    if (body.length <= MAX_PR_DESCRIPTION) return { description: body };
    const note = "\n\n…_(truncated: the full report is in the comments)_";
    let cut = body.slice(0, MAX_PR_DESCRIPTION - note.length);
    const nl = cut.lastIndexOf("\n");
    if (nl > MAX_PR_DESCRIPTION / 2) cut = cut.slice(0, nl);
    return { description: cut + note, overflow: body };
  }

  async createPr(input: CreatePrInput): Promise<PullRequestRef> {
    if (!input.head.startsWith(BRANCH_PREFIX) || input.head === this.baseBranch) {
      throw new BranchSafetyError(`Refusing to open a PR from ${input.head}`);
    }
    const { description, overflow } = this.fit(input.body);
    const pr = await this.json<AzPr>("POST", this.repoApi(`/pullrequests?${API}`), {
      sourceRefName: `refs/heads/${input.head}`,
      targetRefName: `refs/heads/${input.base}`,
      title: input.title.slice(0, 400),
      description,
      isDraft: input.draft,
      ...(input.labels.length ? { labels: input.labels.map((name) => ({ name })) } : {}),
      ...(input.issueNumber ? { workItemRefs: [{ id: String(input.issueNumber) }] } : {}),
    });
    if (overflow) await this.commentPr(pr.pullRequestId, overflow);
    return { ...this.toRef(pr), state: "open", merged: false, head: input.head };
  }

  async updatePr(number: number, patch: { body?: string; title?: string }): Promise<void> {
    const fitted = patch.body !== undefined ? this.fit(patch.body) : undefined;
    await this.json("PATCH", this.repoApi(`/pullrequests/${number}?${API}`), {
      ...(patch.title ? { title: patch.title.slice(0, 400) } : {}),
      ...(fitted ? { description: fitted.description } : {}),
    });
    if (fitted?.overflow) await this.commentPr(number, fitted.overflow);
  }

  async addPrLabels(number: number, labels: string[]): Promise<void> {
    for (const name of labels) {
      try {
        await this.json("POST", this.repoApi(`/pullrequests/${number}/labels?${API}`), { name });
      } catch (e) {
        process.emitWarning(`Could not add tag ${name} to PR ${number}: ${(e as Error).message}`);
      }
    }
  }

  async commentPr(number: number, body: string): Promise<void> {
    await this.json("POST", this.repoApi(`/pullrequests/${number}/threads?${API}`), {
      comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
      status: 1,
    });
  }

  // ---- work items ----------------------------------------------------------

  async listTaskIssues(label: string): Promise<Task[]> {
    const tag = label.replace(/'/g, "''");
    const query =
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ` +
      `AND [System.Tags] CONTAINS '${tag}' ` +
      `AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed') ` +
      `ORDER BY [System.Id] ASC`;
    const res = await this.json<{ workItems?: Array<{ id: number }> }>(
      "POST",
      `${this.projectUrl()}/_apis/wit/wiql?$top=200&${API}`,
      { query },
    );
    const ids = (res.workItems ?? []).map((w) => w.id);
    const tasks: Task[] = [];
    const fields = [
      "System.Title",
      "System.Description",
      "Microsoft.VSTS.TCM.ReproSteps",
      "Microsoft.VSTS.Common.AcceptanceCriteria",
      "System.Tags",
      "Microsoft.VSTS.Common.Priority",
      "System.WorkItemType",
    ].join(",");
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { value } = await this.json<{ value: Array<{ id: number; fields: WorkItemFields }> }>(
        "GET",
        `${this.projectUrl()}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${fields}&errorPolicy=omit&${API}`,
      );
      for (const wi of value ?? []) if (wi?.fields) tasks.push(taskFromWorkItem(wi.id, wi.fields));
    }
    return tasks;
  }

  async commentIssue(number: number, body: string): Promise<void> {
    const url = `${this.projectUrl()}/_apis/wit/workItems/${number}/comments`;
    try {
      await this.json("POST", `${url}?format=markdown&api-version=7.1-preview.4`, { text: body });
    } catch (e) {
      if ((e as AzureHttpError).status !== 400) throw e;
      // Older servers: HTML only.
      await this.json("POST", `${url}?api-version=7.1-preview.4`, { text: `<pre>${escapeHtml(body)}</pre>` });
    }
  }

  async addIssueLabels(number: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    const wi = await this.json<{ fields: WorkItemFields }>(
      "GET",
      `${this.projectUrl()}/_apis/wit/workitems/${number}?fields=System.Tags&${API}`,
    );
    const tags = new Set((wi.fields?.["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean));
    labels.forEach((l) => tags.add(l));
    await this.json(
      "PATCH",
      `${this.projectUrl()}/_apis/wit/workitems/${number}?${API}`,
      [{ op: "add", path: "/fields/System.Tags", value: [...tags].join("; ") }],
      "application/json-patch+json",
    );
  }

  // ---- CI (Azure Pipelines) ----------------------------------------------

  /**
   * Builds for this commit: branch CI builds (sourceVersion = sha) and PR
   * validation builds on refs/pull/<id>/merge (triggerInfo pr.sourceSha = sha).
   * The latest build per pipeline definition counts.
   */
  async ciStatus(ref: CiRef): Promise<CiStatus> {
    const sha = ref.sha.toLowerCase();
    const branches = [`refs/heads/${ref.branch}`, ...(ref.prNumber ? [`refs/pull/${ref.prNumber}/merge`] : [])];
    const all: AzBuild[] = [];
    for (const b of branches) {
      const { value } = await this.json<{ value: AzBuild[] }>(
        "GET",
        `${this.projectUrl()}/_apis/build/builds?branchName=${encodeURIComponent(b)}&queryOrder=queueTimeDescending&$top=25&${API}`,
      );
      all.push(...(value ?? []));
    }
    const forSha = all.filter(
      (b) => b.sourceVersion?.toLowerCase() === sha || b.triggerInfo?.["pr.sourceSha"]?.toLowerCase() === sha,
    );
    const latest = new Map<number, AzBuild>();
    for (const b of forSha) {
      const key = b.definition?.id ?? b.id;
      const cur = latest.get(key);
      if (!cur || (b.queueTime ?? "") > (cur.queueTime ?? "")) latest.set(key, b);
    }
    const builds = [...latest.values()];
    const state = summarizeBuilds(builds);
    if (state !== "failure") return { state, details: "" };

    const parts: string[] = [];
    for (const b of builds.filter((x) => isFailedResult(x.result)).slice(0, 3)) {
      parts.push(`### ${b.definition?.name ?? "pipeline"} ${b.buildNumber ?? b.id} (${b.result})`);
      try {
        const tl = await this.json<{ records?: AzTimelineRecord[] }>(
          "GET",
          `${this.projectUrl()}/_apis/build/builds/${b.id}/timeline?${API}`,
        );
        const failed = (tl.records ?? []).filter((r) => r.result === "failed" && (r.type === "Task" || r.type === "Job"));
        for (const r of failed.slice(0, 4)) {
          parts.push(`- ${r.type} **${r.name}** failed`);
          for (const i of (r.issues ?? []).filter((x) => x.type === "error").slice(0, 10)) parts.push(`  - ${i.message}`);
        }
        for (const r of failed.filter((x) => x.type === "Task" && x.log?.url).slice(0, 2)) {
          const log = await this.request("GET", r.log!.url).catch(() => "");
          if (log) parts.push("```\n" + logTail(log) + "\n```");
        }
      } catch {
        /* details are best effort */
      }
    }
    return { state, details: parts.join("\n") };
  }
}

function isFailedResult(r: string | undefined): boolean {
  return r === "failed" || r === "canceled";
}

/** partiallySucceeded counts as success (it means continueOnError steps failed). */
export function summarizeBuilds(builds: Array<{ status?: string; result?: string }>): CiStatus["state"] {
  if (!builds.length) return "none";
  if (builds.some((b) => isFailedResult(b.result))) return "failure";
  if (builds.some((b) => b.status !== "completed")) return "pending";
  return "success";
}
