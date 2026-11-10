import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("applies defaults and normalizes map-form checks", () => {
    const cfg = parseConfig(`
checks:
  build: npm run build
  test: npm test
`);
    expect(cfg.baseBranch).toBe("main");
    expect(cfg.checks).toEqual([
      { name: "build", run: "npm run build" },
      { name: "test", run: "npm test" },
    ]);
    expect(cfg.models).toEqual({
      planner: "opus",
      coder: "sonnet",
      reviewer: "opus",
      escalation: "opus",
      analyst: "opus",
    });
    expect(cfg.docs).toEqual({ enabled: false, dir: "docs/stories" });
    expect(cfg.limits.maxAttemptsPerTask).toBe(5);
    expect(cfg.limits.escalateAfterFailures).toBe(2);
    expect(cfg.limits.stuckThreshold).toBe(3);
    expect(cfg.pr.needsHumanLabel).toBe("needs-human");
    expect(cfg.review.enabled).toBe(true);
    expect(cfg.ci.wait).toBe(false);
  });

  it("accepts list-form checks with timeouts and overrides", () => {
    const cfg = parseConfig(`
repo: acme/widgets
baseBranch: develop
checks:
  - { name: test, run: pytest -q, timeoutMinutes: 5 }
models: { coder: haiku }
limits: { maxAttemptsPerTask: 3, maxSpendPerDayUsd: 10 }
pr: { labels: [bot, foreman] }
`);
    expect(cfg.repo).toBe("acme/widgets");
    expect(cfg.baseBranch).toBe("develop");
    expect(cfg.checks[0]).toEqual({ name: "test", run: "pytest -q", timeoutMinutes: 5 });
    expect(cfg.models.coder).toBe("haiku");
    expect(cfg.models.planner).toBe("opus");
    expect(cfg.limits.maxAttemptsPerTask).toBe(3);
    expect(cfg.limits.maxSpendPerDayUsd).toBe(10);
    expect(cfg.pr.labels).toEqual(["bot", "foreman"]);
  });

  it("rejects missing checks", () => {
    expect(() => parseConfig(`baseBranch: main`)).toThrow(ConfigError);
    expect(() => parseConfig(`checks: {}`)).toThrow(/at least one check/);
  });

  it("rejects bad values with a path in the message", () => {
    expect(() => parseConfig(`checks: { t: x }\nlimits: { maxAttemptsPerTask: 0 }`)).toThrow(
      /limits\.maxAttemptsPerTask/,
    );
    expect(() => parseConfig(`checks: { t: x }\nrepo: "not a repo"`)).toThrow(/owner\/name/);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseConfig(`checks: [`)).toThrow(/invalid YAML/);
  });

  it("accepts docs and analyst model overrides", () => {
    const cfg = parseConfig(`
checks: { test: npm test }
docs: { enabled: true, dir: notes/stories }
models: { analyst: haiku }
`);
    expect(cfg.docs).toEqual({ enabled: true, dir: "notes/stories" });
    expect(cfg.models.analyst).toBe("haiku");
  });
});
