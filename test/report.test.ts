import { describe, expect, it } from "vitest";
import { modelUsageTable, summarizeModelUsage, type ModelUsage } from "../src/report.js";
import type { AttemptRecord } from "../src/state.js";

function rec(model: string, costUsd: number, over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { n: 1, model, outcome: "pass", summary: "", costUsd, at: "2026-01-01T00:00:00.000Z", ...over };
}

describe("summarizeModelUsage", () => {
  it("totals calls and cost per model across multiple lists, sorted by cost desc", () => {
    const usage = summarizeModelUsage([
      [rec("sonnet", 0.1), rec("sonnet", 0.2), rec("opus", 1.0)],
      [rec("opus", 0.5), rec("haiku", 0.05)],
    ]);
    // total cost = 1.85: opus 1.5/1.85=81.08%, sonnet 0.3/1.85=16.22%, haiku 0.05/1.85=2.70%
    expect(usage).toEqual([
      { model: "opus", calls: 2, costUsd: 1.5, pctOfCost: 81.1 },
      { model: "sonnet", calls: 2, costUsd: 0.3, pctOfCost: 16.2 },
      { model: "haiku", calls: 1, costUsd: 0.05, pctOfCost: 2.7 },
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
      { model: "opus", calls: 1, costUsd: 0, pctOfCost: 0 },
      { model: "sonnet", calls: 1, costUsd: 0, pctOfCost: 0 },
    ]);
  });

  it("lists which roles used each model when the records say, and leaves it out when they don't", () => {
    const usage = summarizeModelUsage([
      [
        { model: "opus", costUsd: 1, role: "reviewer" },
        { model: "opus", costUsd: 1, role: "planner" },
        { model: "opus", costUsd: 1, role: "planner" },
        { model: "sonnet", costUsd: 1, role: "coder" },
        { model: "haiku", costUsd: 0.5 },
      ],
    ]);
    expect(usage.find((u) => u.model === "opus")!.roles).toEqual(["planner", "reviewer"]);
    expect(usage.find((u) => u.model === "sonnet")!.roles).toEqual(["coder"]);
    expect(usage.find((u) => u.model === "haiku")).not.toHaveProperty("roles");
  });

  it("breaks cost ties by call count, then alphabetically", () => {
    const usage = summarizeModelUsage([[rec("zebra", 1), rec("alpha", 1), rec("mid", 1), rec("mid", 0)]]);
    expect(usage.map((u) => u.model)).toEqual(["mid", "alpha", "zebra"]);
  });
});

describe("modelUsageTable", () => {
  it("renders a markdown table", () => {
    const usage: ModelUsage[] = [{ model: "opus", calls: 3, costUsd: 1.23, pctOfCost: 66.7 }];
    const table = modelUsageTable(usage);
    expect(table).toContain("| Model | Calls | Cost | % of cost |");
    expect(table).toContain("| `opus` | 3 | $1.23 | 66.7% |");
  });

  it("has a fallback for no usage", () => {
    expect(modelUsageTable([])).toMatch(/no model usage/i);
  });
});
