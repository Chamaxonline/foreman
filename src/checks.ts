import type { CheckCommand } from "./config.js";
import { agentEnv } from "./claude.js";
import { execShell, tail } from "./exec.js";

export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  code: number;
  timedOut: boolean;
  durationMs: number;
  /** Tail of combined output. */
  output: string;
}

export interface CheckRun {
  ok: boolean;
  results: CheckResult[];
  /** Combined failure output to feed back to the coder ("" when ok). */
  failureOutput: string;
}

export interface CheckRunner {
  /**
   * `only`, when given, runs just the named subset (task.checks) in their
   * normal declared order, instead of every configured check.
   */
  run(dir: string, signal: AbortSignal, only?: string[]): Promise<CheckRun>;
  readonly checks: CheckCommand[];
}

/** A task's `checks` list named a check that isn't in `foreman.config.yaml`. Never retried. */
export class UnknownCheckError extends Error {
  override name = "UnknownCheckError";
}

/**
 * Runs the configured checks in order, stopping at the first failure. The
 * runner (not the agent) runs these. Checks execute agent-written code, so
 * they get the same scrubbed environment as agents, minus the Anthropic key.
 */
export class ShellCheckRunner implements CheckRunner {
  constructor(
    readonly checks: CheckCommand[],
    private readonly defaultTimeoutMinutes: number,
    private readonly envPassthrough: string[] = [],
  ) {}

  async run(dir: string, signal: AbortSignal, only?: string[]): Promise<CheckRun> {
    const toRun = selectChecks(this.checks, only);
    const env = agentEnv(process.env, this.envPassthrough);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[k];
    const results: CheckResult[] = [];
    for (const c of toRun) {
      if (signal.aborted) break;
      const res = await execShell(c.run, {
        cwd: dir,
        env,
        timeoutMs: (c.timeoutMinutes ?? this.defaultTimeoutMinutes) * 60_000,
        signal,
      });
      const r: CheckResult = {
        name: c.name,
        command: c.run,
        ok: res.code === 0 && !res.timedOut,
        code: res.code,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        output: tail(res.output, 150),
      };
      results.push(r);
      if (!r.ok) break;
    }
    const ok = results.length === toRun.length && results.every((r) => r.ok);
    return { ok, results, failureOutput: ok ? "" : formatFailures(results, signal.aborted) };
  }
}

/**
 * Filter `configured` to the named subset in `only`, preserving configured
 * order. `only` empty/undefined means "run everything". Throws
 * `UnknownCheckError` if a name in `only` isn't configured. Exported so the
 * loop can validate task.checks up front, before spending any attempt on a
 * task whose check names are simply wrong.
 */
export function selectChecks(configured: CheckCommand[], only: string[] | undefined): CheckCommand[] {
  if (!only?.length) return configured;
  const names = new Set(configured.map((c) => c.name));
  const unknown = only.filter((n) => !names.has(n));
  if (unknown.length) {
    throw new UnknownCheckError(
      `task.checks names a check that doesn't exist: ${unknown.join(", ")}. ` +
        `Configured checks: ${[...names].join(", ") || "(none)"}.`,
    );
  }
  const wanted = new Set(only);
  return configured.filter((c) => wanted.has(c.name));
}

export function formatFailures(results: CheckResult[], aborted = false): string {
  const failed = results.filter((r) => !r.ok);
  const parts = failed.map(
    (r) =>
      `$ ${r.command}\n(exit ${r.code}${r.timedOut ? ", TIMED OUT" : ""})\n${r.output}`,
  );
  if (aborted) parts.push("(checks aborted: task time limit reached)");
  return parts.join("\n\n");
}

export function checksSummary(results: CheckResult[]): string {
  if (!results.length) return "(no checks run)";
  return results
    .map((r) => `- ${r.ok ? "✅" : "❌"} \`${r.command}\` (${r.name}, ${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? ", timed out" : ""})`)
    .join("\n");
}
