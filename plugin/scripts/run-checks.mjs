#!/usr/bin/env node
// Stop hook: when the working tree has changes, run the checks from
// foreman.config.yaml. If any fail, exit 2 so Claude keeps working and sees
// the output. Gives up after FOREMAN_MAX_STOP_RETRIES (default 3) blocked
// stops in a session so it can never loop forever.
// Disable with FOREMAN_PLUGIN_CHECKS=0.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readForemanConfig, readStdinJson } from "./lib.mjs";

const input = await readStdinJson();
if (process.env.FOREMAN_PLUGIN_CHECKS === "0") process.exit(0);
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const cfg = readForemanConfig(projectDir);
if (!cfg || cfg.checks.length === 0) process.exit(0);

// Only when something changed.
const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" });
if (status.status !== 0 || !status.stdout.trim()) process.exit(0);

// Loop guard per session.
const max = Number(process.env.FOREMAN_MAX_STOP_RETRIES ?? 3);
const counterDir = path.join(os.tmpdir(), "foreman-plugin");
const counterFile = path.join(counterDir, `${String(input.session_id ?? "nosession").replace(/[^\w-]/g, "")}.json`);
let count = 0;
try {
  count = JSON.parse(readFileSync(counterFile, "utf8")).count ?? 0;
} catch {
  /* first stop */
}

const failures = [];
for (const c of cfg.checks) {
  const r = spawnSync(c.run, { cwd: projectDir, shell: true, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-80).join("\n");
    failures.push(`$ ${c.run}  (exit ${r.status ?? "timeout"})\n${out}`);
    break; // later checks usually depend on earlier ones
  }
}

mkdirSync(counterDir, { recursive: true });
if (!failures.length) {
  writeFileSync(counterFile, JSON.stringify({ count: 0 }));
  process.exit(0);
}
if (count >= max) {
  writeFileSync(counterFile, JSON.stringify({ count: 0 }));
  process.stderr.write(`foreman: checks still failing after ${max} attempts; letting Claude stop.\n`);
  process.exit(0); // non-blocking
}
writeFileSync(counterFile, JSON.stringify({ count: count + 1 }));
process.stderr.write(
  `foreman: project checks failed. Fix the code (do not edit tests or check config) and try again.\n\n${failures.join("\n\n")}\n`,
);
process.exit(2);
