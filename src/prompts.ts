import { extractAcceptanceSection, type Task } from "./tasks.js";

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
  if (task.prototypeDir) {
    lines.push(
      "## Approved prototype",
      `The user approved the clickable prototype in \`${task.prototypeDir}/index.html\`. Read it and build the real feature to match its layout, copy, states and flow.`,
      "Rebuild it properly in this project's own stack, components and styling, with real data and the project's conventions.",
      "Do not import from, link to or edit the prototype folder: it is a reference only.",
      "",
    );
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
      ? "You may run these check commands with Bash to verify your work before finishing. Run each exactly as written, " +
        "one command per Bash call: no cd, &&, ;, pipes or redirection (you are already in the repo root), or it is " +
        "rejected. Read and search files with the Read, Glob and Grep tools, not cat/head/find/grep in Bash."
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
  ci_failed: "CI FAILED on the pull request for your last attempt.",
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

// ---- story docs ---------------------------------------------------------

/** Build the prompt body shared by all three analyst calls. */
function askBlock(task: Task, promptText: string, docPath: string): string {
  const lines = [`# Request for task ${task.id}`, "", promptText.trim(), ""];
  if (task.files.length) {
    lines.push("## Files / areas to look at first", ...task.files.map((f) => `- ${f}`), "");
  }
  lines.push(`Story file: \`${docPath}\``);
  return lines.join("\n");
}

export function storyWritePrompt(task: Task, promptText: string, docPath: string): string {
  return [askBlock(task, promptText, docPath), "", `This story does not exist yet. Write it to \`${docPath}\` now.`].join(
    "\n",
  );
}

export function storyGapCheckPrompt(existingDoc: string, promptText: string, docPath: string): string {
  return [
    `# New ask for ${docPath}`,
    "",
    promptText.trim(),
    "",
    `## Current contents of ${docPath}`,
    "```markdown",
    existingDoc.trim(),
    "```",
    "",
    "Does the story's acceptance criteria already cover everything the new ask requires?",
    "Do not edit the file. Return your verdict.",
  ].join("\n");
}

export function storyUpdatePrompt(existingDoc: string, missing: string[], promptText: string, docPath: string): string {
  return [
    `# New ask for ${docPath}`,
    "",
    promptText.trim(),
    "",
    `## Current contents of ${docPath}`,
    "```markdown",
    existingDoc.trim(),
    "```",
    "",
    "## Missing from the story",
    ...missing.map((m) => `- ${m}`),
    "",
    `Update \`${docPath}\` to add the missing acceptance criteria above. Keep everything already in the file.`,
  ].join("\n");
}

export function prototypeWritePrompt(story: { path: string; content: string }, folder: string, designBrief?: string): string {
  return [
    `# Build a prototype for ${story.path}`,
    "",
    "## The story",
    "```markdown",
    story.content.trim(),
    "```",
    "",
    designBrief
      ? `Design brief: read \`${designBrief}\` first and follow it exactly.`
      : "No design brief was given: study the project's existing UI and match it.",
    "",
    `Prototype folder: \`${folder}\``,
    `This is a new prototype. Write \`${folder}/index.html\` now.`,
  ].join("\n");
}

export function prototypeRevisePrompt(story: { path: string; content: string }, folder: string, feedback: string, designBrief?: string): string {
  return [
    `# Revise the prototype for ${story.path}`,
    "",
    "## The story",
    "```markdown",
    story.content.trim(),
    "```",
    "",
    "## Feedback from the person reviewing it",
    feedback.trim(),
    "",
    designBrief ? `Design brief: \`${designBrief}\` (still applies).` : "",
    `Prototype folder: \`${folder}\``,
    `Read \`${folder}/index.html\` first, then apply the feedback to it. Keep everything the feedback does not mention.`,
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

// ---- prototype critique ---------------------------------------------------

export interface CritiqueIssue {
  severity: "major" | "minor";
  where?: string;
  problem: string;
  fix: string;
}

export interface Critique {
  /** False when the critic could not actually view the screenshots. */
  sawScreenshots: boolean;
  verdict: "approve" | "revise";
  summary: string;
  issues: CritiqueIssue[];
}

export const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    sawScreenshots: { type: "boolean" },
    verdict: { type: "string", enum: ["approve", "revise"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["major", "minor"] },
          where: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["severity", "problem", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["sawScreenshots", "verdict", "summary", "issues"],
  additionalProperties: false,
} as const;

/** Parse structured output, or fall back to a JSON object in text. Tolerant of loose issue entries. */
export function parseCritique(structured: unknown, text: string): Critique | undefined {
  const tryObj = (o: unknown): Critique | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const c = o as Record<string, unknown>;
    if (c.verdict !== "approve" && c.verdict !== "revise") return undefined;
    const issues: CritiqueIssue[] = [];
    if (Array.isArray(c.issues)) {
      for (const raw of c.issues) {
        if (!raw || typeof raw !== "object") continue;
        const i = raw as Record<string, unknown>;
        const problem = typeof i.problem === "string" ? i.problem.trim() : "";
        if (!problem) continue;
        issues.push({
          severity: i.severity === "major" ? "major" : "minor",
          ...(typeof i.where === "string" && i.where.trim() ? { where: i.where.trim() } : {}),
          problem,
          fix: typeof i.fix === "string" ? i.fix.trim() : "",
        });
      }
    }
    return { sawScreenshots: c.sawScreenshots !== false, verdict: c.verdict, summary: String(c.summary ?? ""), issues };
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

export interface CritiqueShot {
  /** Repo-relative path the critic opens with Read. */
  path: string;
  description: string;
}

export function critiquePrompt(
  story: { path: string; content: string },
  shots: CritiqueShot[],
  round: number,
  consoleIssues: string[],
  previous: CritiqueIssue[] = [],
  layoutIssues: string[] = [],
): string {
  const lines = [
    `# Review the prototype for ${story.path} (review ${round})`,
    "",
    "## The story",
    "```markdown",
    story.content.trim(),
    "```",
    "",
    "## Screenshots to review",
    "Open each image with the Read tool and look at it before you judge:",
    ...shots.map((s) => `- \`${s.path}\`: ${s.description}`),
    "Pages taller than the capture limit are cut off, and large images may be scaled down.",
    "",
  ];
  if (layoutIssues.length) {
    lines.push(
      "## Measured by the browser (facts, not opinions)",
      ...layoutIssues.map((l) => `- ${l}`),
      "Each of these is a real defect: report it as a major issue and name the elements responsible.",
      "",
    );
  }
  if (consoleIssues.length) {
    lines.push("## What the page logged in the browser", ...consoleIssues.map((c) => `- ${c}`), "");
  }
  if (previous.length) {
    lines.push(
      "## Reported last review, then revised by the designer",
      "Check whether each of these is now fixed, and say so if it is not:",
      ...previous.map((i) => `- [${i.severity}]${i.where ? ` (${i.where})` : ""} ${i.problem}`),
      "",
    );
  }
  lines.push("Return your verdict.");
  return lines.join("\n");
}

/** The critic's issues, worded as feedback for the designer's revision. Majors first, at most eight. */
export function critiqueFeedback(c: Critique, layoutIssues: string[] = []): string {
  const issues = [...c.issues].sort((a, b) => Number(b.severity === "major") - Number(a.severity === "major")).slice(0, 8);
  return [
    "A design review of screenshots of this prototype (desktop, mobile and dark mode) found problems. Fix them, major ones first, and keep everything that already works:",
    ...issues.map((i) => `- [${i.severity}]${i.where ? ` (${i.where})` : ""} ${i.problem}${i.fix ? ` Fix: ${i.fix}` : ""}`),
    layoutIssues.length ? `\nMeasured in a real browser (facts, not opinions; fix these first):\n${layoutIssues.map((l) => `- ${l}`).join("\n")}` : "",
    c.summary.trim() ? `\nReviewer's summary: ${c.summary.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const STORY_GAP_SCHEMA = {
  type: "object",
  properties: {
    covered: { type: "boolean" },
    missing: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["covered", "missing"],
  additionalProperties: false,
} as const;

export interface StoryGapVerdict {
  covered: boolean;
  missing: string[];
  summary?: string;
}

export function parseStoryGap(structured: unknown, text: string): StoryGapVerdict | undefined {
  const tryObj = (o: unknown): StoryGapVerdict | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Partial<StoryGapVerdict>;
    if (typeof r.covered !== "boolean") return undefined;
    return {
      covered: r.covered,
      missing: Array.isArray(r.missing) ? r.missing.map(String) : [],
      ...(r.summary !== undefined ? { summary: String(r.summary) } : {}),
    };
  };
  const s = tryObj(structured);
  if (s) return s;
  const m = text.match(/\{[\s\S]*"covered"[\s\S]*\}/);
  if (m) {
    try {
      return tryObj(JSON.parse(m[0]));
    } catch {
      /* fallthrough */
    }
  }
  return undefined;
}

export interface ParsedStory {
  title?: string;
  description: string;
  acceptance: string[];
}

/**
 * Pull title/description/acceptance out of a story doc written in the
 * `# Title` / body / `## Acceptance criteria` shape the analyst is told to
 * use. Tolerant of extra sections and missing pieces; never throws.
 */
export function parseStoryDoc(markdown: string): ParsedStory {
  const text = markdown.replace(/\r\n/g, "\n").trim();
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim();
  const acceptance = extractAcceptanceSection(text);
  let body = titleMatch ? text.slice(titleMatch.index! + titleMatch[0].length) : text;
  const heading = body.match(/^#{1,6}\s*acceptance(?:\s+criteria)?\s*$/im);
  if (heading) body = body.slice(0, heading.index);
  return { ...(title ? { title } : {}), description: body.trim(), acceptance };
}
