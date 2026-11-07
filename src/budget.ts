import type { ForemanConfig } from "./config.js";
import type { StateStore } from "./state.js";

export type LimitKind = "attempts" | "time" | "task_spend" | "run_spend" | "day_spend" | "stuck";

/** Limits that end the task (draft PR, needs-human). */
export const TASK_LIMITS: LimitKind[] = ["attempts", "time", "task_spend", "stuck"];
/** Limits that pause the whole runner; the task goes back to pending. */
export const GLOBAL_LIMITS: LimitKind[] = ["run_spend", "day_spend"];

/** Below this much remaining budget we do not start another agent call. */
export const MIN_CALL_BUDGET_USD = 0.05;

export interface BudgetStatus {
  remainingUsd: number;
  /** Which cap is binding (smallest remaining). */
  binding: "task_spend" | "run_spend" | "day_spend";
  exceeded?: LimitKind;
}

export class Budget {
  constructor(
    private readonly limits: ForemanConfig["limits"],
    private readonly state: StateStore,
    private readonly runId: string,
  ) {}

  status(taskId: string): BudgetStatus {
    const task = this.state.get(taskId);
    const candidates: Array<[BudgetStatus["binding"], number]> = [
      ["day_spend", this.limits.maxSpendPerDayUsd - this.state.spentToday()],
      ["run_spend", this.limits.maxSpendPerRunUsd - this.state.runCost(this.runId)],
    ];
    if (this.limits.maxSpendPerTaskUsd !== undefined) {
      candidates.push(["task_spend", this.limits.maxSpendPerTaskUsd - (task?.costUsd ?? 0)]);
    }
    candidates.sort((a, b) => a[1] - b[1]);
    const [binding, remaining] = candidates[0]!;
    return {
      remainingUsd: Math.max(0, remaining),
      binding,
      ...(remaining < MIN_CALL_BUDGET_USD ? { exceeded: binding } : {}),
    };
  }

  /** Global caps only, checked before picking up a task. */
  globalExceeded(): "run_spend" | "day_spend" | undefined {
    if (this.state.spentToday() >= this.limits.maxSpendPerDayUsd - MIN_CALL_BUDGET_USD) return "day_spend";
    if (this.state.runCost(this.runId) >= this.limits.maxSpendPerRunUsd - MIN_CALL_BUDGET_USD) return "run_spend";
    return undefined;
  }
}
