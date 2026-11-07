import type { Task } from "./tasks.js";

function taskBlock(task: Task): string {
  const lines = [`# Task ${task.id}: ${task.title}`, ""];
  if (task.description.trim()) lines.push(task.description.trim(), "");
  if (task.acceptance.length) {
    lines.push("## Acceptance criteria");
    for (const a of task.acceptance) lines.push(`- ${a}`);
    lines.push("");
  }
  if (task.files.length) {
    lines.push("## Files / areas to look at first");
    for (const f of task.files) lines.push(`- ${f}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function checksBlock(checks: Array<{ name: string; run: string }>): string {
  return ["## Checks the runner will run", ...checks.map((c) => `- ${c.name}: \`${c.run}\``)].join("\n");
}

export function plannerPrompt(task: Task, checks: Array<{ name: string; run: string }>): string {
  return [
    taskBlock(task),
    checksBlock(checks),
    "",
    "Explore the repository as needed and write the implementation plan.",
  ].join("\n");
}

export function coderPrompt(
  task: Task,
  plan: string,
  checks: Array<{ name: string; run: string }>,
  canRunChecks: boolean,
): string {
  return [
    taskBlock(task),
    "## Plan",
    plan.trim() || "(no plan; use your judgment)",
    "",
    checksBlock(checks),
    canRunChecks
      ? "You may run these check commands with Bash to verify your work before finishing."
      : "You cannot run commands; the runner will run the checks after you finish.",
    "",
    "Implement the plan now. When finished, reply with a short summary of the changes.",
  ].join("\n");
}

export type FeedbackKind = "check_failed" | "rejected" | "review_changes" | "ci_failed";

const FEEDBACK_HEADERS: Record<FeedbackKind, string> = {
  check_failed: "The runner's checks FAILED on your last attempt.",
  rejected:
    "The runner REJECTED your last diff because it violates foreman's safety rules. The offending changes have been reverted.",
  review_changes: "The reviewer REQUESTED CHANGES on your last attempt.",
  ci_failed: "GitHub CI FAILED on the pull request for your last attempt.",
};

/** Prompt for a follow-up attempt (same or new session). */
export function retryPrompt(kind: FeedbackKind, feedback: string, attempt: number, maxAttempts: number): string {
  return [
    `${FEEDBACK_HEADERS[kind]} (attempt ${attempt} of ${maxAttempts})`,
    "",
    "```",
    feedback.trim().slice(-12000),
    "```",
    "",
    "Fix the underlying problem in the code (do not delete, skip or weaken tests and do not edit protected config).",
    "When finished, reply with a short summary of what you changed.",
  ].join("\n");
}

/** When escalating to a new model we start a fresh session, so restate everything. */
export function escalationPrompt(
  task: Task,
  plan: string,
  checks: Array<{ name: string; run: string }>,
  canRunChecks: boolean,
  history: string,
  kind: FeedbackKind,
  feedback: string,
): string {
  return [
    coderPrompt(task, plan, checks, canRunChecks),
    "",
    "## Previous attempts",
    "Earlier attempts by another model did not pass. The working directory still contains their changes; keep what is useful and fix the rest.",
    history.trim(),
    "",
    `## Latest failure (${kind})`,
    "```",
    feedback.trim().slice(-12000),
    "```",
  ].join("\n");
}

export function reviewerPrompt(task: Task, diff: string, checkSummary: string): string {
  return [
    taskBlock(task),
    "## Checks",
    checkSummary,
    "",
    "## Diff",
    "```diff",
    diff.length > 60000 ? diff.slice(0, 60000) + "\n[... diff truncated; read the files directly ...]" : diff,
    "```",
    "",
    "Review the change against the acceptance criteria and return your verdict.",
  ].join("\n");
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string" },
    issues: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "issues"],
  additionalProperties: false,
} as const;

export interface ReviewVerdict {
  verdict: "approve" | "request_changes";
  summary: string;
  issues: string[];
  notes?: string[];
}

/** Parse structured output, or fall back to a JSON object in text. */
export function parseReview(structured: unknown, text: string): ReviewVerdict | undefined {
  const tryObj = (o: unknown): ReviewVerdict | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Partial<ReviewVerdict>;
    if (r.verdict !== "approve" && r.verdict !== "request_changes") return undefined;
    return {
      verdict: r.verdict,
      summary: String(r.summary ?? ""),
      issues: Array.isArray(r.issues) ? r.issues.map(String) : [],
      ...(Array.isArray(r.notes) ? { notes: r.notes.map(String) } : {}),
    };
  };
  const s = tryObj(structured);
  if (s) return s;
  const m = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (m) {
    try {
      return tryObj(JSON.parse(m[0]));
    } catch {
      /* fallthrough */
    }
  }
  return undefined;
}
