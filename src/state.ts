import { mkdir, readFile, rename, rm, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STATE_DIR = ".foreman";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done" // PR opened (or would have been, in dry-run)
  | "needs_human" // limits hit; draft PR opened
  | "failed"; // unrecoverable (e.g. crashed repeatedly); never retried automatically

export interface AttemptRecord {
  n: number;
  model: string;
  outcome: "pass" | "check_failed" | "rejected" | "review_changes" | "ci_failed" | "error";
  summary: string;
  costUsd: number;
  at: string;
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempts: number;
  costUsd: number;
  /** How many times this task was found in_progress after a crash/restart. */
  recoveries: number;
  dryRun?: boolean;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  lastError?: string;
  history: AttemptRecord[];
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  costUsd: number;
  dryRun: boolean;
  tasks: string[];
}

export interface StateData {
  version: 1;
  tasks: Record<string, TaskState>;
  /** USD spent per day key (YYYY-MM-DD). */
  spend: Record<string, number>;
  runs: RunRecord[];
}

export type DayBoundary = "utc" | "local";

export function dayKey(d: Date, boundary: DayBoundary = "utc"): string {
  if (boundary === "utc") return d.toISOString().slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The instant the next day starts (when the daily cap resets). */
export function nextDayStart(d: Date, boundary: DayBoundary = "utc"): Date {
  if (boundary === "utc") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

const MAX_HISTORY = 30;
const MAX_RUNS = 100;
const MAX_SPEND_DAYS = 90;
/** After this many crash recoveries a task is marked failed rather than retried forever. */
export const MAX_RECOVERIES = 3;

export function emptyState(): StateData {
  return { version: 1, tasks: {}, spend: {}, runs: [] };
}

export interface RecoveryReport {
  requeued: string[];
  failed: string[];
}

/**
 * Persistent state with atomic writes. All mutations go through `update*`
 * methods, which save immediately so a crash loses at most the in-flight step.
 */
export class StateStore {
  readonly file: string;
  private data: StateData;
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    file: string,
    data: StateData,
    private readonly now: () => Date,
    private readonly boundary: DayBoundary,
  ) {
    this.file = file;
    this.data = data;
  }

  static async open(
    dir: string,
    opts: { now?: () => Date; dayBoundary?: DayBoundary } = {},
  ): Promise<StateStore> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "state.json");
    const data = (await readJson(file)) ?? (await readJson(file + ".bak")) ?? emptyState();
    if (data.version !== 1) throw new Error(`${file}: unsupported state version ${String(data.version)}`);
    return new StateStore(file, normalize(data), opts.now ?? (() => new Date()), opts.dayBoundary ?? "utc");
  }

  snapshot(): StateData {
    return structuredClone(this.data);
  }

  get(id: string): TaskState | undefined {
    const t = this.data.tasks[id];
    return t ? structuredClone(t) : undefined;
  }

  all(): TaskState[] {
    return Object.values(this.data.tasks).map((t) => structuredClone(t));
  }

  /** Get-or-create a task entry. Does not change an existing entry. */
  async ensure(id: string): Promise<TaskState> {
    if (!this.data.tasks[id]) {
      this.data.tasks[id] = {
        id,
        status: "pending",
        attempts: 0,
        costUsd: 0,
        recoveries: 0,
        updatedAt: this.now().toISOString(),
        history: [],
      };
      await this.save();
    }
    return this.get(id)!;
  }

  async updateTask(id: string, patch: Partial<Omit<TaskState, "id">>): Promise<TaskState> {
    await this.ensure(id);
    const t = this.data.tasks[id]!;
    Object.assign(t, patch, { updatedAt: this.now().toISOString() });
    await this.save();
    return structuredClone(t);
  }

  async recordAttempt(id: string, rec: Omit<AttemptRecord, "at">): Promise<void> {
    await this.ensure(id);
    const t = this.data.tasks[id]!;
    t.history.push({ ...rec, at: this.now().toISOString() });
    if (t.history.length > MAX_HISTORY) t.history.splice(0, t.history.length - MAX_HISTORY);
    t.updatedAt = this.now().toISOString();
    await this.save();
  }

  /** Reset a finished/failed task so it runs again (CLI `--retry`). */
  async reset(id: string): Promise<void> {
    const t = this.data.tasks[id];
    if (!t) return;
    Object.assign(t, {
      status: "pending" as const,
      attempts: 0,
      recoveries: 0,
      lastError: undefined,
      updatedAt: this.now().toISOString(),
    });
    await this.save();
  }

  // ---- spend --------------------------------------------------------------

  spentToday(): number {
    return this.data.spend[dayKey(this.now(), this.boundary)] ?? 0;
  }

  async addSpend(usd: number, taskId?: string, runId?: string): Promise<void> {
    if (!(usd > 0)) return;
    const key = dayKey(this.now(), this.boundary);
    this.data.spend[key] = round((this.data.spend[key] ?? 0) + usd);
    if (taskId) {
      await this.ensure(taskId);
      const t = this.data.tasks[taskId]!;
      t.costUsd = round(t.costUsd + usd);
    }
    if (runId) {
      const r = this.data.runs.find((x) => x.id === runId);
      if (r) r.costUsd = round(r.costUsd + usd);
    }
    pruneSpend(this.data.spend);
    await this.save();
  }

  nextDayStart(): Date {
    return nextDayStart(this.now(), this.boundary);
  }

  // ---- runs ---------------------------------------------------------------

  async startRun(dryRun: boolean): Promise<RunRecord> {
    const at = this.now();
    const run: RunRecord = {
      id: `${at.toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
      startedAt: at.toISOString(),
      costUsd: 0,
      dryRun,
      tasks: [],
    };
    this.data.runs.push(run);
    if (this.data.runs.length > MAX_RUNS) this.data.runs.splice(0, this.data.runs.length - MAX_RUNS);
    await this.save();
    return structuredClone(run);
  }

  async updateRun(id: string, patch: Partial<Omit<RunRecord, "id">>): Promise<void> {
    const r = this.data.runs.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    await this.save();
  }

  runCost(id: string): number {
    return this.data.runs.find((x) => x.id === id)?.costUsd ?? 0;
  }

  // ---- crash recovery ----------------------------------------------------

  /**
   * Called on startup. Any task still `in_progress` was interrupted (crash,
   * kill, power loss). Requeue it with attempts and spend preserved, so limits
   * still apply; after MAX_RECOVERIES interruptions mark it failed so a task
   * that reliably crashes the runner cannot loop forever.
   */
  async recoverInterrupted(): Promise<RecoveryReport> {
    const report: RecoveryReport = { requeued: [], failed: [] };
    const now = this.now().toISOString();
    for (const t of Object.values(this.data.tasks)) {
      if (t.status !== "in_progress") continue;
      t.recoveries += 1;
      t.updatedAt = now;
      if (t.recoveries >= MAX_RECOVERIES) {
        t.status = "failed";
        t.finishedAt = now;
        t.lastError = `Interrupted ${t.recoveries} times (runner crash or kill); giving up.`;
        report.failed.push(t.id);
      } else {
        t.status = "pending";
        t.lastError = `Interrupted while in progress (recovery #${t.recoveries}); requeued.`;
        report.requeued.push(t.id);
      }
    }
    for (const r of this.data.runs) {
      if (!r.finishedAt) r.finishedAt = now;
    }
    if (report.requeued.length || report.failed.length) await this.save();
    return report;
  }

  // ---- persistence --------------------------------------------------------

  /** Serialized atomic save: write temp file, keep previous as .bak, rename. */
  save(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2) + "\n";
    const next = this.saving.then(() => atomicWrite(this.file, json));
    // Keep the chain alive even if one save fails; surface the error to this caller.
    this.saving = next.catch(() => undefined);
    return next;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await writeFile(file + ".bak", await readFile(file));
  } catch {
    /* no previous file */
  }
  await renameWithRetry(tmp, file);
}

