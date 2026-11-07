import { query, type Options, type SDKMessage, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "./roles.js";
import { envValue } from "./env.js";
import { makeToolGuard, toolsFor } from "./toolguard.js";

export interface AgentCall {
  role: Role;
  model: string;
  systemPrompt: string;
  prompt: string;
  /** Task worktree; the agent's cwd and its only accessible directory. */
  cwd: string;
  readOnly: boolean;
  allowBash: boolean;
  allowedCommands: string[];
  isProtected: (relPath: string) => boolean;
  maxTurns: number;
  /** Hard USD cap for this call (the remaining task/run/day budget). */
  maxBudgetUsd: number;
  signal: AbortSignal;
  /** Resume a previous session of the same role/model. */
  resumeSessionId?: string;
  /** JSON schema for structured output (reviewer). */
  outputSchema?: Record<string, unknown>;
  /** Progress callback for logs. */
  onEvent?: (line: string) => void;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd: number;
  sessionId?: string;
  turns: number;
  /**
   * SDK result subtype, e.g. success, error_max_turns, error_max_budget_usd,
   * plus foreman's own: "rate_limited" (subscription usage limit), "exception", "aborted".
   */
  subtype: string;
  error?: string;
  deniedToolCalls: number;
  /** When subtype is "rate_limited": epoch ms when the limit resets, if known. */
  resetsAt?: number;
}

// ---- Claude authentication ---------------------------------------------------

export type AuthMode = "auto" | "subscription" | "api-key";

export interface ResolvedAuth {
  /** subscription: CLAUDE_CODE_OAUTH_TOKEN; api-key: ANTHROPIC_API_KEY/AUTH_TOKEN; claude-login: stored `claude login` credentials. */
  kind: "subscription" | "api-key" | "claude-login";
  description: string;
}

export class AuthError extends Error {
  override name = "AuthError";
}

const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const OAUTH_VARS = ["CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * Decide which Claude credential agents use. Claude Code itself prefers an API
 * key over a subscription token when both are set; foreman makes the choice
 * explicit and strips the other credential from the agent environment.
 *  - subscription: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), else a stored `claude login`
 *  - api-key: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)
 *  - auto: subscription token if present, else API key, else stored login
 */
export function resolveAuth(mode: AuthMode, env: NodeJS.ProcessEnv = process.env): ResolvedAuth {
  const hasOauth = OAUTH_VARS.some((k) => envValue(env, k));
  const hasKey = API_KEY_VARS.some((k) => envValue(env, k));
  const subscription = (): ResolvedAuth =>
    hasOauth
      ? { kind: "subscription", description: "Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)" }
      : { kind: "claude-login", description: "stored `claude login` credentials (no CLAUDE_CODE_OAUTH_TOKEN set)" };
  switch (mode) {
    case "subscription":
      return subscription();
    case "api-key":
      if (!hasKey) throw new AuthError("agent.auth is api-key but ANTHROPIC_API_KEY is not set.");
      return { kind: "api-key", description: "Anthropic API key (ANTHROPIC_API_KEY, billed per use)" };
    case "auto":
      if (hasOauth) return subscription();
      if (hasKey) return { kind: "api-key", description: "Anthropic API key (ANTHROPIC_API_KEY, billed per use)" };
      return subscription();
  }
}

/** Convert an SDK resetsAt (seconds or ms since epoch) to ms. */
export function resetsAtMs(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v;
}

const RATE_LIMIT_TEXT = /usage limit|rate limit|limit reached|resets? (?:at|in)|429|too many requests/i;

/** The runner talks to Claude only through this interface (mocked in tests). */
export interface AgentRunner {
  run(call: AgentCall): Promise<AgentResult>;
}

/** Environment variables passed to the agent process. Everything else (tokens, cloud creds) is dropped. */
const ENV_ALLOW = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "TMPDIR", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "SHELL", "USER",
  "USERNAME", "LOGNAME", "LANG", "LANGUAGE", "TERM", "TZ", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "OS", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "CommonProgramFiles",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

