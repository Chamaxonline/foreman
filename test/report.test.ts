import { describe, expect, it } from "vitest";
import { modelUsageTable, summarizeModelUsage, type ModelUsage } from "../src/report.js";
import type { AttemptRecord } from "../src/state.js";

function rec(model: string, costUsd: number, over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { n: 1, model, outcome: "pass", summary: "", costUsd, at: "2026-01-01T00:00:00.000Z", ...over };
}

describe("summarizeModelUsage", () => {
  it("totals attempts and cost per model across multiple histories, sorted by cost desc", () => {
    const usage = summarizeModelUsage([
      [rec("sonnet", 0.1), rec("sonnet", 0.2), rec("opus", 1.0)],
      [rec("opus", 0.5), rec("haiku", 0.05)],
    ]);
    expect(usage).toEqual([
      { model: "opus", attempts: 2, costUsd: 1.5, pctOfCost: 85.7 },
      { model: "sonnet", attempts: 2, costUsd: 0.3, pctOfCost: 17.1 },
      { model: "haiku", attempts: 1, costUsd: 0.05, pctOfCost: 2.9 },
    ]);
    // percentages don't need to add to exactly 100 after rounding, but should be close
    const sum = usage.reduce((s, u) => s + u.pctOfCost, 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);
  });

  it("returns [] for no attempts, and 0% for every model when every cost is 0", () => {
    expect(summarizeModelUsage([])).toEqual([]);
    expect(summarizeModelUsage([[]])).toEqual([]);
    expect(summarizeModelUsage([[rec("sonnet", 0), rec("opus", 0)]])).toEqual([
      { model: "opus", attempts: 1, costUsd: 0, pctOfCost: 0 },
      { model: "sonnet", attempts: 1, costUsd: 0, pctOfCost: 0 },
    ]);
  });

  it("breaks cost ties by attempt count, then alphabetically", () => {
    const usage = summarizeModelUsage([[rec("zebra", 1), rec("alpha", 1), rec("mid", 1), rec("mid", 0)]]);
    expect(usage.map((u) => u.model)).toEqual(["mid", "alpha", "zebra"]);
  });
});

describe("modelUsageTable", () => {
  it("renders a markdown table", () => {
    const usage: ModelUsage[] = [{ model: "opus", attempts: 3, costUsd: 1.23, pctOfCost: 66.7 }];
    const table = modelUsageTable(usage);
    expect(table).toContain("| Model | Calls | Cost | % of cost |");
    expect(table).toContain("| `opus` | 3 | $1.23 | 66.7% |");
  });

  it("has a fallback for no usage", () => {
    expect(modelUsageTable([])).toMatch(/no model usage/i);
  });
});
