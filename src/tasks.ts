import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import { formatZodError } from "./config.js";

/** Task ids become branch names (`foreman/<id>`), so keep them ref-safe. */
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const PRIORITY_WORDS: Record<string, number> = {
  critical: 100,
  high: 50,
  medium: 0,
  normal: 0,
  low: -50,
};

const prioritySchema = z
  .union([z.number(), z.enum(Object.keys(PRIORITY_WORDS) as [string, ...string[]])])
  .default(0)
  .transform((p) => (typeof p === "number" ? p : (PRIORITY_WORDS[p] ?? 0)));

const stringList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split("\n").map((s) => s.trim()).filter(Boolean)))
  .transform((v) => v.map((s) => s.replace(/^[-*]\s+/, "")));

export const taskSchema = z
  .object({
    id: z
      .union([z.string(), z.number()])
      .transform(String)
      .refine((s) => TASK_ID_RE.test(s) && !s.includes(".."), {
        message: "id must be 1-64 chars of letters, digits, '.', '_' or '-' (no '..')",
      }),
    title: z.string().min(1),
    description: z.string().default(""),
    acceptance: stringList.optional(),
    acceptance_criteria: stringList.optional(),
    /** Coder model override for this task. */
    model: z.string().optional(),
    /** Files / areas hint passed to the planner and coder. */
    files: stringList.optional(),
    priority: prioritySchema,
  })
  .transform(({ acceptance, acceptance_criteria, files, ...t }) => ({
    ...t,
    acceptance: acceptance ?? acceptance_criteria ?? [],
    files: files ?? [],
    source: "file" as TaskSource,
  }));

export type TaskSource = "file" | "issue";

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  model?: string;
  files: string[];
  priority: number;
  source: TaskSource;
  /** GitHub issue number when source === "issue". */
  issueNumber?: number;
}

const tasksFileSchema = z.union([
  z.object({ tasks: z.array(z.unknown()).nullish().transform((v) => v ?? []) }),
  z.array(z.unknown()),
]);

export class TasksError extends Error {
  override name = "TasksError";
}

export function parseTasks(text: string, source = "tasks.yaml"): Task[] {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new TasksError(`${source}: invalid YAML: ${(e as Error).message}`);
  }
  if (raw == null) return [];
  const file = tasksFileSchema.safeParse(raw);
  if (!file.success) {
    throw new TasksError(`${source}: expected a list of tasks or { tasks: [...] }`);
  }
  const items = Array.isArray(file.data) ? file.data : file.data.tasks;

  const tasks: Task[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const res = taskSchema.safeParse(item);
    if (!res.success) {
      errors.push(`task #${i + 1}:\n${formatZodError(res.error)}`);
      return;
    }
    const key = res.data.id.toLowerCase();
    if (seen.has(key)) {
      errors.push(`task #${i + 1}: duplicate id "${res.data.id}"`);
      return;
    }
    seen.add(key);
    tasks.push(res.data);
  });
  if (errors.length) throw new TasksError(`${source} is invalid:\n${errors.join("\n")}`);
  return tasks;
}

export async function loadTasks(file: string): Promise<Task[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return parseTasks(text, file);
}

/** Highest priority first; ties keep their original (file) order. */
export function sortByPriority<T extends { priority: number }>(tasks: T[]): T[] {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
    .map(({ t }) => t);
}

export interface IssueLike {
  number: number;
  title: string;
  body?: string | null;
  labels: Array<string | { name?: string }>;
}

/**
 * Turn a GitHub issue into a task. The issue body is the description; a
 * markdown section headed "Acceptance criteria" (any level) becomes the
 * acceptance list. Labels `priority:high` etc. set priority.
 */
export function taskFromIssue(issue: IssueLike): Task {
  const body = (issue.body ?? "").replace(/\r\n/g, "\n");
  const acceptance: string[] = [];
  const m = body.match(/^#{1,6}\s*acceptance(?:\s+criteria)?\s*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im);
  if (m?.[1]) {
    for (const line of m[1].split("\n")) {
      const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/);
      if (item?.[1]) acceptance.push(item[1].trim());
    }
  }
  const labelNames = issue.labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
  let priority = 0;
  for (const l of labelNames) {
    const pm = l.match(/^priority[:/](\w+)$/i);
    if (pm?.[1]) {
      const word = pm[1].toLowerCase();
      priority = PRIORITY_WORDS[word] ?? (Number.isFinite(Number(word)) ? Number(word) : 0);
    }
  }
  const modelLabel = labelNames.find((l) => /^model[:/]/i.test(l));
  return {
    id: `issue-${issue.number}`,
    title: issue.title,
    description: body,
    acceptance,
    files: [],
    priority,
    source: "issue",
    issueNumber: issue.number,
    ...(modelLabel ? { model: modelLabel.replace(/^model[:/]/i, "") } : {}),
  };
}
