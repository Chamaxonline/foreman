import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDuration, LiveWriter, prettyActivity, readLive } from "../src/live.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "foreman-live-"));
  file = path.join(dir, ".foreman", "live.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("formatDuration", () => {
  it("reads naturally at each scale", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(4000)).toBe("1h 6m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("prettyActivity", () => {
  it("turns tool calls into short actions and drops the noise", () => {
    expect(prettyActivity("[tool] Edit src/a.ts")).toBe("Edit src/a.ts");
    expect(prettyActivity("[tool] StructuredOutput ")).toBe("StructuredOutput");
    expect(prettyActivity("[assistant] I'll start with the controller.")).toBe("says: I'll start with the controller.");
    expect(prettyActivity("[guard] denied Bash: Bash: shell control characters")).toBe("the safety guard blocked a Bash call");
    expect(prettyActivity("[rate-limit] warning: five_hour at 80%")).toBe("Claude usage: warning: five_hour at 80%");
    for (const noise of ["", "   ", "[init] model=opus tools=Read", "[result] success cost=$0.1 turns=3", "[planner result] ok=true"]) {
      expect(prettyActivity(noise), noise).toBeUndefined();
    }
  });

  it("shows paths relative to the project, whichever slash they use", () => {
    expect(prettyActivity("[tool] Read D:\\Works\\app\\.foreman\\worktrees\\t1\\src\\a.ts")).toBe("Read src\\a.ts");
    expect(prettyActivity("[tool] Read /home/me/app/.foreman/worktrees/t1/src/a.ts")).toBe("Read src/a.ts");
    expect(prettyActivity("[tool] Write D:\\Works\\app\\docs\\stories\\x.md", ["D:\\Works\\app"])).toBe("Write docs\\stories\\x.md");
    expect(prettyActivity("[tool] Write /home/me/app/docs/stories/x.md", ["/home/me/app"])).toBe("Write docs/stories/x.md");
  });

  it("cuts very long text", () => {
    expect(prettyActivity(`[assistant] ${"x".repeat(500)}`)!.length).toBeLessThanOrEqual(166);
    expect(prettyActivity(`[tool] Bash ${"y".repeat(500)}`)!.length).toBeLessThanOrEqual(140);
  });
});

describe("LiveWriter", () => {
  const writer = (now = () => new Date("2026-01-01T00:00:00Z")) => new LiveWriter(file, { command: "run" }, { now, minIntervalMs: 5 });

  it("publishes the current stage and what changed, merging patches", async () => {
    const w = writer();
    w.set({ taskId: "t1", title: "Add thing", stage: "Planning the change", step: "plan", role: "planner", model: "opus" });
    w.set({ attempt: 2, maxAttempts: 5 });
    await w.flush();
    const s = JSON.parse(await readFile(file, "utf8"));
    expect(s).toMatchObject({ command: "run", pid: process.pid, taskId: "t1", title: "Add thing", stage: "Planning the change", step: "plan", model: "opus", attempt: 2, maxAttempts: 5, idle: false });
    await w.clear();
  });

  it("setting a stage means working unless it says it is idle, and restarts the stage clock only when the stage changes", async () => {
    let t = new Date("2026-01-01T00:00:00Z");
    const w = writer(() => t);
    w.set({ stage: "Planning the change" });
    t = new Date("2026-01-01T00:01:00Z");
    w.set({ attempt: 1 }); // same stage: clock keeps running
    await w.flush();
    expect(JSON.parse(await readFile(file, "utf8")).stageStartedAt).toBe("2026-01-01T00:00:00.000Z");
    t = new Date("2026-01-01T00:02:00Z");
    w.set({ stage: "Writing the code" });
    w.set({ idle: true, stage: "Waiting for the next task" });
    await w.flush();
    const s = JSON.parse(await readFile(file, "utf8"));
    expect(s.idle).toBe(true);
    expect(s.stageStartedAt).toBe("2026-01-01T00:02:00.000Z");
    await w.clear();
  });

  it("keeps only the last few actions and the latest one", async () => {
    const w = writer();
    for (let i = 1; i <= 12; i++) w.activity(`[tool] Read file${i}.ts`);
    w.activity("[init] model=opus"); // noise is ignored
    await w.flush();
    const s = JSON.parse(await readFile(file, "utf8"));
    expect(s.recent).toEqual(Array.from({ length: 8 }, (_, i) => `Read file${i + 5}.ts`));
    expect(s.lastActivity).toBe("Read file12.ts");
    expect(s.lastActivityAt).toBeTruthy();
    await w.clear();
  });

  it("writes in bursts, not once per event", async () => {
    const w = new LiveWriter(file, { command: "run" }, { minIntervalMs: 30 });
    for (let i = 0; i < 50; i++) w.activity(`[tool] Read f${i}.ts`);
    await new Promise((r) => setTimeout(r, 120));
    const s = JSON.parse(await readFile(file, "utf8"));
    expect(s.recent.at(-1)).toBe("Read f49.ts"); // the throttled write caught up to the last event
    await w.clear();
  });

  it("clear removes the file and stops further writes", async () => {
    const w = writer();
    w.set({ stage: "Working" });
    await w.flush();
    await w.clear();
    await expect(readFile(file)).rejects.toThrow();
    w.set({ stage: "Too late" });
    w.activity("[tool] Read a.ts");
    await w.flush();
    await expect(readFile(file)).rejects.toThrow();
  });
});

