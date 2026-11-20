import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner } from "./claude.js";
import type { ForemanConfig } from "./config.js";
import { prototypeRevisePrompt, prototypeWritePrompt } from "./prompts.js";
import { TASK_ID_RE } from "./tasks.js";

/** Why a prototype could not be built or approved. `costUsd` is whatever the attempt still spent. */
export class PrototypeError extends Error {
  override name = "PrototypeError";
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/**
 * none: no prototype. draft: built, not approved. approved: approved exactly
 * as it is now. stale: it was approved, then index.html changed.
 */
export type PrototypeState = "none" | "draft" | "approved" | "stale";

export interface PrototypeLayout {
  /** Repo-relative POSIX paths. */
  dir: string;
  index: string;
  approval: string;
  story: string;
}

const trimDir = (d: string) => d.replace(/^\.?\/+/, "").replace(/\/+$/, "");

export function prototypeLayout(cfg: ForemanConfig, id: string): PrototypeLayout {
  const dir = `${trimDir(cfg.prototype.dir)}/${id}`;
  return { dir, index: `${dir}/index.html`, approval: `${dir}/approval.json`, story: `${trimDir(cfg.docs.dir)}/${id}.md` };
}

// Line endings are normalized so git's autocrlf can't make an approved file look changed.
const digest = (html: string) => createHash("sha256").update(html.replace(/\r\n/g, "\n")).digest("hex");

export function approvalText(index: string, now = new Date()): string {
  return JSON.stringify({ approvedAt: now.toISOString(), sha256: digest(index) }, null, 2) + "\n";
}

/** The state given the contents of index.html and approval.json (either may be absent). */
export function stateFromFiles(index: string | undefined, approval: string | undefined): PrototypeState {
  if (!index?.trim()) return "none";
  if (!approval) return "draft";
  try {
    return (JSON.parse(approval) as { sha256?: unknown }).sha256 === digest(index) ? "approved" : "stale";
  } catch {
    return "draft"; // an unreadable marker approves nothing
  }
}

const readText = (file: string) => readFile(file, "utf8").catch(() => undefined);

/** State of the prototype in the user's own checkout. */
export async function localPrototypeState(repoDir: string, cfg: ForemanConfig, id: string): Promise<PrototypeState> {
  const l = prototypeLayout(cfg, id);
  return stateFromFiles(await readText(path.join(repoDir, l.index)), await readText(path.join(repoDir, l.approval)));
}

export type GateDecision = { proceed: true; prototypeDir?: string } | { proceed: false; reason: string };

/**
 * Whether the real build may start. `committed` is the prototype as the build
 * will see it (the worktree is cut from origin/<base>); `local` is the user's
 * checkout. A prototype that exists only locally blocks the build rather than
 * being silently ignored.
 */
export function decideGate(id: string, l: PrototypeLayout, committed: PrototypeState, local: PrototypeState, baseBranch: string): GateDecision {
  switch (committed) {
    case "approved":
      return { proceed: true, prototypeDir: l.dir };
    case "draft":
      return {
        proceed: false,
        reason: `The prototype for ${id} is not approved yet. Review ${l.index}, run \`foreman approve ${id}\`, then commit and push ${l.dir}/ to ${baseBranch}.`,
      };
    case "stale":
      return {
        proceed: false,
        reason: `${l.index} changed after it was approved. Run \`foreman approve ${id}\` again, then commit and push ${l.dir}/ to ${baseBranch}.`,
      };
    case "none":
      return local === "none"
        ? { proceed: true }
        : {
            proceed: false,
            reason: `A prototype for ${id} exists in your checkout but not on ${baseBranch}, so the build can't see it. Commit and push ${l.dir}/ (with approval.json once approved).`,
          };
  }
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";
const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

/**
 * Make the browser itself refuse every network request from the prototype
 * (fetch, scripts, fonts, images, forms), whatever the agent wrote. Inline
 * script and style still work, so it stays clickable. Idempotent. Any CSP the
 * agent added can only tighten this one, never loosen it.
 */
export function lockdownHtml(html: string): string {
  if (html.includes(CSP_TAG)) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${CSP_TAG}${html.slice(at)}`;
  }
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}\n<head>${CSP_TAG}</head>${html.slice(at)}`;
  }
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">${CSP_TAG}</head><body>\n${html}\n</body></html>\n`;
}

/** What the prototype tried to load from outside (the browser will block it): a heuristic, for telling the user. */
export function externalReferences(html: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => found.add(s.slice(0, 120));
  for (const m of html.matchAll(/<(?:script|img|iframe|source|video|audio|embed|link)\b[^>]*?\b(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi)) add(m[1]!);
  for (const m of html.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')\s]+)/gi)) add(m[1]!);
  for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']?((?:https?:)?\/\/[^"')\s;]+)/gi)) add(m[1]!);
  for (const m of html.matchAll(/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/g)) add(`script uses ${m[0].replace(/\s*\($/, "")}`);
  return [...found];
}

const validId = (id: string) => TASK_ID_RE.test(id) && !id.includes("..");

