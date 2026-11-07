import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");

describe("action.yml", () => {
  const action = YAML.parse(readFileSync(path.join(root, "action.yml"), "utf8"));
  const text = readFileSync(path.join(root, "action.yml"), "utf8");

  it("is a composite action whose referenced inputs all exist", () => {
    expect(action.runs.using).toBe("composite");
    const used = [...text.matchAll(/inputs\.([\w-]+)/g)].map((m) => m[1]!);
    for (const name of new Set(used)) expect(Object.keys(action.inputs), name).toContain(name);
    // either a subscription token or an API key; the validate step enforces one is present
    expect(action.inputs["claude-oauth-token"]).toBeDefined();
    expect(action.inputs["anthropic-api-key"].required).toBe(false);
    expect(text).toContain("Provide claude-oauth-token (subscription) or anthropic-api-key");
    const run = action.runs.steps.find((s: { id?: string }) => s.id === "foreman");
    expect(run.env.CLAUDE_CODE_OAUTH_TOKEN).toContain("inputs.claude-oauth-token");
  });

  it("runs the built CLI and never exposes the token to agents via GITHUB_TOKEN or git config", () => {
    const run = action.runs.steps.find((s: { id?: string }) => s.id === "foreman");
    expect(run.env.FOREMAN_GITHUB_TOKEN).toContain("inputs.github-token");
    expect(run.env.GITHUB_TOKEN).toBe("");
    expect(text).toContain("--unset-all http.https://github.com/.extraheader");
    expect(text).toMatch(/dist\/cli\.js/);
  });

  it("only allows run and dry-run", () => {
    expect(text).toMatch(/run\|dry-run\)/);
  });
});
