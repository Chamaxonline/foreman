import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The steps of a task run, in order. Used to show progress; not every command has them. */
export type Step = "setup" | "plan" | "code" | "checks" | "review" | "ship";
export const STEPS: Step[] = ["setup", "plan", "code", "checks", "review", "ship"];

/** What a foreman process is doing right now, published to `.foreman/live.json` for the dashboard. */
export interface LiveState {
  pid: number;
  host: string;
  /** run, dry-run, watch, story or prototype. */
  command: string;
  startedAt: string;
  /** True while the process is up but has nothing to do (between tasks, or polling in watch mode). */
  idle: boolean;
  /** The task, or the story id for story and prototype work. */
  taskId?: string | undefined;
  title?: string | undefined;
  /** A short sentence for what is happening, e.g. "Writing the code". */
  stage: string;
  step?: Step | undefined;
  role?: string | undefined;
  model?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  stageStartedAt: string;
  lastActivity?: string | undefined;
  lastActivityAt?: string | undefined;
  /** The last few things it did, oldest first. */
  recent: string[];
  updatedAt: string;
}

export type LivePatch = {
  [K in keyof Omit<LiveState, "pid" | "host" | "command" | "startedAt" | "recent" | "updatedAt">]?: LiveState[K] | undefined;
};

/** What the runner talks to. Implemented by LiveWriter, and by a fake in tests. */
export interface LiveSink {
  set(patch: LivePatch): void;
  /** One raw agent event line, such as `[tool] Edit src/a.ts`. */
  activity(line: string): void;
}

const MAX_RECENT = 8;
const HEARTBEAT_MS = 30_000;

const stripPrefixes = (text: string, prefixes: string[]): string => {
  let out = text;
  for (const p of prefixes) {
    if (!p) continue;
    for (const sep of ["\\", "/"]) {
      const base = p.replace(/[\\/]+$/, "");
      out = out.split(`${base}${sep}`).join("");
      out = out.split(`${base.replace(/\\/g, "/")}${sep}`).join("");
    }
  }
  return out;
};

/**
 * An agent event line as something a person would read, or undefined for the
 * ones that are noise (session start, result totals). Paths are shortened to
 * the project, and long text is cut.
 */