/** On Windows, rename can transiently fail with EPERM/EBUSY if a reader holds the file. */
async function renameWithRetry(from: string, to: string, tries = 5): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= tries || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

async function readJson(file: string): Promise<StateData | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StateData;
  } catch {
    return undefined;
  }
}

function normalize(d: StateData): StateData {
  const out = { ...emptyState(), ...d };
  for (const t of Object.values(out.tasks)) {
    t.history ??= [];
    t.recoveries ??= 0;
    t.attempts ??= 0;
    t.costUsd ??= 0;
  }
  return out;
}

function pruneSpend(spend: Record<string, number>): void {
  const keys = Object.keys(spend).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SPEND_DAYS))) delete spend[k];
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---- process lock ----------------------------------------------------------

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export class LockError extends Error {
  override name = "LockError";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exclusive lock so two foreman processes never work the same repo. A lock
 * left by a dead process on this host is taken over automatically.
 */
export async function acquireLock(
  dir: string,
  opts: { force?: boolean } = {},
): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "lock");
  const me: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  for (let i = 0; i < 2; i++) {
    try {
      await writeFile(file, JSON.stringify(me), { flag: "wx" });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let other: LockInfo | undefined;
      try {
        other = JSON.parse(await readFile(file, "utf8")) as LockInfo;
      } catch {
        /* unreadable lock: treat as stale */
      }
      const stale =
        !other || (other.host === me.host && !pidAlive(other.pid)) || opts.force === true;
      if (!stale) {
        throw new LockError(
          `Another foreman process holds ${file} (pid ${other!.pid} on ${other!.host} since ${other!.startedAt}). ` +
            `If it is gone, rerun with --force-unlock.`,
        );
      }
      await rm(file, { force: true });
    }
  }
  throw new LockError(`Could not acquire ${file}`);
}
