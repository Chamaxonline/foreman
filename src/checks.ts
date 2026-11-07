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
  run(dir: string, signal: AbortSignal): Promise<CheckRun>;
  readonly checks: CheckCommand[];
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

  async run(dir: string, signal: AbortSignal): Promise<CheckRun> {
    const env = agentEnv(process.env, this.envPassthrough);
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[k];
    const results: CheckResult[] = [];
    for (const c of this.checks) {
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
    const ok = results.length === this.checks.length && results.every((r) => r.ok);
    return { ok, results, failureOutput: ok ? "" : formatFailures(results, signal.aborted) };
  }
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
