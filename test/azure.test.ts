import { describe, expect, it } from "vitest";
import {
  azureAuthHeader,
  azureGitAuth,
  AzureDevOpsHost,
  azureToken,
  htmlToText,
  MAX_PR_DESCRIPTION,
  parseAzureRemote,
  summarizeBuilds,
  taskFromWorkItem,
  type FetchLike,
} from "../src/azure.js";
import { BranchSafetyError } from "../src/git.js";
import { resolveHost } from "../src/runtime.js";
import { makeConfig } from "./helpers/fakes.js";

const REF = { orgUrl: "https://dev.azure.com/contoso", project: "My Project", repository: "web-app" };
const PAT = { value: "pat123", kind: "pat" as const, source: "FOREMAN_AZURE_TOKEN" };
const PROJ = "https://dev.azure.com/contoso/My%20Project";
const REPO = `${PROJ}/_apis/git/repositories/web-app`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Fake fetch: routes by "METHOD url-prefix" to handlers returning [status, json|string]. */
function fakeFetch(routes: Array<[string, (c: Call) => [number, unknown]]>) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const call: Call = { method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(call);
    const route = routes.find(([k]) => {
      const [m, prefix] = k.split(" ");
      return m === init.method && url.startsWith(prefix!);
    });
    if (!route) throw new Error(`unrouted ${init.method} ${url}`);
    const [status, body] = route[1](call);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300 && status !== 203,
      status,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? (typeof body === "string" && body.startsWith("<") ? "text/html" : "application/json") : null) },
      text: async () => text,
    };
  };
  return { fn, calls };
}

describe("Azure DevOps remotes and tokens", () => {
  it.each([
    ["https://dev.azure.com/contoso/My%20Project/_git/web-app", REF],
    ["https://contoso@dev.azure.com/contoso/My%20Project/_git/web-app", REF],
    ["git@ssh.dev.azure.com:v3/contoso/My%20Project/web-app", REF],
    ["https://contoso.visualstudio.com/My%20Project/_git/web-app", { ...REF, orgUrl: "https://contoso.visualstudio.com" }],
    ["https://contoso.visualstudio.com/DefaultCollection/My%20Project/_git/web-app", { ...REF, orgUrl: "https://contoso.visualstudio.com" }],
    ["contoso@vs-ssh.visualstudio.com:v3/contoso/My%20Project/web-app", { ...REF, orgUrl: "https://contoso.visualstudio.com" }],
  ])("parses %s", (url, expected) => {
    expect(parseAzureRemote(url)).toEqual(expected);
  });

  it("ignores non-Azure remotes", () => {
    expect(parseAzureRemote("https://github.com/a/b.git")).toBeUndefined();
  });

  it("picks the runner token and auth scheme", () => {
    expect(azureToken({ SYSTEM_ACCESSTOKEN: "s" })).toEqual({ value: "s", kind: "bearer", source: "SYSTEM_ACCESSTOKEN" });
    expect(azureToken({ SYSTEM_ACCESSTOKEN: "s", AZURE_DEVOPS_EXT_PAT: "p" })?.source).toBe("AZURE_DEVOPS_EXT_PAT");
    expect(azureToken({ FOREMAN_AZURE_TOKEN: "f", AZURE_DEVOPS_EXT_PAT: "p" }, "bearer")).toMatchObject({ value: "f", kind: "bearer" });
    expect(azureToken({})).toBeUndefined();
    expect(azureAuthHeader(PAT)).toBe(`Basic ${Buffer.from(":pat123").toString("base64")}`);
    expect(azureAuthHeader({ value: "t", kind: "bearer", source: "x" })).toBe("Bearer t");
    expect(azureGitAuth(REF, PAT)).toEqual({ urlPrefix: "https://dev.azure.com/", header: azureAuthHeader(PAT) });
  });
});

