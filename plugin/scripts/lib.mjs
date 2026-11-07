// Shared helpers for foreman's Claude Code plugin hooks.
// Dependency-free on purpose: a marketplace-installed plugin has no node_modules.
// BUILTIN_PROTECTED must stay in sync with src/safety.ts (a test enforces this).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const BUILTIN_PROTECTED = [
  "/foreman.config.yaml",
  "/foreman.config.yml",
  "/.foreman/**",
  "/.github/**",
  "/.gitlab-ci.yml",
  "/.gitlab/**",
  "/.circleci/**",
  "/.buildkite/**",
  "/azure-pipelines.yml",
  "/bitbucket-pipelines.yml",
  "/.travis.yml",
  "/Jenkinsfile",
  "/.drone.yml",
  "/.git/**",
  "/.husky/**",
  "/.pre-commit-config.yaml",
  "lefthook.yml",
  "/.gitattributes",
  "vitest.config.*",
  "vitest.workspace.*",
  "vite.config.*",
  "jest.config.*",
  "jest.setup.*",
  "karma.conf.*",
  "playwright.config.*",
  "cypress.config.*",
  ".mocharc*",
  "ava.config.*",
  ".c8rc*",
  ".nycrc*",
  ".eslintrc*",
  "eslint.config.*",
  ".eslintignore",
  ".prettierrc*",
  "prettier.config.*",
  ".prettierignore",
  ".stylelintrc*",
  "biome.json",
  "biome.jsonc",
  "tsconfig*.json",
  "jsconfig*.json",
  "pytest.ini",
  "/conftest.py",
  "tox.ini",
  "noxfile.py",
  "setup.cfg",
  ".flake8",
  ".pylintrc",
  "mypy.ini",
  ".mypy.ini",
  "ruff.toml",
  ".ruff.toml",
  ".coveragerc",
  ".golangci.y*ml",
  ".rubocop.yml",
  ".rspec",
  "phpunit.xml*",
  "phpstan.neon*",
  "rustfmt.toml",
  ".rustfmt.toml",
  "clippy.toml",
  ".clippy.toml",
  "Directory.Build.props",
  ".editorconfig",
];

/** Same semantics as src/glob.ts. */
export function globToRegExp(glob) {
  let g = glob.trim().replace(/\\/g, "/");
  if (g.startsWith("/")) g = g.slice(1);
  else if (!g.includes("/") || g.startsWith("**/")) g = g.startsWith("**/") ? g : `**/${g}`;
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      const alts = g.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
      re += `(?:${alts.join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * Minimal reader for the parts of foreman.config.yaml the hooks need:
 * `checks` (map or list form), `protectedPaths`, `tasksFile`.
 * Not a general YAML parser; `foreman run` uses a real one.
 */
export function readForemanConfig(projectDir) {
  const file = ["foreman.config.yaml", "foreman.config.yml"].map((f) => path.join(projectDir, f)).find(existsSync);
  if (!file) return undefined;
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  const cfg = { checks: [], protectedPaths: [], tasksFile: "tasks.yaml" };
  const unq = (s) => {
    let t = s.trim();
    if (t.startsWith('"')) {
      const m = t.match(/^"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try {
          return JSON.parse(`"${m[1]}"`);
        } catch {
          return m[1];
        }
      }
    }
    if (t.startsWith("'")) {
      const m = t.match(/^'((?:[^']|'')*)'/);
      if (m) return m[1].replace(/''/g, "'");
    }
    return t.replace(/\s+#.*$/, "");
  };
  let section = "";
  let pendingName;
  for (const raw of lines) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const top = raw.match(/^([A-Za-z]\w*):\s*(.*)$/);
    if (top) {
      section = top[1];
      const val = top[2].trim();
      if (section === "tasksFile" && val) cfg.tasksFile = unq(val);
      if (section === "protectedPaths" && val.startsWith("[")) {
        cfg.protectedPaths = val.slice(1, val.lastIndexOf("]")).split(",").map(unq).filter(Boolean);
      }
      continue;
    }
    if (section === "checks") {
      const inline = raw.match(/^\s*-\s*\{\s*(.*)\}\s*$/);
      if (inline) {
        const name = inline[1].match(/name:\s*([^,}]+)/)?.[1];
        const run = inline[1].match(/run:\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,}]+)/)?.[1];
        if (run) cfg.checks.push({ name: unq(name ?? "check"), run: unq(run) });
        continue;
      }
      const listName = raw.match(/^\s*-\s*name:\s*(.+)$/);
      if (listName) {
        pendingName = unq(listName[1]);
        continue;
      }
      const run = raw.match(/^\s+run:\s*(.+)$/);
      if (run) {
        cfg.checks.push({ name: pendingName ?? "check", run: unq(run[1]) });
        pendingName = undefined;
        continue;
      }
      const kv = raw.match(/^\s+([\w.-]+):\s*(.+)$/);
      if (kv && kv[1] !== "timeoutMinutes" && kv[1] !== "name") cfg.checks.push({ name: kv[1], run: unq(kv[2]) });
    }
    if (section === "protectedPaths") {
      const item = raw.match(/^\s*-\s*(.+)$/);
      if (item) cfg.protectedPaths.push(unq(item[1]));
    }
  }
  return cfg;
}

export function protectedMatcher(cfg) {
  const globs = [...BUILTIN_PROTECTED, `/${(cfg?.tasksFile ?? "tasks.yaml").replace(/^\.\//, "")}`, ...(cfg?.protectedPaths ?? [])];
  const res = globs.map(globToRegExp);
  return (rel) => res.some((r) => r.test(rel.replace(/\\/g, "/").replace(/^\.\//, "")));
}

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
