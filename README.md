# foreman

**foreman** is an autonomous orchestrator for software tasks. You give it a queue
of tasks. For each one it plans the work with Claude, implements it, runs **your**
build/test/lint checks, and opens a GitHub pull request. It runs with no human
confirmation, and it can keep working through the queue day and night.

```
tasks.yaml ─▶ planner ─▶ coder ─▶ runner runs checks ─▶ diff safety gate ─▶ reviewer ─▶ commit, push, PR
                            ▲              │ fail                │ reject          │ changes
                            └──────────────┴─────────────────────┴─────────────────┘
                     retry with the error output · escalate the model after 2 failures · stop when stuck
```

foreman never merges and never pushes to your base branch. Every change arrives
as a PR for a human to review.

- **Verified, not trusted.** The runner runs the checks itself, so an agent
  claiming "tests pass" counts for nothing.
- **Safety enforced in code.** Agents can't edit CI, test or lint config, or
  foreman's config. They can't delete or skip tests, reach outside the repo, or
  see your GitHub token.
- **Hard limits.** Attempts, minutes and spend are capped per task, per run and
  per day.
- **Built for unattended runs.** State persists across restarts, crashed tasks
  are requeued, API errors back off, and the run pauses when the daily budget
  is spent.
- **Three ways to run:** locally, as a GitHub Action, or as an always-on service.

