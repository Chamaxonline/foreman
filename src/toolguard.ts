import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Decides, per tool call, whether an agent may proceed. This is enforced in
 * code via the SDK's PreToolUse hook (which runs for every tool call,
 * including auto-approved ones), independent of what the prompt says.
 */
export interface ToolGuardOptions {
  /** Absolute path of the task worktree. All file access must stay inside it. */
  root: string;
  /** Planner/reviewer: no writes, Bash limited to read-only commands. */
  readOnly: boolean;
  /** Repo-relative POSIX path → true if agents must never write it. */
  isProtected: (relPath: string) => boolean;
  /** Command lines (or prefixes) the agent may run via Bash. */
  allowedCommands: string[];
  allowBash: boolean;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const NEUTRAL_TOOLS = new Set(["TodoWrite"]);

export const READ_ONLY_COMMANDS = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git ls-files",
  "git grep",
  "ls",
  "pwd",
];

/** Tool names an agent of each kind is given at all (the SDK `tools` option). */
export function toolsFor(readOnly: boolean, allowBash: boolean): string[] {
  const base = ["Read", "Glob", "Grep"];
  if (readOnly) return allowBash ? [...base, "Bash"] : base;
  return [...base, "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", ...(allowBash ? ["Bash"] : [])];
}

export function makeToolGuard(opts: ToolGuardOptions): (tool: string, input: unknown) => GuardDecision {
  const root = canonical(opts.root);
  const deny = (reason: string): GuardDecision => ({ allow: false, reason });

  return (tool, rawInput) => {
    const input = (rawInput ?? {}) as Record<string, unknown>;

    if (NEUTRAL_TOOLS.has(tool)) return { allow: true };

    if (READ_TOOLS.has(tool)) {
      for (const p of pathsOf(tool, input)) {
        const rel = relInside(root, p);
        if (rel === undefined) return deny(`${tool}: path outside the working directory is not allowed: ${p}`);
      }
      return { allow: true };
    }

    if (WRITE_TOOLS.has(tool)) {
      if (opts.readOnly) return deny(`${tool}: this agent is read-only`);
      const paths = pathsOf(tool, input);
      if (paths.length === 0) return deny(`${tool}: missing file path`);
      for (const p of paths) {
        const rel = relInside(root, p);
        if (rel === undefined) return deny(`${tool}: writing outside the working directory is not allowed: ${p}`);
        if (rel === ".git" || rel.startsWith(".git/")) return deny(`${tool}: writing inside .git is not allowed`);
        if (opts.isProtected(rel)) {
          return deny(
            `${tool}: ${rel} is a protected file (CI/test/lint/foreman config). Agents may not modify it; change the code instead.`,
          );
        }
      }
      return { allow: true };
    }

    if (tool === "Bash") {
      if (!opts.allowBash) return deny("Bash is disabled for this agent");
      const cmd = typeof input.command === "string" ? input.command : "";
      const allowed = opts.readOnly ? READ_ONLY_COMMANDS : [...opts.allowedCommands, ...READ_ONLY_COMMANDS];
      const reason = checkCommand(cmd, allowed, opts.readOnly ? [] : opts.allowedCommands);
      return reason ? deny(`Bash: ${reason}`) : { allow: true };
    }

    return deny(`${tool} is not available to foreman agents`);
  };
}

/**
 * A command is allowed if it is exactly one of `exact` (configured check
 * commands, which may legitimately contain `&&`), or if it has no shell
 * control characters and starts with an allowed prefix on a word boundary.
 */
export function checkCommand(cmd: string, prefixes: string[], exact: string[] = []): string | undefined {
  const normalized = cmd.trim().replace(/\s+/g, " ");
  if (!normalized) return "empty command";
  if (exact.some((e) => e.trim().replace(/\s+/g, " ") === normalized)) return undefined;
  const stripped = normalized.replace(/\s+2>&1$/, "");
  if (/[;&|`$<>\n\r(){}]/.test(stripped)) {
    return "shell control characters (; & | ` $ < > ( ) { }) are not allowed; run one allowed command at a time";
  }
  const ok = prefixes.some((p) => {
    const pre = p.trim().replace(/\s+/g, " ");
    return stripped === pre || stripped.startsWith(pre + " ");
  });
  if (!ok) return `command not allowed. Allowed commands: ${prefixes.join(" | ")}`;
  if (/(^|\s)(--force|-f|push|commit|reset|rebase|checkout|clean|remote)(\s|$)/.test(stripped) && stripped.startsWith("git ")) {
    return "git commands that modify history, the index, or remotes are not allowed";
  }
  return undefined;
}

function pathsOf(tool: string, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length) out.push(v);
  };
  add(input.file_path);
  add(input.notebook_path);
  add(input.path);
  if (tool === "Glob" && typeof input.pattern === "string" && isAbsoluteLike(input.pattern)) add(input.pattern);
  return out;
}

function isAbsoluteLike(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("~");
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Repo-relative POSIX path if `p` resolves inside `root`, else undefined. */
export function relInside(root: string, p: string): string | undefined {
  if (p.startsWith("~")) return undefined;
  // Canonicalize root too: on macOS /tmp is a symlink to /private/tmp, and
  // Windows temp paths can have a short (8.3) form, so an uncanonicalized
  // root would never match a canonicalized abs even when p is inside it.
  const canonRoot = canonical(path.resolve(root));
  // strip glob magic so a pattern like "src/**" resolves to its directory
  const literal = p.split(/[*?[{]/)[0] ?? "";
  let abs = path.resolve(root, literal || ".");
  abs = canonicalExisting(abs);
  const rel = path.relative(canonRoot, abs);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/** Resolve symlinks for the longest existing prefix so links can't escape the root. */
function canonicalExisting(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}
