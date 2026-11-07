import type { ForemanConfig } from "./config.js";
import type { ChangedFile } from "./git.js";
import { makeMatcher } from "./glob.js";
import type { DiffGate, FileReader, GateResult, GateViolation } from "./loop.js";

/**
 * Paths agents may never modify: CI, test-runner, lint/format/type-check
 * config, git hooks, and foreman's own files. Users can add more via
 * `protectedPaths`; they cannot remove these.
 */
export const BUILTIN_PROTECTED = [
  // foreman
  "/foreman.config.yaml",
  "/foreman.config.yml",
  "/.foreman/**",
  // CI
  "/.github/**",
  "/.gitlab-ci.yml",
  "/.gitlab/**",
  "/.circleci/**",
  "/.buildkite/**",
  "azure-pipelines*.yml",
  "azure-pipelines*.yaml",
  "/.azuredevops/**",
  "/.pipelines/**",
  "/bitbucket-pipelines.yml",
  "/.travis.yml",
  "/Jenkinsfile",
  "/.drone.yml",
  // git hooks & tooling
  "/.git/**",
  "/.husky/**",
  "/.pre-commit-config.yaml",
  "lefthook.yml",
  "/.gitattributes",
  // JS/TS test runners
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
  // lint / format / type-check
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
  // Python
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
  // other ecosystems
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

/** Files that define how a check command behaves, inferred from the command. */
export function checkDefinitionFiles(commands: string[]): string[] {
  const out = new Set<string>();
  for (const cmd of commands) {
    const words = cmd.split(/\s+|&&|\|\||;/).filter(Boolean);
    for (const w of words) {
      if (/^(make|gmake)$/.test(w)) ["/Makefile", "/makefile", "/GNUmakefile", "*.mk"].forEach((f) => out.add(f));
      if (w === "just") out.add("/justfile").add("/Justfile");
      if (w === "task") out.add("/Taskfile.y*ml");
      if (w === "tox") out.add("/tox.ini");
      if (w === "nox") out.add("/noxfile.py");
      if (w === "turbo") out.add("/turbo.json");
      if (w === "nx") out.add("/nx.json");
      if (w === "rake") out.add("/Rakefile");
      if (w === "gradle" || w === "./gradlew") out.add("*.gradle").add("*.gradle.kts");
      if (w === "mvn" || w === "./mvnw") out.add("pom.xml");
      // script paths: ./scripts/test.sh, scripts/ci.py, bin/check
      const m = w.match(/^(?:\.\/)?([\w.-]+(?:\/[\w.-]+)+|[\w.-]+\.(?:sh|bash|ps1|py|js|mjs|ts|rb|pl))$/);
      if (m?.[1] && !m[1].startsWith("-")) out.add(`/${m[1]}`);
    }
  }
  return [...out];
}

export function protectedGlobs(cfg: ForemanConfig): string[] {
  return [
    ...BUILTIN_PROTECTED,
    `/${cfg.tasksFile.replace(/^\.\//, "")}`,
    ...checkDefinitionFiles(cfg.checks.map((c) => c.run)),
    ...cfg.protectedPaths,
  ];
}

export function makeProtectedMatcher(cfg: ForemanConfig): (relPath: string) => boolean {
  return makeMatcher(protectedGlobs(cfg));
}

// ---- tests ------------------------------------------------------------------

export const TEST_FILE_GLOBS = [
  "*.test.*",
  "*.spec.*",
  "*_test.*",
  "*_spec.*",
  "test_*.py",
  "*Test.java",
  "*Tests.java",
  "*Test.kt",
  "*Tests.cs",
  "*Test.php",
  "**/__tests__/**",
  "**/tests/**",
  "**/test/**",
  "**/spec/**",
  "**/e2e/**",
];
export const isTestFile = makeMatcher(TEST_FILE_GLOBS);

/** Added lines matching these disable, skip, or focus tests. */
export const SKIP_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:it|test|describe|context|suite|bench)\s*\.\s*(?:skip|only|todo|skipIf|runIf|fixme)\b/, "skips or focuses tests (.skip/.only/.todo)"],
  [/\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe|fcontext)\s*\(/, "skips or focuses tests (xit/fit/xdescribe)"],
  [/@pytest\.mark\.(?:skip|skipif|xfail)\b/, "skips tests (@pytest.mark.skip/xfail)"],
  [/\bpytest\.(?:skip|xfail)\s*\(/, "skips tests (pytest.skip)"],
  [/\bunittest\.skip|@skip(?:If|Unless)?\b/, "skips tests (unittest.skip)"],
  [/\bt\.Skip(?:Now|f)?\s*\(/, "skips tests (t.Skip)"],
  [/#\[ignore\]/, "ignores tests (#[ignore])"],
  [/@(?:Disabled|Ignore)\b/, "disables tests (@Disabled/@Ignore)"],
  [/\[(?:Fact|Theory|Test)\s*\(\s*Skip\s*=/, "skips tests (Skip=)"],
  [/\[Ignore\b/, "ignores tests ([Ignore])"],
  [/\bmarkTestSkipped\s*\(|\$this->markTestIncomplete/, "skips tests (PHPUnit)"],
  [/--passWithNoTests|--testPathIgnorePatterns|--exclude\b|--deselect\b|--ignore=/, "excludes tests via runner flags"],
];

/** Lines that declare a test case, for counting removals. */
const TEST_DECL = [
  /\b(?:it|test)\s*(?:\.\s*(?:each|concurrent|sequential)\s*(?:\([^)]*\)|`[^`]*`)\s*)?\(\s*['"`]/,
  /^\s*(?:async\s+)?def\s+test_?\w*\s*\(/,
  /^\s*func\s+Test\w*\s*\(/,
  /#\[(?:tokio::)?test\]/,
  /@Test\b/,
  /\[(?:Fact|Theory|Test|TestMethod)\]/,
  /^\s*(?:public\s+)?function\s+test\w+\s*\(/,
];

export function countTestDecls(lines: string[]): number {
  return lines.filter((l) => TEST_DECL.some((r) => r.test(l))).length;
}

export interface FileDiff {
  added: string[];
  removed: string[];
}

/** Parse a unified diff into added/removed lines per (new) path. */
export function parseUnifiedDiff(diff: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let cur: FileDiff | undefined;
  let oldPath: string | undefined;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = undefined;
      oldPath = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = stripPrefix(line.slice(4));
      const key = newPath ?? oldPath;
      if (key) {
        cur = files.get(key) ?? { added: [], removed: [] };
        files.set(key, cur);
      }
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

function stripPrefix(p: string): string | undefined {
  const t = p.trim().replace(/^"|"$/g, "");
  if (t === "/dev/null") return undefined;
  return t.replace(/^[ab]\//, "");
}

/** package.json keys that configure checks, scripts and tooling. */
const PKG_PROTECTED_KEYS = [
  "scripts", "jest", "eslintConfig", "prettier", "stylelint", "ava", "mocha", "c8", "nyc",
  "husky", "lint-staged", "simple-git-hooks", "pre-commit", "vitest", "xo", "standard",
];
const PYPROJECT_PROTECTED = /^\[tool\.(?:pytest|ruff|mypy|coverage|black|isort|pylint|flake8|pyright|tox|hatch\.envs|poe|nox)/;

/**
 * Diff gate enforced by the runner before any commit:
 *  - no changes to protected paths (and no renames out of them)
 *  - no deleted test files, no net loss of test cases
 *  - no added skip/only/ignore markers
 *  - no changes to check/tooling sections of package.json / pyproject.toml
 */
export class SafetyGate implements DiffGate {
  constructor(private readonly isProtected: (p: string) => boolean) {}

  async inspect(changes: ChangedFile[], diff: string, reader?: FileReader): Promise<GateResult> {
    const v: GateViolation[] = [];
    const add = (path: string, reason: string) => v.push({ path, reason });
    const perFile = parseUnifiedDiff(diff);

    let removedTests = 0;
    let addedTests = 0;

    for (const c of changes) {
      const paths = [c.path, ...(c.oldPath ? [c.oldPath] : [])];
      for (const p of paths) {
        if (this.isProtected(p)) add(c.path, `modifies protected path ${p}`);
      }
      if (c.status === "D" && isTestFile(c.path)) add(c.path, "deletes a test file");
      if (c.status === "R" && c.oldPath && isTestFile(c.oldPath) && !isTestFile(c.path)) {
        add(c.path, `moves test file ${c.oldPath} out of the test suite`);
      }

      const fd = perFile.get(c.path) ?? (c.oldPath ? perFile.get(c.oldPath) : undefined);
      if (fd) {
        if (isTestFile(c.path) || (c.oldPath && isTestFile(c.oldPath))) {
          removedTests += countTestDecls(fd.removed);
          addedTests += countTestDecls(fd.added);
        }
        for (const line of fd.added) {
          const hit = SKIP_PATTERNS.find(([re]) => re.test(line));
          if (hit && !isComment(line)) {
            add(c.path, `${hit[1]}: \`${line.trim().slice(0, 120)}\``);
            break;
          }
        }
      }
      if (reader && c.status !== "D") {
        const base = c.path.split("/").pop()!.toLowerCase();
        if (base === "package.json") {
          const key = await changedPackageKeys(reader, c.oldPath ?? c.path, c.path);
          if (key.length) add(c.path, `modifies protected package.json fields: ${key.join(", ")}`);
        }
        if (base === "pyproject.toml") {
          const secs = await changedPyprojectSections(reader, c.oldPath ?? c.path, c.path);
          if (secs.length) add(c.path, `modifies protected pyproject.toml sections: ${secs.join(", ")}`);
        }
      }
    }

    if (removedTests > addedTests) {
      v.push({
        path: "(tests)",
        reason: `removes ${removedTests - addedTests} test case(s) (${removedTests} removed, ${addedTests} added)`,
      });
    }
    return { ok: v.length === 0, violations: dedupe(v) };
  }
}

async function changedPackageKeys(reader: FileReader, beforePath: string, afterPath: string): Promise<string[]> {
    const parse = (s: string | undefined): Record<string, unknown> => {
      try {
        return s ? (JSON.parse(s) as Record<string, unknown>) : {};
      } catch {
        return { __unparseable__: s };
      }
    };
    const before = parse(await reader.before(beforePath));
    const after = parse(await reader.after(afterPath));
    if ("__unparseable__" in after) return ["(invalid JSON)"];
    return PKG_PROTECTED_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

async function changedPyprojectSections(reader: FileReader, beforePath: string, afterPath: string): Promise<string[]> {
    const sections = (s: string | undefined): Map<string, string> => {
      const out = new Map<string, string>();
      let cur = "";
      for (const line of (s ?? "").replace(/\r\n/g, "\n").split("\n")) {
        const h = line.match(/^\s*(\[[^\]]+\]\]?)\s*$/);
        if (h) cur = h[1]!;
        if (PYPROJECT_PROTECTED.test(cur)) out.set(cur, (out.get(cur) ?? "") + line.trim() + "\n");
      }
      return out;
    };
    const a = sections(await reader.before(beforePath));
    const b = sections(await reader.after(afterPath));
    const keys = new Set([...a.keys(), ...b.keys()]);
    return [...keys].filter((k) => a.get(k) !== b.get(k));
}

/** Whole-line comments (e.g. "// never use it.only") are not skip directives. `#[ignore]` is a Rust attribute, not a comment. */
function isComment(line: string): boolean {
  return /^(\/\/|#(?!\[)|\*|\/\*)/.test(line.trim());
}

function dedupe(v: GateViolation[]): GateViolation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.path}\0${x.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
