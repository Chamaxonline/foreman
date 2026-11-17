import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tailLog } from "../src/logs.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "foreman-logs-"));
  file = path.join(dir, "foreman.log");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("tailLog", () => {
  it("prints only the last N lines", async () => {
    await writeFile(file, "a\nb\nc\nd\n");
    const out: string[] = [];
    expect(await tailLog(file, { lines: 2, follow: false, write: (t) => out.push(t) })).toBe(true);
    expect(out.join("")).toBe("c\nd\n");
  });

  it("returns false for a missing file when not following", async () => {
    const out: string[] = [];
    expect(await tailLog(file, { lines: 5, follow: false, write: (t) => out.push(t) })).toBe(false);
    expect(out).toEqual([]);
  });

  it("starts a big log on a whole line, not in the middle of one", async () => {
    await writeFile(file, Array.from({ length: 40000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const out: string[] = [];
    await tailLog(file, { lines: 1_000_000, follow: false, write: (t) => out.push(t) });
    const text = out.join("");
    expect(text).toMatch(/^line \d+\n/);
    expect(text.endsWith("line 40000\n")).toBe(true);
    expect(text.length).toBeLessThan(300 * 1024); // only the trailing window was read
  });

  it("follow prints what is appended later and stops when aborted", async () => {
    await writeFile(file, "a\nb\n");
    const ctl = new AbortController();
    const out: string[] = [];
    const done = tailLog(file, { lines: 10, follow: true, signal: ctl.signal, pollMs: 10, write: (t) => out.push(t) });
    await waitFor(() => out.join("").includes("b"));
    await appendFile(file, "c\nd\n");
    await waitFor(() => out.join("").includes("d"));
    ctl.abort();
    await done;
    expect(out.join("")).toBe("a\nb\nc\nd\n");
  });

  it("follow waits for a log that does not exist yet", async () => {
    const ctl = new AbortController();
    const out: string[] = [];
    const done = tailLog(file, { lines: 10, follow: true, signal: ctl.signal, pollMs: 10, write: (t) => out.push(t) });
    await new Promise((r) => setTimeout(r, 40));
    expect(out).toEqual([]);
    await writeFile(file, "first\n");
    await waitFor(() => out.join("").includes("first"));
    ctl.abort();
    expect(await done).toBe(true);
  });

  it("follow starts over when the file is truncated or replaced", async () => {
    await writeFile(file, "old one\nold two\nold three\n");
    const ctl = new AbortController();
    const out: string[] = [];
    const done = tailLog(file, { lines: 10, follow: true, signal: ctl.signal, pollMs: 10, write: (t) => out.push(t) });
    await waitFor(() => out.join("").includes("old three"));
    await writeFile(file, "new\n");
    await waitFor(() => out.join("").includes("new\n"));
    ctl.abort();
    await done;
    expect(out.join("").endsWith("new\n")).toBe(true);
  });
});