> [!IMPORTANT]
> foreman runs code that an AI wrote: your test suite executes it. Read the
> [safety model](#safety-model) and run foreman somewhere you'd be comfortable
> running an untrusted contributor's PR, such as CI, a container or a VM.

---

## Contents

- [How it works](#how-it-works)
- [Setup](#setup)
- [Running locally](#running-locally)
- [Running as a GitHub Action](#running-as-a-github-action)
- [Running on an always-on server](#running-on-an-always-on-server)
- [Configuration reference](#configuration-reference)
- [Tasks](#tasks)
- [Safety model](#safety-model)
- [Claude Code plugin](#claude-code-plugin)
- [State, reports and logs](#state-reports-and-logs)
- [Development](#development)

---

## How it works

For each pending task, highest priority first:

1. **Branch.** foreman creates a git worktree at `.foreman/worktrees/<id>` on
   branch `foreman/<task-id>`, starting from `origin/<baseBranch>`. Your own
   checkout is never touched.
2. **Plan.** The planner (a strong model, read-only) turns the task into a
   short plan.
3. **Code.** The coder (a cheaper model by default) implements the plan.
4. **Verify.** The runner runs your configured checks in order. Agents never
   run this step.
5. **Gate.** The runner inspects the diff. Changes to protected paths, deleted
   or skipped tests, and edits to `package.json` scripts are reverted and
   rejected.
6. **Retry.** Failures go back to the coder:
   - check output, gate rejections and CI logs are fed back in the same session
   - after `escalateAfterFailures` failures, the coder switches to the
     escalation model
   - if the same normalized error appears `stuckThreshold` times in a row,
     foreman stops early
7. **Review** (optional). A read-only reviewer checks the diff against the
   acceptance criteria. It can send the work back once.
8. **Ship.** The **runner** commits as `foreman[bot]`, pushes `foreman/<id>`,
   and opens a PR. The PR summary covers what changed, which checks ran, the
   attempts used and the cost.
9. **CI** (optional). foreman waits for GitHub CI on the PR. Failures are fed
   back to the coder and a fix is pushed to the same PR, within the limits.
10. **Limits hit.** foreman commits the work in progress (minus any safety
    violations), opens a **draft PR labeled `needs-human`** with a failure
    report (the last errors and what was tried), and moves on to the next task.
11. **Report.** Each run writes `.foreman/reports/run-<id>.md` and `.json`.

## Setup

**Requirements:** Node.js 20+, git, and a GitHub repository.

```bash
cd your-repo
npx claude-foreman init     # writes foreman.config.yaml + tasks.yaml, detects your check commands
```

> The npm package is `claude-foreman`, and it installs a `foreman` command.
> After `npm i -g claude-foreman` you can run `foreman ...` directly.

### Credentials

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude agents | Use a dedicated key with a spend limit set in the Anthropic Console. `CLAUDE_CODE_OAUTH_TOKEN` also works. |
| `GITHUB_TOKEN` | the runner only | Pushes `foreman/*` branches and opens PRs. `FOREMAN_GITHUB_TOKEN` or `GH_TOKEN` also work. **Never passed to agents.** |

The GitHub token needs **Contents: write**, **Pull requests: write** and
**Issues: write** (for labels and comments). To wait for CI it also needs
**Checks: read**, **Commit statuses: read** and **Actions: read**. A
fine-grained PAT scoped to the one repository, or a GitHub App installation
token, is ideal.

`foreman dry-run` works without a GitHub token.

## Running locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=$(gh auth token)

foreman dry-run                      # full loop, but no push and no PRs
foreman run                          # process all pending tasks once
foreman run --task add-health        # just one task
foreman run --task add-health --retry   # rerun a done / needs-human task from scratch
foreman watch                        # continuous mode (see below)
foreman status                       # task states, spend today, last run
```

| Command | What it does |
|---|---|
| `foreman init [--force]` | Writes an annotated `foreman.config.yaml` and an example `tasks.yaml`, and adds `.foreman/` to `.gitignore`. |
| `foreman run` | Processes runnable tasks once, writes a report, then exits. |
| `foreman dry-run` | Same as `run`, but never pushes and never opens PRs. Commits only exist in a throwaway worktree. |
| `foreman watch` | Processes, idles for `watch.pollSeconds`, then polls again. Pauses until the next day when the daily cap is reached. |
| `foreman status [--json]` | Shows per-task status, attempts, cost and PR links, plus spend against the daily cap. |

**Useful flags:**
- `--repo <dir>`: target a repository other than the current directory.
- `--tasks-from-remote`: read `tasks.yaml` from `origin/<base>` instead of the
  working tree.
- `--keep-worktrees`: keep task worktrees for debugging.
- `--force-unlock`: take over a lock left by a dead process.
- `-v`: stream agent activity.

**Ctrl+C** once to finish the current task and then stop. Press it a second
time to abort immediately; the interrupted task is requeued on the next start.

**Exit codes:**
- `0`: the run completed, including tasks that ended as `needs-human`.
- `1`: a task errored.
- `2`: a usage or configuration error.

## Running as a GitHub Action

```yaml
# .github/workflows/foreman.yml
name: foreman
on:
  schedule: [{ cron: "17 */3 * * *" }]
  workflow_dispatch:
    inputs:
      task: { description: "Only this task id", required: false }

concurrency: { group: foreman, cancel-in-progress: false }

permissions:
  contents: write
  pull-requests: write
  issues: write
  checks: read
  statuses: read
  actions: read

jobs:
  foreman:
    runs-on: ubuntu-latest
    timeout-minutes: 300
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci                       # whatever your checks need
      - uses: OWNER/foreman@v0            # pin a commit SHA in production
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.FOREMAN_GITHUB_TOKEN || github.token }}
          task: ${{ inputs.task }}
```

**Action inputs:**

| Input | Default | Meaning |
|---|---|---|
| `command` | `run` | `run` or `dry-run` |
| `task` / `retry` | | Run one task, optionally resetting it first |
| `anthropic-api-key` | (required) | Passed to the agents |
| `github-token` | `github.token` | Used by the runner only |
| `version` | (this action's source) | Install `claude-foreman@<version>` from npm instead |
| `cache-state` | `true` | Persist `.foreman/state.json` with `actions/cache`, so attempt counts and daily spend survive between runs |
| `upload-report` | `true` | Upload `.foreman/reports` and logs as an artifact |
| `tasks-from-remote` | `false` | Read `tasks.yaml` from the remote base branch |
| `working-directory` | `.` | Path of the checkout |

The run report is also added to the job summary.

Notes:
- **CI on foreman PRs:** GitHub does not trigger workflows for PRs opened with
  the default `GITHUB_TOKEN`. If you set `ci.wait: true`, or simply want CI to
  run on foreman's PRs, pass a GitHub App token or PAT as `github-token`.
- **Credentials:** use `persist-credentials: false` on checkout. The action
  also strips any persisted checkout credentials before running, because your
  tests execute agent-written code.
- **Lost state:** if the cache is evicted, foreman reconciles with GitHub. A
  task that already has an open or merged PR on `foreman/<id>` is not redone.

## Running on an always-on server

Run `foreman watch` under a process supervisor. See
[`examples/server/foreman.service`](examples/server/foreman.service) for a
hardened systemd unit:

```bash
foreman watch --tasks-from-remote
```

- Tasks merged to the base branch are picked up on the next poll, without
  pulling the server's checkout.
- State lives in `.foreman/state.json`. Restarts never redo finished tasks or
  reset the limits. A task that was in progress during a crash is requeued
  with its attempts and spend preserved. After 3 crashes on the same task,
  it's marked `failed`.
- On API or network errors, the task backs off exponentially (1 minute
  doubling to 1 hour) and other tasks continue. A failing poll cycle backs
  off the same way.
- When `maxSpendPerDayUsd` is reached, `watch` sleeps until the next day.
  The day boundary is set by `dayBoundary` (`utc` or `local`).
- A lock file prevents two foreman processes from working on one repository.

Prefer a dedicated user, a container or a VM; see the [safety model](#safety-model).

## Configuration reference

`foreman.config.yaml` lives at the root of the target repository. Every key
except `checks` is optional.

```yaml
repo: your-org/your-repo        # default: parsed from the `origin` remote
baseBranch: main
remote: origin
tasksFile: tasks.yaml

checks:                         # run IN ORDER by the runner; first failure stops
  build: npm run build
  lint: npm run lint
  test: npm test
# or: checks: [{ name: test, run: "pytest -q", timeoutMinutes: 20 }]

models:                         # aliases (opus, sonnet, haiku) or full model IDs
  planner: opus
  coder: sonnet
  reviewer: opus
  escalation: opus              # coder model after repeated failures

limits:
  maxAttemptsPerTask: 5
  escalateAfterFailures: 2
  stuckThreshold: 3             # same normalized error N times in a row → stop
  maxMinutesPerTask: 45
  maxSpendPerTaskUsd: 10        # optional
  maxSpendPerRunUsd: 25
  maxSpendPerDayUsd: 100
  checkTimeoutMinutes: 15       # per check, unless the check sets timeoutMinutes
  maxTurnsPerCall: 80           # agent turns per Claude call

review:   { enabled: true, maxRounds: 1 }
ci:       { wait: false, timeoutMinutes: 30, pollSeconds: 30 }
pr:       { labels: [foreman], needsHumanLabel: needs-human, draft: false }
issues:   { enabled: false, label: foreman }   # also take tasks from labeled issues
watch:    { pollSeconds: 300 }
agent:
  allowBash: true               # coder may run the check commands (and read-only git), nothing else
  extraAllowedCommands: []      # extra command prefixes, e.g. "npx tsc --noEmit"
  sandbox: true                 # Claude Code's OS-level Bash sandbox, where supported
  envPassthrough: []            # extra env vars for agents (e.g. Bedrock/Vertex config)
protectedPaths: []              # extra globs agents may never modify
dayBoundary: utc                # utc | local; when the daily cap resets
```

**How limits apply:**
- **Task limits** end the task with a `needs-human` draft PR: attempts, minutes,
  `maxSpendPerTaskUsd`, and being stuck.
- **Global limits** (`maxSpendPerRunUsd`, `maxSpendPerDayUsd`) pause the whole
  runner. The current task goes back to pending.
- Each Claude call gets the smallest remaining budget as its hard
  `maxBudgetUsd`.
- The time limit aborts in-flight agent calls and checks.

## Tasks

```yaml
# tasks.yaml
tasks:
  - id: add-health            # becomes branch foreman/add-health; letters, digits, . _ -
    title: Add a /health endpoint
    description: |
      Return 200 with {"status":"ok","uptime":<seconds>}.
    acceptance:               # what the planner, coder and reviewer aim for
      - GET /health returns 200
      - response includes uptime in seconds
      - covered by a test
    files: [src/server.ts]    # optional hint: where to look first
    priority: high            # critical | high | medium | low, or a number (higher runs first)
    model: opus               # optional coder model override
```

**From GitHub issues:** with `issues.enabled: true`, each open issue carrying
the label becomes task `issue-<number>`:
- The issue body is the description.
- A `## Acceptance criteria` section becomes the acceptance list.
- Labels like `priority:high` and `model:opus` set the priority and model.
- The PR says `Closes #<n>`.
- If a task fails before any commit, the failure report is posted on the issue.

**Task states** (shown by `foreman status`):

| State | Meaning |
|---|---|
| `pending` | Waiting to run, or retrying after a backoff |
| `in_progress` | Being worked on (requeued automatically after a crash) |
| `done` | PR opened |
| `needs_human` | Limits hit; draft PR or issue comment with a report |
| `failed` | Unrecoverable (a runner safety violation, or repeated crashes) |

Rerun any finished task with `--task <id> --retry`.

## Safety model

foreman assumes the model can make mistakes, or be steered by malicious
content in the repository. Every rule below is enforced in code, not only in
prompts.

**What agents can do:**

| Rule | How it's enforced |
|---|---|
| File access only inside the task worktree | A `PreToolUse` hook on every tool call resolves paths, including symlinks, and denies anything outside the worktree or inside `.git`. |
| No edits to protected paths | The same hook denies the write. The diff gate rejects the change before commit and reverts it. |
| No deleting or skipping tests | The diff gate rejects deleted test files, tests moved out of the suite, a net loss of test cases, added `.skip` / `.only` / `xit` / `@pytest.mark.skip` / `t.Skip` / `#[ignore]` / `@Disabled` markers, and runner flags like `--passWithNoTests`. |
| Limited tools | `permissionMode: dontAsk` with an explicit tool list. Web, subagent and MCP tools are removed. Bash only runs the configured check commands and read-only git, with no `;`, `&&`, `\|`, `$()` or redirects. Planner and reviewer are read-only. |
| The repo can't loosen the rules | `settingSources: []`, so the target repo's `.claude/` settings and hooks are ignored. |
| No credentials | The agent environment is rebuilt from an allowlist. `GITHUB_TOKEN`, `GH_TOKEN`, npm tokens, cloud secrets, `*_DEPLOY_*` and `ACTIONS_*` variables are never passed. Checks run with the same scrubbed environment, minus the Anthropic key. |

**What the runner does with git and GitHub:**

| Rule | How it's enforced |
|---|---|
| Only `foreman/*` branches are pushed | Pushes use an explicit refspec. Pushing to the base branch, `main` or `master`, or with any `--force`, `+refspec`, `--mirror` or `--delete` argument throws before git runs. |
| No merging | The GitHub client has no merge method. |
| Git hooks never run | Every git call uses `core.hooksPath=/dev/null` and `--no-verify`, so a hook planted by an agent never runs with the runner's credentials. |
| The token stays out of the repo | Auth is injected per command as an HTTP header. It is never written to git config. |
| Hard caps | Attempts, wall-clock minutes (abort signal), and spend per call, task, run and day. |
| Dry run | `foreman dry-run` does everything except push and open PRs. |

**Protected paths, always included:**
- foreman's own files: `foreman.config.yaml`, the tasks file, `.foreman/`
- CI config: `.github/`, GitLab, CircleCI, Buildkite, Azure, Jenkins and others
- git hook tooling: `.husky/`, pre-commit, lefthook
- test runner config: vitest, jest, playwright, cypress, mocha, pytest,
  `conftest.py`, tox and others
- lint, format and type-check config: eslint, prettier, biome, `tsconfig*.json`,
  ruff, mypy, golangci, rubocop and others
- **files your checks invoke**, such as `Makefile` for `make test` or
  `scripts/ci.sh`
- the `scripts` / `jest` / `eslintConfig` fields of `package.json`
- the `[tool.pytest]` / `[tool.ruff]` / `[tool.mypy]` sections of `pyproject.toml`

Add your own with `protectedPaths`.

**Residual risks (know them before you run it):**
- **Your checks execute agent-written code**, such as tests, as the OS user
  running foreman. The environment is scrubbed, but the filesystem and network
  are only as restricted as the host. Run foreman in CI, a container, or under
  a dedicated user (see the systemd unit). Don't run it on a machine holding
  secrets in files.
- **The Anthropic key is visible to the agent process** (the agent needs it).
  Use a dedicated key with a spend limit.
- **The diff gate is a strong heuristic, not a proof.** It can't detect a
  weakened assertion. The reviewer pass and **human review of every PR** are
  the backstop. foreman never merges.
- **Prompt injection:** repository content and issue bodies reach the model.
  The rules above limit what a steered agent can do, but enable
  `issues.enabled` only for repositories whose issue authors you trust.

## Claude Code plugin

[`plugin/`](plugin) is a Claude Code plugin for working foreman tasks
interactively:

- **Subagents** `planner` (opus, read-only), `coder` (sonnet) and `reviewer`
  (opus, read-only). The runner uses these same files as its role prompts, so
  editing them changes both.
- **`/foreman <task-id | description>`**: plan, implement, run the checks and
  review, without committing or pushing.
- **Hooks:**
  - `PreToolUse` blocks edits to protected paths, force pushes, pushes to the
    base branch, and `gh pr merge`.
  - `Stop` runs the checks from `foreman.config.yaml` when the tree has
    changes, and keeps Claude working while they fail. It's capped at
    `FOREMAN_MAX_STOP_RETRIES` (default 3) and can be disabled with
    `FOREMAN_PLUGIN_CHECKS=0`.

Install it from this repository's marketplace:

```
/plugin marketplace add OWNER/foreman
/plugin install foreman@foreman
```

You can also load it for one session with `claude --plugin-dir ./plugin`.

## State, reports and logs

Everything lives in `.foreman/`. `init` git-ignores it, and the runner also
adds it to `.git/info/exclude`.

| Path | Contents |
|---|---|
| `state.json` (+ `.bak`) | Per-task status, attempts, history, cost, PR links; daily spend; runs. Written atomically. |
| `reports/run-<id>.md` / `.json` | Run report. `latest.md` and `latest.json` point at the newest run. |
| `logs/foreman.log` | Runner log |
| `logs/<run-id>/<task>.log` | Full prompts, tool calls and results for each task |
| `worktrees/` | Task worktrees, removed after each task unless `--keep-worktrees` is set |
| `lock` | Process lock |

## Development

```bash
npm install
npm test            # vitest: loop, safety gate, stuck detector, state, git (real temp repos), CLI, plugin hooks
npm run typecheck
npm run build
node dist/cli.js --help
```

Layout:
- `src/loop.ts`: the per-task state machine
- `src/orchestrator.ts`: queue handling and `watch`
- `src/claude.ts`: Agent SDK runner and tool guard wiring
- `src/safety.ts`: protected paths and the diff gate
- `src/git.ts`, `src/github.ts`: the git and GitHub layer
- `src/state.ts`: persistence

Tests mock Claude and GitHub. git runs for real against temporary
repositories.

## License

MIT