describe("resolveHost", () => {
  const cfg = makeConfig();

  it("detects Azure DevOps from the remote and requires a token outside dry runs", () => {
    const url = "https://dev.azure.com/contoso/My%20Project/_git/web-app";
    const r = resolveHost(cfg, url, { FOREMAN_AZURE_TOKEN: "x" }, false);
    expect(r.kind).toBe("azure-devops");
    expect(r.host?.kind).toBe("azure-devops");
    expect(r.gitAuth?.urlPrefix).toBe("https://dev.azure.com/");
    expect(r.description).toContain("contoso/My Project/_git/web-app");
    expect(() => resolveHost(cfg, url, {}, false)).toThrow(/FOREMAN_AZURE_TOKEN/);
    expect(resolveHost(cfg, url, {}, true).host).toBeUndefined();
  });

  it("supports Azure DevOps Server via explicit config", () => {
    const server = makeConfig("azureDevOps: { orgUrl: 'https://tfs.corp.local/tfs/DefaultCollection', project: P, repository: R }");
    const r = resolveHost(server, "https://tfs.corp.local/tfs/DefaultCollection/P/_git/R", { AZURE_DEVOPS_EXT_PAT: "x" }, false);
    expect(r.kind).toBe("azure-devops");
    expect(r.gitAuth?.urlPrefix).toBe("https://tfs.corp.local/");
  });

  it("falls back to GitHub, and respects an explicit provider", () => {
    expect(resolveHost(cfg, "git@github.com:a/b.git", { GITHUB_TOKEN: "t" }, false).kind).toBe("github");
    expect(() => resolveHost(makeConfig("provider: azure-devops"), "git@github.com:a/b.git", { FOREMAN_AZURE_TOKEN: "t" }, false)).toThrow(
      /Azure DevOps repository/,
    );
  });
});

describe("AzureDevOpsHost pull requests", () => {
  it("finds the newest PR for a branch and maps its state", async () => {
    const { fn, calls } = fakeFetch([
      [
        `GET ${REPO}/pullrequests`,
        () => [
          200,
          {
            value: [
              { pullRequestId: 4, status: "abandoned", sourceRefName: "refs/heads/foreman/t1", creationDate: "2026-01-01" },
              { pullRequestId: 9, status: "active", isDraft: true, sourceRefName: "refs/heads/foreman/t1", creationDate: "2026-02-01" },
            ],
          },
        ],
      ],
    ]);
    const az = new AzureDevOpsHost(REF, PAT, "main", fn);
    const pr = await az.findPrForBranch("foreman/t1");
    expect(pr).toEqual({ number: 9, url: `${PROJ}/_git/web-app/pullrequest/9`, state: "open", merged: false, draft: true, head: "foreman/t1" });
    expect(calls[0]!.url).toContain("searchCriteria.sourceRefName=refs%2Fheads%2Fforeman%2Ft1");
    expect(calls[0]!.headers.Authorization).toBe(azureAuthHeader(PAT));
  });

  it("creates a PR with tags and a linked work item, never merging", async () => {
    const { fn, calls } = fakeFetch([
      [`POST ${REPO}/pullrequests?`, (c) => [201, { pullRequestId: 12, status: "active", sourceRefName: (c.body as { sourceRefName: string }).sourceRefName }]],
    ]);
    const az = new AzureDevOpsHost(REF, PAT, "main", fn);
    const pr = await az.createPr({ head: "foreman/t1", base: "main", title: "foreman: x", body: "short", draft: true, labels: ["foreman"], issueNumber: 77 });
    expect(pr).toMatchObject({ number: 12, state: "open", head: "foreman/t1" });
    expect(calls[0]!.body).toEqual({
      sourceRefName: "refs/heads/foreman/t1",
      targetRefName: "refs/heads/main",
      title: "foreman: x",
      description: "short",
      isDraft: true,
      labels: [{ name: "foreman" }],
      workItemRefs: [{ id: "77" }],
    });
    expect(Object.getOwnPropertyNames(AzureDevOpsHost.prototype).some((m) => /merge|complete/i.test(m))).toBe(false);
  });

  it("truncates long descriptions and posts the full report as a comment", async () => {
    const { fn, calls } = fakeFetch([
      [`POST ${REPO}/pullrequests?`, () => [201, { pullRequestId: 5, status: "active", sourceRefName: "refs/heads/foreman/t1" }]],
      [`POST ${REPO}/pullrequests/5/threads`, () => [200, {}]],
    ]);
    const az = new AzureDevOpsHost(REF, PAT, "main", fn);
    const body = "line\n".repeat(2000);
    await az.createPr({ head: "foreman/t1", base: "main", title: "t", body, draft: false, labels: [] });
    const desc = (calls[0]!.body as { description: string }).description;
    expect(desc.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION);
    expect(desc).toContain("truncated");
    expect(calls[1]!.body).toEqual({ comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 });
  });

  it("refuses PRs from non-foreman branches", async () => {
    const { fn, calls } = fakeFetch([]);
    const az = new AzureDevOpsHost(REF, PAT, "main", fn);
    await expect(az.createPr({ head: "main", base: "main", title: "t", body: "", draft: false, labels: [] })).rejects.toThrow(BranchSafetyError);
    expect(calls).toHaveLength(0);
  });

  it("reports rejected credentials (203 sign-in page) clearly", async () => {
    const { fn } = fakeFetch([[`GET ${REPO}/pullrequests`, () => [203, "<html>Sign in</html>"]]]);
    await expect(new AzureDevOpsHost(REF, PAT, "main", fn).findPrForBranch("foreman/x")).rejects.toThrow(/rejected the credentials/);
  });
});

