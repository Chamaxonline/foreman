import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DetectedProject {
  kind: string;
  checks: Array<{ name: string; run: string }>;
}

/** Best-effort guess of the project's check commands for `foreman init`. */
export function detectProject(dir: string): DetectedProject {
  const has = (f: string) => existsSync(path.join(dir, f));
  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      /* ignore */
    }
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const runScript = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : `${pm} ${s === "test" ? "test" : `run ${s}`}`);
    const checks: Array<{ name: string; run: string }> = [];
    if (scripts.build) checks.push({ name: "build", run: runScript("build") });
    else if (scripts.typecheck) checks.push({ name: "typecheck", run: runScript("typecheck") });
    if (scripts.lint) checks.push({ name: "lint", run: runScript("lint") });
    if (scripts.test) checks.push({ name: "test", run: runScript("test") });
    if (!checks.length) checks.push({ name: "test", run: "npm test" });
    return { kind: `node (${pm})`, checks };
  }
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const checks = [{ name: "test", run: "python -m pytest -q" }];
    const py = has("pyproject.toml") ? readFileSync(path.join(dir, "pyproject.toml"), "utf8") : "";
    if (/\[tool\.ruff/.test(py) || has("ruff.toml")) checks.unshift({ name: "lint", run: "ruff check ." });
    return { kind: "python", checks };
  }
  if (has("go.mod")) {
    return { kind: "go", checks: [{ name: "build", run: "go build ./..." }, { name: "vet", run: "go vet ./..." }, { name: "test", run: "go test ./..." }] };
  }
  if (has("Cargo.toml")) {
    return {
      kind: "rust",
      checks: [
        { name: "build", run: "cargo build --all-targets" },
        { name: "lint", run: "cargo clippy --all-targets -- -D warnings" },
        { name: "test", run: "cargo test" },
      ],
    };
  }
  if (has("Makefile")) return { kind: "make", checks: [{ name: "test", run: "make test" }] };
  return { kind: "unknown", checks: [{ name: "test", run: "echo 'configure your checks in foreman.config.yaml' && exit 1" }] };
}

export function configTemplate(p: DetectedProject, baseBranch = "main"): string {
  const checks = p.checks.map((c) => `  ${c.name}: ${JSON.stringify(c.run)}`).join("\n");
  return `# foreman configuration (https://www.npmjs.com/package/claude-foreman)
# Detected project type: ${p.kind}. Review the check commands below.

# owner/name; inferred from the "origin" remote when omitted
# repo: your-org/your-repo
baseBranch: ${baseBranch}
tasksFile: tasks.yaml

# Commands the RUNNER executes, in order, after each coding attempt.
# A task only ships when all of them exit 0. Agents can never edit these
# commands or the files that define them.
checks:
${checks}

# Default model per role. Aliases (opus, sonnet, haiku) or full model IDs.
models:
  planner: opus      # turns the task into a plan (read-only)
  coder: sonnet      # implements the plan
  reviewer: opus     # optional review after checks pass (read-only)
  escalation: opus   # coder model after repeated failures

limits:
  maxAttemptsPerTask: 5
  escalateAfterFailures: 2   # switch coder to the escalation model after N failed attempts
  stuckThreshold: 3          # stop early when the same error repeats N times
  maxMinutesPerTask: 45
  # maxSpendPerTaskUsd: 10
  maxSpendPerRunUsd: 25
  maxSpendPerDayUsd: 100
  checkTimeoutMinutes: 15

review:
  enabled: true
  maxRounds: 1

ci:
  wait: false          # wait for GitHub CI on the PR and feed failures back
  timeoutMinutes: 30

pr:
  labels: [foreman]
  needsHumanLabel: needs-human
  draft: false

issues:
  enabled: false       # also take tasks from open issues with this label
  label: foreman

watch:
  pollSeconds: 300

agent:
  # auto: CLAUDE_CODE_OAUTH_TOKEN (subscription, from \`claude setup-token\`) if set,
  #       else ANTHROPIC_API_KEY (billed per use). Or force: subscription | api-key
  auth: auto
  rateLimitWaitMinutes: 30   # pause after a usage limit when the reset time is unknown
  allowBash: true      # coder may run the check commands above (nothing else)
  sandbox: true
  extraAllowedCommands: []
  envPassthrough: []

# Let tasks be given as a bare \`prompt:\` instead of a full title/description/
# acceptance list (see tasks.yaml). When enabled, foreman writes a story doc
# under docs.dir before planning (or updates it if one already exists and is
# missing something), and plans and codes from that doc. The analyst agent
# that writes it may only touch files inside docs.dir.
docs:
  enabled: false
  dir: docs/stories

# Extra paths agents may never modify (CI, test/lint config, foreman files are always protected)
protectedPaths: []
`;
}

export const TASKS_TEMPLATE = `# foreman task queue. Tasks run highest priority first.
# Each task becomes a branch foreman/<id> and a pull request.
tasks:
  - id: example-readme-badge
    title: Add a "Built with foreman" section to the README
    description: |
      Add a short section at the end of README.md explaining that some PRs in
      this repository are opened automatically by foreman and must be reviewed
      by a human before merging.
    acceptance:
      - README.md ends with a "Built with foreman" section
      - The section says automated PRs are always reviewed by a human
    priority: low
    # model: opus            # optional coder model override
    # files: [README.md]     # optional hint: where to look first

  # A task can also be given as just a free-text ask, with no title or
  # acceptance list written out. With \`docs.enabled: true\` in
  # foreman.config.yaml, foreman turns this into a story doc under
  # docs.dir before planning (or reconciles it against one that's already
  # there), and plans and codes from that doc.
  # - id: faster-login
  #   prompt: The login page feels slow on mobile. Make it noticeably faster.
`;
