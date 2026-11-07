import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { ChangedFile } from "../src/git.js";
import { globToRegExp, makeMatcher } from "../src/glob.js";
import {
  checkDefinitionFiles,
  countTestDecls,
  isTestFile,
  makeProtectedMatcher,
  parseUnifiedDiff,
  SafetyGate,
} from "../src/safety.js";

const cfg = parseConfig(`
checks:
  build: npm run build
  test: make test
  lint: ./scripts/lint.sh --strict
protectedPaths: ["migrations/**"]
`);
const isProtected = makeProtectedMatcher(cfg);
const gate = new SafetyGate(isProtected);

describe("glob matcher", () => {
  it("supports **, *, ?, braces and basename-anywhere", () => {
    const m = makeMatcher(["vitest.config.*", "/.github/**", "src/**/*.{ts,tsx}", "a?.txt"]);
    expect(m("vitest.config.ts")).toBe(true);
    expect(m("packages/web/vitest.config.mts")).toBe(true);
    expect(m(".github/workflows/ci.yml")).toBe(true);
    expect(m("docs/.github/x")).toBe(false); // anchored
    expect(m("src/x/y.tsx")).toBe(true);
    expect(m("src/y.ts")).toBe(true);
    expect(m("lib/y.ts")).toBe(false);
    expect(m("ab.txt")).toBe(true);
    expect(m("abc.txt")).toBe(false);
  });

  it("is case-insensitive and normalizes separators", () => {
    expect(makeMatcher(["vitest.config.*"])("Vitest.Config.TS")).toBe(true);
    expect(makeMatcher(["/.github/**"])(".github\\workflows\\x.yml")).toBe(true);
    expect(globToRegExp("/a/b/").test("a/b/c")).toBe(true);
  });
});

describe("protected paths", () => {
  it.each([
    "foreman.config.yaml",
    "tasks.yaml",
    ".foreman/state.json",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    "vitest.config.ts",
    "packages/api/jest.config.js",
    "eslint.config.mjs",
    ".eslintrc.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "pytest.ini",
    "conftest.py",
    ".husky/pre-commit",
    ".pre-commit-config.yaml",
    "Makefile", // from `make test`
    "scripts/lint.sh", // from `./scripts/lint.sh`
    "migrations/001.sql", // user-configured
    ".git/hooks/pre-push",
  ])("%s is protected", (p) => {
    expect(isProtected(p)).toBe(true);
  });

  it.each(["src/index.ts", "src/app.test.ts", "README.md", "tests/conftest.py", "package.json", "lib/eslint-helpers.ts"])(
    "%s is not protected",
    (p) => {
      expect(isProtected(p)).toBe(false);
    },
  );

  it("infers check definition files from commands", () => {
    expect(checkDefinitionFiles(["make test", "just lint", "./scripts/ci.sh", "python tools/check.py", "npm test", "tox -e py"])).toEqual(
      expect.arrayContaining(["/Makefile", "/justfile", "/scripts/ci.sh", "/tools/check.py", "/tox.ini"]),
    );
    expect(checkDefinitionFiles(["npm test -- --coverage"])).toEqual([]);
  });
});

describe("test file detection", () => {
  it.each(["src/a.test.ts", "src/a.spec.js", "tests/test_api.py", "pkg/x_test.go", "src/__tests__/x.ts", "test/unit/a.rb", "FooTest.java"])(
    "%s is a test file",
    (p) => expect(isTestFile(p)).toBe(true),
  );
  it.each(["src/testing.ts", "src/contest.ts", "README.md"])("%s is not a test file", (p) => expect(isTestFile(p)).toBe(false));

  it("counts test declarations across languages", () => {
    expect(
      countTestDecls([
        "it('works', () => {",
        'test("adds", async () => {',
        "it.each([1,2])('x %s', () => {",
        "def test_thing(self):",
        "async def test_async():",
        "func TestSum(t *testing.T) {",
        "#[test]",
        "@Test",
        "[Fact]",
        "const x = 1;",
        "describe('suite', () => {",
      ]),
    ).toBe(9);
  });
});

function diffFor(path: string, added: string[], removed: string[] = [], opts: { deleted?: boolean } = {}): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    opts.deleted ? "+++ /dev/null" : `+++ b/${path}`,
    "@@ -1 +1 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

