import { createHash } from "node:crypto";

/**
 * Reduce error output to the parts that identify *which* error happened, so
 * the same failure produces the same signature across attempts even when
 * timings, temp paths, addresses or pids differ.
 */
export function normalizeError(text: string): string {
  let s = text
    .replace(/\r\n/g, "\n")
    // ANSI escapes
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    // ISO / common timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s*(?:AM|PM)?\b/gi, "<time>")
    // durations: 12ms, 1.5s, 3 seconds, (123 ms)
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|m|min|minutes?|µs|us|ns)\b/gi, "<dur>")
    // hex addresses / hashes
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    // (must mix letters and digits so plain long numbers are kept)
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,64}\b/gi, "<hash>")
    // temp directories and worktree paths
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"]*?(?:tmp|temp|Temp)[\\/][^\s:'"]*/g, "<tmp>")
    .replace(/[^\s'"]*[\\/]\.foreman[\\/]worktrees[\\/][^\\/\s]+/g, "<wt>")
    // pids / ports
    .replace(/\b(?:pid|port)[\s:=]+\d+/gi, "<id>")
    // line:col positions shift as code changes; keep the file, drop the position
    .replace(/:(\d+):(\d+)\b/g, ":<l>:<c>")
    .replace(/\((\d+),(\d+)\)/g, "(<l>,<c>)")
    .replace(/\bline \d+\b/gi, "line <l>");
  s = s
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
  return s;
}

const ERRORISH = /(error|fail|exception|assert|expected|received|cannot|undefined|not found|denied|panic|traceback|✗|×|✕)/i;

/** Pick the lines that carry the error; fall back to the tail. */
export function errorKey(text: string): string {
  const norm = normalizeError(text);
  const lines = norm.split("\n");
  const errLines = lines.filter((l) => ERRORISH.test(l));
  const picked = errLines.length ? errLines.slice(0, 40) : lines.slice(-30);
  return picked.join("\n");
}

export function errorSignature(text: string): string {
  return createHash("sha256").update(errorKey(text)).digest("hex").slice(0, 16);
}

/**
 * Tracks consecutive failure signatures. `record` returns true when the last
 * `threshold` failures all had the same signature: the agent is stuck.
 */
export class StuckDetector {
  private readonly sigs: string[] = [];

  constructor(
    readonly threshold = 3,
    seed: string[] = [],
  ) {
    for (const s of seed) this.sigs.push(s);
  }

  record(signature: string): boolean {
    this.sigs.push(signature);
    return this.isStuck();
  }

  isStuck(): boolean {
    if (this.sigs.length < this.threshold) return false;
    const last = this.sigs.slice(-this.threshold);
    return last.every((s) => s === last[0]);
  }

  /** Call when a step succeeds (e.g. checks pass) so old failures don't count. */
  reset(): void {
    this.sigs.length = 0;
  }
}