export interface PrototypeRequest {
  repoDir: string;
  id: string;
  /** Present when revising an existing prototype. */
  feedback?: string;
  config: ForemanConfig;
  agents: AgentRunner;
  /** The designer role's system prompt. */
  systemPrompt: string;
  isProtected: (relPath: string) => boolean;
  /** Hard USD cap for the one designer call. */
  maxBudgetUsd: number;
  signal?: AbortSignal;
  onEvent?: (line: string) => void;
}

export interface PrototypeResult {
  id: string;
  layout: PrototypeLayout;
  revised: boolean;
  /** External resources the agent referenced; the browser blocks them. */
  externalRefs: string[];
  costUsd: number;
}

/**
 * The "story → prototype" stage: one designer call that writes (or revises)
 * `<prototype.dir>/<id>/index.html` in the user's checkout, scoped to that
 * folder with no Bash. Nothing is committed, pushed or built.
 */
export async function writePrototype(req: PrototypeRequest): Promise<PrototypeResult> {
  const { repoDir, id, config: cfg } = req;
  if (!validId(id)) throw new PrototypeError(`"${id}" is not a usable story id: use 1-64 letters, digits, '.', '_' or '-'.`);

  const l = prototypeLayout(cfg, id);
  const inside = (rel: string) => {
    const r = path.relative(path.resolve(repoDir), path.resolve(repoDir, rel));
    return !r.startsWith("..") && !path.isAbsolute(r);
  };
  if (!inside(l.dir)) throw new PrototypeError(`prototype.dir (${cfg.prototype.dir}) must be a folder inside the repository.`);

  const storyText = await readText(path.join(repoDir, l.story));
  if (!storyText?.trim()) {
    throw new PrototypeError(`There is no story at ${l.story}. Write it first: foreman story "<idea>" --id ${id}`);
  }

  const feedback = req.feedback?.trim();
  const state = await localPrototypeState(repoDir, cfg, id);
  if (feedback && state === "none") throw new PrototypeError(`There is no prototype for ${id} to revise yet. Run foreman prototype ${id} first.`);
  if (!feedback && state !== "none") {
    throw new PrototypeError(`A prototype for ${id} already exists (${state}). Revise it with --feedback "...", or approve it with foreman approve ${id}.`);
  }

  const brief = cfg.prototype.designBrief;
  if (brief && (!inside(brief) || !(await readText(path.join(repoDir, brief))))) {
    throw new PrototypeError(`prototype.designBrief (${brief}) must be an existing file inside the repository.`);
  }

  const story = { path: l.story, content: storyText };
  const r = await req.agents.run({
    role: "designer",
    model: cfg.models.designer,
    systemPrompt: req.systemPrompt,
    prompt: feedback ? prototypeRevisePrompt(story, l.dir, feedback, brief) : prototypeWritePrompt(story, l.dir, brief),
    cwd: repoDir,
    readOnly: false,
    allowBash: false,
    allowedCommands: [],
    isProtected: req.isProtected,
    maxTurns: cfg.limits.maxTurnsPerCall,
    maxBudgetUsd: req.maxBudgetUsd,
    signal: req.signal ?? new AbortController().signal,
    writeScope: [l.dir],
    ...(req.onEvent ? { onEvent: req.onEvent } : {}),
  });

  if (r.subtype === "rate_limited") {
    const when = r.resetsAt ? ` It resets around ${new Date(r.resetsAt).toLocaleString()}.` : "";
    throw new PrototypeError(`Claude usage limit reached.${when}`, r.costUsd);
  }
  if (r.subtype === "exception") throw new PrototypeError(`The designer call failed: ${r.error ?? "unknown error"}`, r.costUsd);

  const html = await readText(path.join(repoDir, l.index));
  if (!html?.trim()) {
    throw new PrototypeError(`The designer did not write ${l.index} (${r.subtype}). Nothing was changed.`, r.costUsd);
  }
  await writeFile(path.join(repoDir, l.index), lockdownHtml(html));
  // Whatever it was, a revised prototype is a new thing to approve.
  if (feedback) await rm(path.join(repoDir, l.approval), { force: true });

  return { id, layout: l, revised: Boolean(feedback), externalRefs: externalReferences(html), costUsd: r.costUsd };
}

export interface ApprovalResult {
  layout: PrototypeLayout;
  alreadyApproved: boolean;
}

/** Record that the user approved this exact index.html. Only the CLI calls this; agents can't write the marker. */
export async function approvePrototype(repoDir: string, cfg: ForemanConfig, id: string, now = new Date()): Promise<ApprovalResult> {
  if (!validId(id)) throw new PrototypeError(`"${id}" is not a usable story id.`);
  const l = prototypeLayout(cfg, id);
  const state = await localPrototypeState(repoDir, cfg, id);
  if (state === "none") throw new PrototypeError(`There is no prototype for ${id} at ${l.index}. Build one first: foreman prototype ${id}`);
  if (state === "approved") return { layout: l, alreadyApproved: true };
  const index = (await readText(path.join(repoDir, l.index)))!;
  await writeFile(path.join(repoDir, l.approval), approvalText(index, now));
  return { layout: l, alreadyApproved: false };
}