describe("SafetyGate", () => {
  const M = (p: string): ChangedFile => ({ status: "M", path: p });

  it("passes ordinary source and test changes", async () => {
    const changes = [M("src/a.ts"), { status: "A" as const, path: "src/a.test.ts" }];
    const diff = diffFor("src/a.ts", ["export const a = 2;"], ["export const a = 1;"]) + "\n" + diffFor("src/a.test.ts", ["it('a is 2', () => {})"]);
    expect(await gate.inspect(changes, diff)).toEqual({ ok: true, violations: [] });
  });

  it("rejects protected paths, including renames out of them", async () => {
    const r = await gate.inspect(
      [M(".github/workflows/ci.yml"), M("vitest.config.ts"), { status: "R", path: "src/x.ts", oldPath: "eslint.config.js" }],
      "",
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.path)).toEqual([".github/workflows/ci.yml", "vitest.config.ts", "src/x.ts"]);
  });

  it("rejects deleted test files and tests moved out of the suite", async () => {
    const r = await gate.inspect(
      [{ status: "D", path: "src/a.test.ts" }, { status: "R", path: "src/old_b.ts", oldPath: "src/b.test.ts" }],
      diffFor("src/a.test.ts", [], ["it('x', () => {})"], { deleted: true }),
    );
    expect(r.violations.map((v) => v.reason)).toEqual(
      expect.arrayContaining(["deletes a test file", "moves test file src/b.test.ts out of the test suite", expect.stringMatching(/removes 1 test case/)]),
    );
  });

  it("rejects a net loss of test cases within a file", async () => {
    const diff = diffFor("src/a.test.ts", ["it('one', () => {})"], ["it('one', () => {})", "it('two', () => {})", "it('three', () => {})"]);
    const r = await gate.inspect([M("src/a.test.ts")], diff);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.reason).toMatch(/removes 2 test case\(s\)/);
  });

  it("allows moving tests between files", async () => {
    const diff = diffFor("src/a.test.ts", [], ["it('moved', () => {})"]) + "\n" + diffFor("src/b.test.ts", ["it('moved', () => {})"]);
    expect((await gate.inspect([M("src/a.test.ts"), M("src/b.test.ts")], diff)).ok).toBe(true);
  });

  it.each([
    "it.skip('flaky', () => {",
    "describe.only('x', () => {",
    "test.todo('later')",
    "xit('x', () => {",
    "fdescribe('x', () => {",
    "@pytest.mark.skip(reason='slow')",
    "@pytest.mark.xfail",
    "    pytest.skip('nope')",
    "@unittest.skip('x')",
    "\tt.Skip(\"later\")",
    "#[ignore]",
    "@Disabled",
    '[Fact(Skip = "x")]',
    '"test": "vitest --passWithNoTests"',
  ])("rejects added skip marker: %s", async (line) => {
    const r = await gate.inspect([M("src/a.test.ts")], diffFor("src/a.test.ts", [line]));
    expect(r.ok, line).toBe(false);
  });

  it("allows removing skip markers and mentioning them in comments", async () => {
    const diff = diffFor("src/a.test.ts", ["it('fixed', () => {", "// never commit it.only"], ["it.skip('fixed', () => {"]);
    expect((await gate.inspect([M("src/a.test.ts")], diff)).ok).toBe(true);
  });

  it("rejects changes to protected package.json fields but allows dependency changes", async () => {
    const before = JSON.stringify({ name: "x", scripts: { test: "vitest run" }, dependencies: {} });
    const depsOnly = JSON.stringify({ name: "x", scripts: { test: "vitest run" }, dependencies: { zod: "^4" } });
    const scripts = JSON.stringify({ name: "x", scripts: { test: "echo ok" }, dependencies: {} });
    const reader = (after: string) => ({ before: async () => before, after: async () => after });
    expect((await gate.inspect([M("package.json")], "", reader(depsOnly))).ok).toBe(true);
    const r = await gate.inspect([M("package.json")], "", reader(scripts));
    expect(r.violations[0]!.reason).toMatch(/package\.json fields: scripts/);
    expect((await gate.inspect([M("package.json")], "", reader("{ not json"))).ok).toBe(false);
  });

  it("rejects changes to tool sections of pyproject.toml only", async () => {
    const before = '[project]\nname = "x"\ndependencies = []\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
    const okAfter = '[project]\nname = "x"\ndependencies = ["httpx"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
    const badAfter = '[project]\nname = "x"\ndependencies = []\n\n[tool.pytest.ini_options]\naddopts = "-q -k not_slow"\n';
    const reader = (after: string) => ({ before: async () => before, after: async () => after });
    expect((await gate.inspect([M("pyproject.toml")], "", reader(okAfter))).ok).toBe(true);
    const r = await gate.inspect([M("pyproject.toml")], "", reader(badAfter));
    expect(r.violations[0]!.reason).toMatch(/\[tool\.pytest\.ini_options\]/);
  });
});

describe("parseUnifiedDiff", () => {
  it("collects added/removed lines per file, including deletions", () => {
    const d = parseUnifiedDiff(
      [diffFor("a.ts", ["new"], ["old"]), diffFor("gone.test.ts", [], ["it('x')"], { deleted: true })].join("\n"),
    );
    expect(d.get("a.ts")).toEqual({ added: ["new"], removed: ["old"] });
    expect(d.get("gone.test.ts")).toEqual({ added: [], removed: ["it('x')"] });
  });
});