describe("readLive", () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      pid: 4242,
      host: "box",
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      idle: false,
      taskId: "t1",
      stage: "Writing the code",
      stageStartedAt: "2026-01-01T00:02:00.000Z",
      lastActivity: "Edit src/a.ts",
      lastActivityAt: "2026-01-01T00:03:50.000Z",
      recent: ["Read a.ts", "Edit src/a.ts"],
      updatedAt: "2026-01-01T00:03:58.000Z",
      ...over,
    });
  const at = (iso: string) => ({ now: new Date(iso), host: "box", isAlive: () => true });
  const put = async (text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };

  it("reports a working process with its timings", async () => {
    await put(body());
    const v = (await readLive(file, at("2026-01-01T00:04:00Z")))!;
    expect(v).toMatchObject({ running: true, working: true, secondsRunning: 240, secondsInStage: 120, secondsSinceActivity: 10, stage: "Writing the code" });
    expect(v.recent).toEqual(["Read a.ts", "Edit src/a.ts"]);
  });

  it("an idle process is running but not working", async () => {
    await put(body({ idle: true, stage: "Waiting for the next task" }));
    expect(await readLive(file, at("2026-01-01T00:04:00Z"))).toMatchObject({ running: true, working: false });
  });

  it("a process that has gone is not running, even though its file is still there", async () => {
    await put(body());
    const v = await readLive(file, { ...at("2026-01-01T00:04:00Z"), isAlive: () => false });
    expect(v).toMatchObject({ running: false, working: false });
  });

  it("a status nobody has refreshed for minutes is not running, even if the pid was reused", async () => {
    await put(body({ updatedAt: "2026-01-01T00:00:10.000Z" }));
    expect((await readLive(file, at("2026-01-01T00:10:00Z")))!.running).toBe(false);
  });

  it("from another machine, judges by how recently it was written", async () => {
    await put(body({ host: "other" }));
    expect((await readLive(file, { now: new Date("2026-01-01T00:04:30Z"), host: "box", isAlive: () => false }))!.running).toBe(true);
    expect((await readLive(file, { now: new Date("2026-01-01T00:20:00Z"), host: "box", isAlive: () => true }))!.running).toBe(false);
  });

  it("is undefined for a missing, half-written or wrong file", async () => {
    expect(await readLive(file)).toBeUndefined();
    await put('{"pid": 12');
    expect(await readLive(file)).toBeUndefined();
    await put('{"hello":"world"}');
    expect(await readLive(file)).toBeUndefined();
  });

  it("recognizes the real current process as alive", async () => {
    const w = new LiveWriter(file, { command: "story" }, { minIntervalMs: 5 });
    w.set({ stage: "Writing the story" });
    await w.flush();
    const v = (await readLive(file))!;
    expect(v).toMatchObject({ running: true, working: true, command: "story", pid: process.pid });
    await w.clear();
  });
});
