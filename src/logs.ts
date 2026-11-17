import { open, stat } from "node:fs/promises";

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

const TAIL_BYTES = 256 * 1024;

export interface TailOptions {
  /** How many trailing lines to print first. */
  lines: number;
  /** Keep printing what is appended until `signal` aborts. */
  follow: boolean;
  signal?: AbortSignal;
  pollMs?: number;
  write: (text: string) => void;
}

async function readRange(file: string, start: number, end: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Returns false when the file does not exist (and we are not following). */
export async function tailLog(file: string, o: TailOptions): Promise<boolean> {
  const signal = o.signal ?? new AbortController().signal;
  const pollMs = o.pollMs ?? 500;
  let offset = 0;

  let size = await stat(file).then((s) => s.size, () => undefined);
  if (size === undefined) {
    if (!o.follow) return false;
    // Following a log that has not been written yet: wait for the first run.
    while (size === undefined && !signal.aborted) {
      await sleepAbortable(pollMs, signal);
      size = await stat(file).then((s) => s.size, () => undefined);
    }
    if (size === undefined) return true;
  }

  const start = Math.max(0, size - TAIL_BYTES);
  let text = size > start ? await readRange(file, start, size) : "";
  if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop a line cut in half by the window
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-o.lines);
  if (tail.length) o.write(tail.join("\n") + "\n");
  offset = size;

  while (o.follow && !signal.aborted) {
    await sleepAbortable(pollMs, signal);
    if (signal.aborted) break;
    const now = await stat(file).then((s) => s.size, () => undefined);
    if (now === undefined) continue;
    if (now < offset) offset = 0; // truncated or replaced: start over
    if (now > offset) {
      o.write(await readRange(file, offset, now));
      offset = now;
    }
  }
  return true;
}
