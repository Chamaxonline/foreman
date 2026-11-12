import { describe, expect, it } from "vitest";
import { checksSummary, formatFailures, selectChecks, ShellCheckRunner, UnknownCheckError } from "../src/checks.js";
import type { CheckCommand } from "../src/config.js";

const CONFIGURED: CheckCommand[] = [
  { name: "build", run: "node -e \"process.exit(0)\"" },
  { name: "test", run: "node -e \"process.exit(0)\"" },
  { name: "lint", run: "node -e \"process.exit(0)\"" },
];

describe("selectChecks", () => {
  it("runs everything when only is empty/undefined", () => {
    expect(selectChecks(CONFIGURED, undefined)).toEqual(CONFIGURED);
    expect(selectChecks(CONFIGURED, [])).toEqual(CONFIGURED);
  });

  it("filters to the named subset, preserving configured order regardless of only's order", () => {
    expect(selectChecks(CONFIGURED, ["lint", "build"])).toEqual([CONFIGURED[0], CONFIGURED[2]]);
    expect(selectChecks(CONFIGURED, ["test"])).toEqual([CONFIGURED[1]]);
  });

  it("throws UnknownCheckError naming the bad entries and what is configured", () => {
    expect(() => selectChecks(CONFIGURED, ["build", "typecheck"])).toThrow(UnknownCheckError);
    try {
      selectChecks(CONFIGURED, ["typecheck", "e2e"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownCheckError);
      expect((e as Error).message).toContain("typecheck, e2e");
      expect((e as Error).message).toContain("build, test, lint");
    }
  });

  it("reports (none) when there are no configured checks to fall back to", () => {
    expect(() => selectChecks([], ["x"])).toThrow(/\(none\)/);
  });
});

describe("ShellCheckRunner", () => {
  const ok = 'node -e "process.exit(0)"';
  const fail = 'node -e "console.error(\'boom\'); process.exit(1)"';
  const signal = () => new AbortController().signal;

  it("runs only the requested subset, in configured order, and reports ok on success", async () => {
    const runner = new ShellCheckRunner([{ name: "build", run: ok }, { name: "test", run: ok }, { name: "lint", run: fail }], 5);
    const run = await runner.run(process.cwd(), signal(), ["test", "build"]);
    expect(run.ok).toBe(true);
    expect(run.results.map((r) => r.name)).toEqual(["build", "test"]);
  });

  it("stops at the first failure within the requested subset and reports it", async () => {
    const runner = new ShellCheckRunner([{ name: "build", run: fail }, { name: "test", run: ok }], 5);
    const run = await runner.run(process.cwd(), signal());
    expect(run.ok).toBe(false);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ name: "build", ok: false, code: 1 });
    expect(run.failureOutput).toContain("boom");
  });

  it("propagates UnknownCheckError for a bad task.checks name before running anything", async () => {
    const runner = new ShellCheckRunner([{ name: "build", run: ok }], 5);
    await expect(runner.run(process.cwd(), signal(), ["nope"])).rejects.toThrow(UnknownCheckError);
  });
});

describe("formatFailures / checksSummary", () => {
  it("formatFailures includes command, exit code and output; notes an abort", () => {
    const text = formatFailures(
      [{ name: "test", command: "npm test", ok: false, code: 1, timedOut: false, durationMs: 10, output: "boom" }],
      true,
    );
    expect(text).toContain("$ npm test");
    expect(text).toContain("(exit 1)");
    expect(text).toContain("boom");
    expect(text).toContain("aborted");
  });

  it("checksSummary marks pass/fail per check", () => {
    const summary = checksSummary([
      { name: "build", command: "npm run build", ok: true, code: 0, timedOut: false, durationMs: 1200, output: "" },
      { name: "test", command: "npm test", ok: false, code: 1, timedOut: true, durationMs: 500, output: "" },
    ]);
    expect(summary).toContain("✅");
    expect(summary).toContain("❌");
    expect(summary).toContain("timed out");
  });
});
