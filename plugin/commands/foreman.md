---
description: Work a foreman task interactively (plan → implement → check → review) without committing or pushing
argument-hint: <task-id from tasks.yaml, or a task description>
allowed-tools: Read, Glob, Grep, Edit, Write, Bash, Task, TodoWrite
---

You are running a **foreman** task interactively. Input: `$ARGUMENTS`

1. **Resolve the task.** If `$ARGUMENTS` matches a task `id` in the tasks file
   named by `foreman.config.yaml` (`tasksFile`, default `tasks.yaml`), use that
   task's title, description, acceptance criteria and files hint. Otherwise
   treat `$ARGUMENTS` as the task description and write 1-3 acceptance criteria
   yourself. Read `foreman.config.yaml` for the `checks` commands.

2. **Plan.** Use the `planner` subagent with the task and acceptance criteria.
   Show the plan to the user in a few lines.

3. **Implement.** Use the `coder` subagent with the task, criteria and plan.

4. **Verify.** Run every check command from `foreman.config.yaml`, in order.
   If one fails, send the output back to the `coder` subagent and retry. After
   2 failed attempts, implement the fix yourself. Stop after 5 attempts in total,
   or if the same error repeats 3 times, and report what is blocking.

5. **Review.** When all checks pass, use the `reviewer` subagent on `git diff`.
   If it requests changes, address them once and re-run the checks.

6. **Report.** Summarize what changed, which checks ran, and the review verdict.

Rules (also enforced by this plugin's hooks):
- Never edit CI config, test-runner/lint config, `foreman.config.yaml`, or the
  tasks file. Never delete, skip or weaken tests to make checks pass.
- Do **not** commit, push, or open a PR. Leave the changes in the working tree
  for the user, or tell them to run `foreman run --task <id>` for the fully
  automated flow with a PR.
