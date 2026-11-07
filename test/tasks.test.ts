import { describe, expect, it } from "vitest";
import { parseTasks, sortByPriority, taskFromIssue, TasksError } from "../src/tasks.js";

describe("parseTasks", () => {
  it("parses a full task list", () => {
    const tasks = parseTasks(`
tasks:
  - id: add-health
    title: Add /health endpoint
    description: Return 200 OK with uptime.
    acceptance:
      - GET /health returns 200
      - body includes uptime
    model: opus
    files: [src/server.ts]
    priority: high
  - id: 42
    title: Fix typo
    acceptance_criteria: |
      - README says "foreman"
`);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: "add-health",
      acceptance: ["GET /health returns 200", "body includes uptime"],
      model: "opus",
      files: ["src/server.ts"],
      priority: 50,
      source: "file",
    });
    expect(tasks[1]).toMatchObject({
      id: "42",
      description: "",
      acceptance: ['README says "foreman"'],
      files: [],
      priority: 0,
    });
  });

  it("accepts a bare list and an empty file", () => {
    expect(parseTasks(`- { id: a, title: A }`)).toHaveLength(1);
    expect(parseTasks(``)).toEqual([]);
    expect(parseTasks(`tasks:`)).toEqual([]);
  });

  it("rejects ids that are not branch-safe", () => {
    for (const id of ["../x", "a b", "-x", "a..b", "x/y", "a".repeat(65)]) {
      expect(() => parseTasks(`- { id: "${id}", title: t }`), id).toThrow(TasksError);
    }
  });

  it("rejects duplicate ids (case-insensitive) and reports all errors", () => {
    expect(() =>
      parseTasks(`
- { id: a, title: A }
- { id: A, title: B }
- { id: c }
`),
    ).toThrow(/duplicate id "A"[\s\S]*task #3/);
  });
});

describe("sortByPriority", () => {
  it("orders by priority desc, stable", () => {
    const sorted = sortByPriority([
      { id: "a", priority: 0 },
      { id: "b", priority: 50 },
      { id: "c", priority: 0 },
      { id: "d", priority: -50 },
      { id: "e", priority: 50 },
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["b", "e", "a", "c", "d"]);
  });
});

describe("taskFromIssue", () => {
  it("extracts acceptance criteria, priority and model labels", () => {
    const t = taskFromIssue({
      number: 7,
      title: "Add dark mode",
      body: "Users want dark mode.\r\n\r\n## Acceptance criteria\r\n- [ ] toggle in settings\r\n- persists across reloads\r\n1. respects OS preference\r\n\r\n## Notes\r\n- not a criterion\r\n",
      labels: [{ name: "foreman" }, { name: "priority:high" }, "model:opus"],
    });
    expect(t).toMatchObject({
      id: "issue-7",
      title: "Add dark mode",
      acceptance: ["toggle in settings", "persists across reloads", "respects OS preference"],
      priority: 50,
      model: "opus",
      source: "issue",
      issueNumber: 7,
    });
  });

  it("handles acceptance section at end of body and missing body", () => {
    expect(
      taskFromIssue({ number: 1, title: "x", body: "### Acceptance\n- works", labels: [] })
        .acceptance,
    ).toEqual(["works"]);
    expect(taskFromIssue({ number: 2, title: "x", body: null, labels: [] }).acceptance).toEqual([]);
  });
});
