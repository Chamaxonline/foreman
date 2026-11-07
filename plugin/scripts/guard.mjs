#!/usr/bin/env node
// PreToolUse hook: block edits to protected paths and destructive git commands.
// Exit 2 = block the tool call; stderr is shown to Claude as the reason.
import path from "node:path";
import { protectedMatcher, readForemanConfig, readStdinJson } from "./lib.mjs";

const input = await readStdinJson();
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const tool = input.tool_name ?? "";
const ti = input.tool_input ?? {};

function block(reason) {
  process.stderr.write(`foreman: ${reason}\n`);
  process.exit(2);
}

if (tool === "Bash") {
  const cmd = String(ti.command ?? "");
  if (/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S|\s--mirror\b|\s--delete\b)/.test(cmd)) {
    block("force pushes, deletes and mirror pushes are not allowed.");
  }
  const cfg = readForemanConfig(projectDir);
  const base = process.env.FOREMAN_BASE_BRANCH || "main";
  if (cfg && new RegExp(`\\bgit\\s+push\\b[^\\n]*\\s(?:\\S+:)?(?:refs/heads/)?(${base}|master|main)(\\s|$)`).test(cmd)) {
    block(`pushing to the base branch is not allowed; foreman work goes through foreman/* branches and PRs.`);
  }
  if (
    /\bgh\s+pr\s+merge\b|\bgit\s+merge\b[^\n]*\borigin\/(main|master)\b.*&&.*push/.test(cmd) ||
    /\baz\s+repos\s+pr\s+(update|create)\b[^\n]*(--status\s+completed|--auto-complete\s+(true|yes|on))/i.test(cmd)
  ) {
    block("merging (or auto-completing) PRs is not allowed; a human merges foreman PRs.");
  }
  process.exit(0);
}

const file = ti.file_path ?? ti.notebook_path;
if (typeof file !== "string" || !file) process.exit(0);
const abs = path.resolve(projectDir, file);
const rel = path.relative(projectDir, abs);
if (rel.startsWith("..") || path.isAbsolute(rel)) process.exit(0); // outside the project: not ours to judge

const cfg = readForemanConfig(projectDir);
if (!cfg) process.exit(0); // not a foreman project
if (protectedMatcher(cfg)(rel)) {
  block(`${rel.replace(/\\/g, "/")} is protected (CI, test/lint config, or foreman config). Change the code, not the checks.`);
}
process.exit(0);