export function prettyActivity(line: string, stripPaths: string[] = []): string | undefined {
  const l = line.trim();
  if (!l) return undefined;
  const clean = (s: string) =>
    stripPrefixes(s, stripPaths)
      .replace(/(?:[A-Za-z]:)?[^\s"']*[\\/]\.foreman[\\/]worktrees[\\/][^\\/\s]+[\\/]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  let m: RegExpExecArray | null;
  if ((m = /^\[tool\]\s+(\w+)\s*(.*)$/.exec(l))) return `${m[1]} ${clean(m[2] ?? "")}`.trim().slice(0, 140);
  if ((m = /^\[assistant\]\s+(.*)$/.exec(l))) return `says: ${clean(m[1] ?? "").slice(0, 160)}`;
  if ((m = /^\[guard\] denied (\w+)/.exec(l))) return `the safety guard blocked a ${m[1]} call`;
  if ((m = /^\[rate-limit\]\s*(.*)$/.exec(l))) return `Claude usage: ${clean(m[1] ?? "").slice(0, 120)}`;
  return undefined;
}

export interface LiveWriterOptions {
  now?: () => Date;
  /** Minimum time between writes. */
  minIntervalMs?: number;
  /** Absolute paths to remove from activity lines, so they read as project-relative. */
  stripPaths?: string[];
}

/**
 * Publishes the process's current activity to a small JSON file. Writes are
 * throttled, the file is refreshed every 30s while the process is alive, and
 * it is removed on exit, so the dashboard can tell "working" from "stopped".
 */
export class LiveWriter implements LiveSink {
  private state: LiveState;
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private dirty = false;
  private closed = false;
  private writing: Promise<void> = Promise.resolve();
  private started = false;

  constructor(
    private readonly file: string,
    init: { command: string },
    private readonly opts: LiveWriterOptions = {},
  ) {
    const now = this.nowIso();
    this.state = {
      pid: process.pid,
      host: os.hostname(),
      command: init.command,
      startedAt: now,
      idle: true,
      stage: "Starting",
      stageStartedAt: now,
      recent: [],
      updatedAt: now,
    };
  }

  private nowIso(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  set(patch: LivePatch): void {
    if (this.closed) return;
    const next: LiveState = { ...this.state, ...patch };
    if (patch.stage !== undefined && patch.idle === undefined) next.idle = false;
    if (patch.stage !== undefined && patch.stage !== this.state.stage && patch.stageStartedAt === undefined) next.stageStartedAt = this.nowIso();
    this.state = next;
    this.touch();
  }

  activity(line: string): void {
    if (this.closed) return;
    const text = prettyActivity(line, this.opts.stripPaths);
    if (!text) return;
    this.state = {
      ...this.state,
      lastActivity: text,
      lastActivityAt: this.nowIso(),
      recent: [...this.state.recent, text].slice(-MAX_RECENT),
    };
    this.touch();
  }

  private touch(): void {
    this.dirty = true;
    if (!this.started) {
      this.started = true;
      // A hard exit (the second Ctrl+C) skips `finally`, so remove the file here too.
      process.once("exit", () => {
        try {
          rmSync(this.file, { force: true });
        } catch {
          /* best effort */
        }
      });
      this.heartbeat = setInterval(() => {
        this.dirty = true;
        void this.flush();
      }, HEARTBEAT_MS);
      this.heartbeat.unref();
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.minIntervalMs ?? 400);
    this.timer.unref();
  }

  /** Write now, if anything changed. */
  flush(): Promise<void> {
    if (this.closed || !this.dirty) return this.writing;
    this.dirty = false;
    const body = JSON.stringify({ ...this.state, updatedAt: this.nowIso() });
    this.writing = this.writing
      .then(() => mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => writeFile(this.file, body))
      .catch(() => undefined); // status is a convenience: it must never stop a run
    return this.writing;
  }

  /** Stop publishing and remove the file. */
  async clear(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = this.heartbeat = undefined;
    await this.writing;
    await rm(this.file, { force: true }).catch(() => undefined);
  }
}

export interface LiveView extends LiveState {
  /** The process that wrote this is still up. */
  running: boolean;
  /** Running and not idle. */
  working: boolean;
  secondsRunning: number;
  secondsInStage: number;
  secondsSinceActivity?: number | undefined;
}

/** 45 -> "45s", 125 -> "2m 5s", 4000 -> "1h 6m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours to signal
  }
}

export interface ReadLiveOptions {
  now?: Date;
  host?: string;
  isAlive?: (pid: number) => boolean;
}

const secondsBetween = (later: Date, earlier: string): number => Math.max(0, Math.round((later.getTime() - Date.parse(earlier)) / 1000));

/**
 * The live status as of `now`, or undefined when there is none (or it is
 * unreadable, e.g. caught mid-write). `running` needs the process to be up
 * (checked by pid on the same machine) and to have written recently.
 */
export async function readLive(file: string, opts: ReadLiveOptions = {}): Promise<LiveView | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (!text) return undefined;
  let s: LiveState;
  try {
    s = JSON.parse(text) as LiveState;
  } catch {
    return undefined;
  }
  if (typeof s.pid !== "number" || typeof s.stage !== "string" || typeof s.startedAt !== "string" || typeof s.stageStartedAt !== "string" || typeof s.updatedAt !== "string") {
    return undefined;
  }
  const now = opts.now ?? new Date();
  const ageSeconds = secondsBetween(now, s.updatedAt);
  const sameHost = s.host === (opts.host ?? os.hostname());
  // the heartbeat refreshes every 30s, so a few minutes of silence means it is gone
  const running = sameHost ? (opts.isAlive ?? pidAlive)(s.pid) && ageSeconds < 300 : ageSeconds < 120;
  return {
    ...s,
    recent: Array.isArray(s.recent) ? s.recent.filter((r) => typeof r === "string") : [],
    idle: s.idle === true,
    running,
    working: running && s.idle !== true,
    secondsRunning: secondsBetween(now, s.startedAt),
    secondsInStage: secondsBetween(now, s.stageStartedAt),
    ...(s.lastActivityAt ? { secondsSinceActivity: secondsBetween(now, s.lastActivityAt) } : {}),
  };
}
