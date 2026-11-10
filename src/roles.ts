import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Role = "planner" | "coder" | "reviewer" | "analyst";
export const ROLES: Role[] = ["planner", "coder", "reviewer", "analyst"];

export interface RoleDefinition {
  name: Role;
  description: string;
  model?: string;
  tools: string[];
  /** Markdown body: the role's system prompt. */
  prompt: string;
}

/**
 * The plugin directory ships with the npm package (`files: ["plugin"]`).
 * Works from both src/ (tests) and dist/ (published build).
 */
export function pluginDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin");
}

/** Minimal frontmatter parser: `key: value` lines between `---` fences. */
export function parseAgentMarkdown(text: string): { meta: Record<string, string>; body: string } {
  const norm = text.replace(/\r\n/g, "\n");
  const m = norm.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: norm.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2]!.trim() };
}

export async function loadRole(role: Role, dir = path.join(pluginDir(), "agents")): Promise<RoleDefinition> {
  const text = await readFile(path.join(dir, `${role}.md`), "utf8");
  const { meta, body } = parseAgentMarkdown(text);
  return {
    name: role,
    description: meta.description ?? role,
    ...(meta.model ? { model: meta.model } : {}),
    tools: (meta.tools ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    prompt: body,
  };
}

export async function loadRoles(dir?: string): Promise<Record<Role, RoleDefinition>> {
  const defs = await Promise.all(ROLES.map((r) => loadRole(r, dir)));
  return Object.fromEntries(defs.map((d) => [d.name, d])) as Record<Role, RoleDefinition>;
}