/** Env var names that are never passed to agents, even if listed in passthrough. */
const ENV_DENY =
  /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|FOREMAN_GITHUB_TOKEN|FOREMAN_AZURE_TOKEN|AZURE_DEVOPS_.*|AZURE_CLIENT_SECRET|AZURE_.*TOKEN.*|SYSTEM_ACCESSTOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_.*|AWS_SECRET.*|AWS_SESSION_TOKEN|.*_DEPLOY_.*)$/i;

export function agentEnv(
  source: NodeJS.ProcessEnv = process.env,
  passthrough: string[] = [],
  auth?: ResolvedAuth,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of Object.keys(source)) {
    const v = envValue(source, k);
    if (v === undefined) continue;
    const allowed = ENV_ALLOW.includes(k) || /^LC_/.test(k) || passthrough.includes(k);
    if (allowed && !ENV_DENY.test(k)) env[k] = v;
  }
  // Pass only the chosen Claude credential, so Claude Code cannot silently prefer another one.
  if (auth?.kind === "subscription" || auth?.kind === "claude-login") for (const k of API_KEY_VARS) delete env[k];
  if (auth?.kind === "api-key") for (const k of OAUTH_VARS) delete env[k];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "claude-foreman";
  env.FOREMAN_AGENT = "1";
  env.CI = env.CI ?? "1"; // non-interactive tools (no watch mode, no prompts)
  return env;
}

export interface SdkAgentRunnerOptions {
  envPassthrough?: string[];
  /** Which Claude credential agents use (see resolveAuth). */
  auth?: ResolvedAuth;
  /** Enable Claude Code's OS-level sandbox for Bash when supported. */
  sandbox?: boolean;
  /** Injected for tests. */
  queryFn?: typeof query;
}

/** Real implementation backed by the Claude Agent SDK. */
export class SdkAgentRunner implements AgentRunner {
  constructor(private readonly opts: SdkAgentRunnerOptions = {}) {}