describe("work items as tasks", () => {
  it("converts work item HTML into a task", () => {
    const t = taskFromWorkItem(42, {
      "System.Title": "Export to CSV",
      "System.Description": "<div>Users need <b>CSV</b> export.</div><div>Use &quot;;&quot; as separator.</div>",
      "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>Export button on the report page</li><li>File opens in Excel</li></ul>",
      "System.Tags": "foreman; model:opus",
      "Microsoft.VSTS.Common.Priority": 1,
    });
    expect(t).toMatchObject({
      id: "wi-42",
      title: "Export to CSV",
      description: 'Users need CSV export.\nUse ";" as separator.',
      acceptance: ["Export button on the report page", "File opens in Excel"],
      model: "opus",
      priority: 50,
      issueNumber: 42,
      source: "issue",
    });
  });

  it("uses repro steps for bugs and a priority tag over the field", () => {
    const t = taskFromWorkItem(7, {
      "System.Title": "Crash",
      "Microsoft.VSTS.TCM.ReproSteps": "<p>Click save</p>",
      "System.Tags": "foreman; priority:low",
      "Microsoft.VSTS.Common.Priority": 1,
    });
    expect(t.description).toBe("Click save");
    expect(t.priority).toBe(-50);
  });

  it("htmlToText handles lists, headings and entities", () => {
    expect(htmlToText("<h2>Steps</h2><ol><li>a &amp; b</li><li>c&nbsp;d</li></ol>")).toBe("## Steps\n\n- a & b\n- c d");
  });

  it("queries tagged, open work items via WIQL", async () => {
    const { fn, calls } = fakeFetch([
      [`POST ${PROJ}/_apis/wit/wiql`, () => [200, { workItems: [{ id: 1 }, { id: 2 }] }]],
      [
        `GET ${PROJ}/_apis/wit/workitems?ids=1,2`,
        () => [200, { value: [{ id: 1, fields: { "System.Title": "A", "System.Tags": "foreman" } }, { id: 2, fields: { "System.Title": "B" } }] }],
      ],
    ]);
    const tasks = await new AzureDevOpsHost(REF, PAT, "main", fn).listTaskIssues("foreman");
    expect(tasks.map((t) => t.id)).toEqual(["wi-1", "wi-2"]);
    const q = (calls[0]!.body as { query: string }).query;
    expect(q).toContain("[System.Tags] CONTAINS 'foreman'");
    expect(q).toContain("NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed')");
  });

  it("comments on work items in markdown, falling back to HTML on older servers", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch([
      [`POST ${PROJ}/_apis/wit/workItems/5/comments`, () => (++n === 1 ? [400, { message: "format not supported" }] : [200, {}])],
    ]);
    await new AzureDevOpsHost(REF, PAT, "main", fn).commentIssue(5, "a < b");
    expect(calls[0]!.url).toContain("format=markdown");
    expect(calls[1]!.body).toEqual({ text: "<pre>a &lt; b</pre>" });
  });

  it("adds tags without dropping existing ones (JSON patch)", async () => {
    const { fn, calls } = fakeFetch([
      [`GET ${PROJ}/_apis/wit/workitems/5`, () => [200, { fields: { "System.Tags": "foreman; ui" } }]],
      [`PATCH ${PROJ}/_apis/wit/workitems/5`, () => [200, {}]],
    ]);
    await new AzureDevOpsHost(REF, PAT, "main", fn).addIssueLabels(5, ["needs-human"]);
    expect(calls[1]!.headers["Content-Type"]).toBe("application/json-patch+json");
    expect(calls[1]!.body).toEqual([{ op: "add", path: "/fields/System.Tags", value: "foreman; ui; needs-human" }]);
  });
});

