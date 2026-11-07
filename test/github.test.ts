import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { BranchSafetyError } from "../src/git.js";
import { OctokitGitHub, summarizeCi, withRetry } from "../src/github.js";

describe("withRetry", () => {
  const sleep = vi.fn(async () => {});

  it("retries 5xx and rate limits, then succeeds", async () => {
    let n = 0;
    const res = await withRetry(
      async () => {
        n++;
        if (n === 1) throw Object.assign(new Error("boom"), { status: 502 });
        if (n === 2) throw Object.assign(new Error("slow down"), { status: 429, response: { headers: { "retry-after": "2" } } });
        return "ok";
      },
      { sleep },
    );
    expect(res).toBe("ok");
    expect(n).toBe(3);
    expect(sleep).toHaveBeenLastCalledWith(2000);
  });

  it("does not retry 4xx client errors", async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw Object.assign(new Error("nope"), { status: 422 });
      }, { sleep }),
    ).rejects.toThrow("nope");
    expect(n).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw Object.assign(new Error("down"), { status: 503 });
      }, { sleep, retries: 2 }),
    ).rejects.toThrow("down");
    expect(n).toBe(3);
  });
});

describe("summarizeCi", () => {
  it("maps runs/statuses to a single state", () => {
    expect(summarizeCi([], [])).toBe("none");
    expect(summarizeCi([{ status: "completed", conclusion: "success" }], [{ state: "success" }])).toBe("success");
    expect(summarizeCi([{ status: "in_progress", conclusion: null }], [])).toBe("pending");
    expect(summarizeCi([{ status: "completed", conclusion: "success" }], [{ state: "pending" }])).toBe("pending");
    expect(summarizeCi([{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }], [])).toBe("failure");
    expect(summarizeCi([{ status: "completed", conclusion: "skipped" }], [{ state: "error" }])).toBe("failure");
    expect(summarizeCi([{ status: "completed", conclusion: "neutral" }], [])).toBe("success");
  });
});

describe("OctokitGitHub", () => {
  function fake() {
    const create = vi.fn(async (args: Record<string, unknown>) => ({
      data: { number: 12, html_url: "https://github.com/a/b/pull/12", draft: args.draft },
    }));
    const addLabels = vi.fn(async () => ({}));
    const octo = { pulls: { create }, issues: { addLabels } } as unknown as Octokit;
    return { gh: new OctokitGitHub("a", "b", "tok", "main", octo), create, addLabels };
  }

  it("creates a PR (never merges) and labels it", async () => {
    const { gh, create, addLabels } = fake();
    const pr = await gh.createPr({ head: "foreman/x", base: "main", title: "t", body: "b", draft: true, labels: ["foreman", "needs-human"] });
    expect(pr).toMatchObject({ number: 12, draft: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ head: "foreman/x", base: "main", draft: true }));
    expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 12, labels: ["foreman", "needs-human"] }));
  });

  it("refuses PRs from non-foreman heads", async () => {
    const { gh, create } = fake();
    await expect(gh.createPr({ head: "main", base: "main", title: "t", body: "", draft: false, labels: [] })).rejects.toThrow(BranchSafetyError);
    expect(create).not.toHaveBeenCalled();
  });

  it("the client has no merge capability", () => {
    expect(Object.getOwnPropertyNames(OctokitGitHub.prototype).some((m) => /merge/i.test(m))).toBe(false);
  });
});