  async run(call: AgentCall): Promise<AgentResult> {
    const guard = makeToolGuard({
      root: call.cwd,
      readOnly: call.readOnly,
      isProtected: call.isProtected,
      allowedCommands: call.allowedCommands,
      allowBash: call.allowBash,
    });
    let denied = 0;
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const decision = guard(input.tool_name, input.tool_input);
      if (decision.allow) return {};
      denied++;
      call.onEvent?.(`[guard] denied ${input.tool_name}: ${decision.reason}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      };
    };

    const tools = toolsFor(call.readOnly, call.allowBash);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    call.signal.addEventListener("abort", onAbort, { once: true });
    if (call.signal.aborted) abort.abort();

    const options: Options = {
      model: call.model,
      cwd: call.cwd,
      systemPrompt: { type: "preset", preset: "claude_code", append: call.systemPrompt },
      tools,
      allowedTools: tools,
      disallowedTools: ["WebFetch", "WebSearch", "Task", "Agent"],
      // Anything not pre-approved is denied; there is never a human to ask.
      permissionMode: "dontAsk",
      // Ignore the target repo's .claude settings so it cannot loosen these rules.
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: "block" }] },
      maxTurns: call.maxTurns,
      maxBudgetUsd: Math.max(0.01, call.maxBudgetUsd),
      abortController: abort,
      env: agentEnv(process.env, this.opts.envPassthrough, this.opts.auth),
      ...(this.opts.sandbox
        ? { sandbox: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false } }
        : {}),
      ...(call.resumeSessionId ? { resume: call.resumeSessionId } : {}),
      ...(call.outputSchema ? { outputFormat: { type: "json_schema", schema: call.outputSchema } } : {}),
    };

    const result: AgentResult = { ok: false, text: "", costUsd: 0, turns: 0, subtype: "unknown", deniedToolCalls: 0 };
    let lastAssistantText = "";
    const limit: RateLimitSeen = { hit: false };
    try {
      const q = (this.opts.queryFn ?? query)({ prompt: call.prompt, options });
      for await (const msg of q) {
        handleMessage(msg, result, call.onEvent, (t) => (lastAssistantText = t), limit);
      }
    } catch (e) {
      // The SDK throws after yielding an error result; keep what we captured.
      if (result.subtype === "unknown") {
        result.subtype = call.signal.aborted ? "aborted" : "exception";
        result.error = (e as Error).message;
      }
    } finally {
      call.signal.removeEventListener("abort", onAbort);
    }
    if (!result.text) result.text = lastAssistantText;
    result.deniedToolCalls = denied;
    // Subscription usage limit (or API 429): not the agent's fault; the runner waits it out.
    if (!result.ok && result.subtype !== "aborted" && (limit.hit || RATE_LIMIT_TEXT.test(`${result.error ?? ""} ${result.text}`))) {
      result.subtype = "rate_limited";
      const resets = limit.resetsAt ?? parseResetFromText(`${result.error ?? ""} ${result.text}`);
      if (resets !== undefined) result.resetsAt = resets;
      call.onEvent?.(`[rate-limit] usage limit reached${resets ? `; resets at ${new Date(resets).toISOString()}` : ""}`);
    }
    return result;
  }
}

interface RateLimitSeen {
  hit: boolean;
  resetsAt?: number;
}

/** Claude Code reports e.g. "Claude AI usage limit reached|1767225600". */
function parseResetFromText(s: string): number | undefined {
  const m = s.match(/limit reached\|(\d{9,13})/i);
  return m ? resetsAtMs(Number(m[1])) : undefined;
}

function handleMessage(
  msg: SDKMessage,
  out: AgentResult,
  onEvent: ((l: string) => void) | undefined,
  setText: (t: string) => void,
  limit: RateLimitSeen = { hit: false },
): void {
  switch (msg.type) {
    case "rate_limit_event": {
      const info = msg.rate_limit_info;
      if (info.status === "rejected") {
        limit.hit = true;
        const r = resetsAtMs(info.resetsAt);
        if (r !== undefined) limit.resetsAt = r;
      } else if (info.status === "allowed_warning") {
        onEvent?.(`[rate-limit] warning: ${info.rateLimitType ?? "usage"} at ${Math.round((info.utilization ?? 0) * 100)}%`);
      }
      break;
    }
    case "system":
      if (msg.subtype === "init") {
        out.sessionId = msg.session_id;
        onEvent?.(`[init] model=${msg.model} tools=${msg.tools.join(",")}`);
      }
      break;
    case "assistant": {
      if (msg.error === "rate_limit") limit.hit = true;
      const blocks = msg.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) texts.push(b.text);
        if (b.type === "tool_use") onEvent?.(`[tool] ${b.name} ${summarizeInput(b.input)}`);
      }
      if (texts.length) {
        setText(texts.join("\n"));
        onEvent?.(`[assistant] ${texts.join(" ").slice(0, 300)}`);
      }
      break;
    }
    case "result":
      out.sessionId = msg.session_id;
      out.costUsd = msg.total_cost_usd ?? 0;
      out.turns = msg.num_turns;
      out.subtype = msg.subtype;
      if (msg.subtype === "success") {
        out.ok = !msg.is_error;
        out.text = msg.result;
        if ("structured_output" in msg && msg.structured_output !== undefined) out.structured = msg.structured_output;
      } else {
        out.ok = false;
        out.error = [msg.subtype, ...(msg.errors ?? [])].join(": ");
      }
      onEvent?.(`[result] ${msg.subtype} cost=$${out.costUsd.toFixed(4)} turns=${out.turns}`);
      break;
    default:
      break;
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? "";
  return String(v).slice(0, 160);
}
