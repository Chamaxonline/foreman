import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner } from "./claude.js";
import type { ForemanConfig } from "./config.js";
import { parseStoryDoc, storyWritePrompt } from "./prompts.js";
import { TASK_ID_RE, taskSchema, type Task } from "./tasks.js";

/** Why a story could not be written. `costUsd` is whatever the attempt still spent. */
export class StoryError extends Error {
  override name = "StoryError";
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/** A short file-name-safe id from the first words of the idea, e.g. "let-users-export-reports-as-pdf". */
export function storyIdFromIdea(idea: string): string {
  const words = idea
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  const id = words.join("-").slice(0, 48).replace(/-+$/, "");
  return id && TASK_ID_RE.test(id) ? id : `story-${Date.now().toString(36)}`;
}

export interface StoryRequest {
  repoDir: string;
  idea: string;
  /** File name (without .md); derived from the idea when omitted. */
  id?: string;
  config: ForemanConfig;
  agents: AgentRunner;
  /** The analyst role's system prompt. */
  systemPrompt: string;
  isProtected: (relPath: string) => boolean;
  /** Hard USD cap for the one analyst call. */
  maxBudgetUsd: number;
  signal?: AbortSignal;
  onEvent?: (line: string) => void;
}

export interface StoryResult {
  id: string;
  /** Repo-relative POSIX path, e.g. docs/stories/export-pdf.md */
  file: string;
  title?: string;
  acceptance: string[];
  costUsd: number;
}

/**
 * The "idea → story" stage: one analyst call that writes a story file under
 * docs.dir in the user's own checkout, and nothing else. No code is written,
 * nothing is committed or pushed. A human reads and edits the file before any
 * task is built from it.
 */
export async function writeStory(req: StoryRequest): Promise<StoryResult> {
  const idea = req.idea.trim();
  if (!idea) throw new StoryError('Give the idea as text, e.g. foreman story "Let users export reports as PDF".');

  const id = req.id ?? storyIdFromIdea(idea);
  if (!TASK_ID_RE.test(id) || id.includes("..")) {
    throw new StoryError(`"${id}" is not a usable story name: use 1-64 letters, digits, '.', '_' or '-'.`);
  }

  const dir = req.config.docs.dir.replace(/\/+$/, "");
  const file = `${dir}/${id}.md`;
  const abs = path.resolve(req.repoDir, file);
  const rel = path.relative(path.resolve(req.repoDir), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new StoryError(`docs.dir (${req.config.docs.dir}) must be a folder inside the repository.`);
  }
  if (await readFile(abs, "utf8").then(() => true, () => false)) {
    throw new StoryError(`${file} already exists. Pick another name with --id, or edit that file directly.`);
  }

  const task: Task = taskSchema.parse({ id, prompt: idea });
  const r = await req.agents.run({
    role: "analyst",
    model: req.config.models.analyst,
    systemPrompt: req.systemPrompt,
    prompt: storyWritePrompt(task, idea, file),
    cwd: req.repoDir,
    readOnly: false,
    allowBash: false,
    allowedCommands: [],
    isProtected: req.isProtected,
    maxTurns: req.config.limits.maxTurnsPerCall,
    maxBudgetUsd: req.maxBudgetUsd,
    signal: req.signal ?? new AbortController().signal,
    writeScope: [dir],
    ...(req.onEvent ? { onEvent: req.onEvent } : {}),
  });

  if (r.subtype === "rate_limited") {
    const when = r.resetsAt ? ` It resets around ${new Date(r.resetsAt).toLocaleString()}.` : "";
    throw new StoryError(`Claude usage limit reached.${when}`, r.costUsd);
  }
  if (r.subtype === "exception") throw new StoryError(`The analyst call failed: ${r.error ?? "unknown error"}`, r.costUsd);

  const content = await readFile(abs, "utf8").catch(() => undefined);
  if (!content?.trim()) {
    throw new StoryError(`The analyst did not write ${file} (${r.subtype}). Nothing was created.`, r.costUsd);
  }
  const parsed = parseStoryDoc(content);
  return { id, file, ...(parsed.title ? { title: parsed.title } : {}), acceptance: parsed.acceptance, costUsd: r.costUsd };
}