describe("Azure Pipelines CI status", () => {
  const SHA = "abc123def456abc123def456abc123def456abcd";

  it("uses the latest build per pipeline for this commit (branch and PR builds)", async () => {
    const { fn } = fakeFetch([
      [
        `GET ${PROJ}/_apis/build/builds?branchName=refs%2Fheads%2Fforeman%2Ft1`,
        () => [200, { value: [
          { id: 1, status: "completed", result: "failed", sourceVersion: SHA, definition: { id: 10, name: "ci" }, queueTime: "2026-01-01T00:00:00Z" },
          { id: 2, status: "completed", result: "succeeded", sourceVersion: SHA, definition: { id: 10, name: "ci" }, queueTime: "2026-01-01T01:00:00Z" },
          { id: 3, status: "completed", result: "failed", sourceVersion: "other", definition: { id: 10, name: "ci" }, queueTime: "2026-01-01T02:00:00Z" },
        ] }],
      ],
      [
        `GET ${PROJ}/_apis/build/builds?branchName=refs%2Fpull%2F12%2Fmerge`,
        () => [200, { value: [{ id: 4, status: "inProgress", sourceVersion: "merge", triggerInfo: { "pr.sourceSha": SHA }, definition: { id: 20, name: "pr" } }] }],
      ],
    ]);
    const s = await new AzureDevOpsHost(REF, PAT, "main", fn).ciStatus({ sha: SHA, branch: "foreman/t1", prNumber: 12 });
    expect(s.state).toBe("pending");
  });

  it("collects failing task names, errors and log tails", async () => {
    const { fn } = fakeFetch([
      [`GET ${PROJ}/_apis/build/builds?`, () => [200, { value: [{ id: 8, buildNumber: "20260101.3", status: "completed", result: "failed", sourceVersion: SHA, definition: { id: 1, name: "ci" } }] }]],
      [
        `GET ${PROJ}/_apis/build/builds/8/timeline`,
        () => [200, { records: [
          { name: "npm test", type: "Task", result: "failed", issues: [{ type: "error", message: "Process exited with code 1" }], log: { url: "https://dev.azure.com/contoso/logs/9" } },
          { name: "build", type: "Task", result: "succeeded" },
        ] }],
      ],
      ["GET https://dev.azure.com/contoso/logs/9", () => [200, "2026-01-01T00:00:00.0000000Z FAIL src/a.test.ts\n2026-01-01T00:00:01.0000000Z expected 1 to be 2"]],
    ]);
    const s = await new AzureDevOpsHost(REF, PAT, "main", fn).ciStatus({ sha: SHA, branch: "foreman/t1" });
    expect(s.state).toBe("failure");
    expect(s.details).toContain("### ci 20260101.3 (failed)");
    expect(s.details).toContain("Task **npm test** failed");
    expect(s.details).toContain("Process exited with code 1");
    expect(s.details).toContain("expected 1 to be 2");
  });

  it("summarizeBuilds", () => {
    expect(summarizeBuilds([])).toBe("none");
    expect(summarizeBuilds([{ status: "completed", result: "partiallySucceeded" }])).toBe("success");
    expect(summarizeBuilds([{ status: "completed", result: "canceled" }])).toBe("failure");
    expect(summarizeBuilds([{ status: "notStarted" }])).toBe("pending");
  });
});
