import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { RenderResult } from "./browser.js";
import type { AgentRunner } from "./claude.js";
import type { ForemanConfig } from "./config.js";
import {
  CRITIQUE_SCHEMA,
  critiqueFeedback,
  critiquePrompt,
  parseCritique,
  type Critique,
  type CritiqueIssue,
} from "./prompts.js";
import { PrototypeError, prototypeLayout, writePrototype } from "./prototype.js";

/** Renders the page and returns the screenshots; the real one drives a headless browser. */
export type Renderer = (htmlFile: string, outDir: string, prefix: string) => Promise<RenderResult>;

export interface CritiqueRequest {
  repoDir: string;
  id: string;
  config: ForemanConfig;
  agents: AgentRunner;
  designerPrompt: string;
  criticPrompt: string;
  isProtected: (relPath: string) => boolean;
  /** Hard USD cap for the whole loop: every critic and designer call together. */
  maxBudgetUsd: number;
  render: Renderer;
  signal?: AbortSignal;
  onEvent?: (line: string) => void;
}

export interface CritiqueRound {
  round: number;
  critique: Critique;
  /** True when the designer was sent back to fix this round's issues. */
  revised: boolean;
  /** Repo-relative paths of the screenshots the critic saw. */
  screens: string[];
}

export interface CritiqueOutcome {
  rounds: CritiqueRound[];
  costUsd: number;
  /** Errors and blocked requests the page logged in the final render. */
  consoleIssues: string[];
  /** Why the loop ended early, when it did. The prototype built so far is kept. */
  stopped?: string;
  /** Repo-relative folder holding the screenshots. */
  screensDir: string;
}

/**
 * Screenshot the prototype, have the critic review it, and send real problems
 * back to the designer, up to `prototype.critique.maxRevisions` times. The
 * last critique always looks at the final version. Never throws: whatever goes
 * wrong, the prototype that exists stays and `stopped` says why the loop ended.
 */
export async function critiqueAndRefine(req: CritiqueRequest): Promise<CritiqueOutcome> {
  const { repoDir, id, config: cfg } = req;
  const layout = prototypeLayout(cfg, id);
  const screensDir = `.foreman/screens/${id}`;
  const screensAbs = path.join(repoDir, screensDir);
  const maxRevisions = cfg.prototype.critique.maxRevisions;
  const story = { path: layout.story, content: (await readFile(path.join(repoDir, layout.story), "utf8").catch(() => "")) ?? "" };

  const rounds: CritiqueRound[] = [];
  let spent = 0;
  let consoleIssues: string[] = [];
  let stopped: string | undefined;
  let previous: CritiqueIssue[] = [];
  const left = () => req.maxBudgetUsd - spent;
  const done = (): CritiqueOutcome => ({ rounds, costUsd: spent, consoleIssues, screensDir, ...(stopped ? { stopped } : {}) });

  await rm(screensAbs, { recursive: true, force: true }).catch(() => undefined);

  for (let revision = 0; revision <= maxRevisions; revision++) {
    const round = revision + 1;
    if (req.signal?.aborted) return ((stopped = "Interrupted."), done());
    if (left() < 0.05) return ((stopped = "The spend limit was reached."), done());

    let rendered: RenderResult;
    try {
      rendered = await req.render(path.join(repoDir, layout.index), screensAbs, `r${round}`);
    } catch (e) {
      return ((stopped = `Could not render the prototype: ${(e as Error).message}`), done());
    }
    consoleIssues = rendered.consoleIssues;
    const shots = rendered.screens.map((s) => ({
      file: s.file,
      path: `${screensDir}/${path.basename(s.file)}`,
      description: s.viewport.description,
    }));

    let critique: Critique | undefined;
    try {
      const r = await req.agents.run({
        role: "critic",
        model: cfg.models.critic,
        systemPrompt: req.criticPrompt,
        prompt: critiquePrompt(story, shots, round, consoleIssues, previous),
        cwd: repoDir,
        readOnly: true,
        allowBash: false,
        allowedCommands: [],
        isProtected: req.isProtected,
        maxTurns: cfg.limits.maxTurnsPerCall,
        maxBudgetUsd: left(),
        signal: req.signal ?? new AbortController().signal,
        outputSchema: CRITIQUE_SCHEMA as unknown as Record<string, unknown>,
        ...(req.onEvent ? { onEvent: req.onEvent } : {}),
      });
      spent += r.costUsd;
      if (r.subtype === "rate_limited") return ((stopped = "Claude usage limit reached."), done());
      if (r.subtype === "exception") return ((stopped = `The critic call failed: ${r.error ?? "unknown error"}`), done());
      critique = r.ok ? parseCritique(r.structured, r.text) : undefined;
    } catch (e) {
      return ((stopped = `The critic call failed: ${(e as Error).message}`), done());
    }
    if (!critique) return ((stopped = "The critic gave no usable verdict."), done());
    if (!critique.sawScreenshots) {
      return (
        (stopped =
          "The critic could not view the screenshots, so the design was not reviewed. " +
          `Open them yourself in ${screensDir}/, or set prototype.critique.enabled to false.`),
        done()
      );
    }

    // "revise" with nothing actionable is an approval.
    const needsWork = critique.verdict === "revise" && critique.issues.length > 0;
    const shotPaths = shots.map((s) => s.path);
    if (!needsWork || revision === maxRevisions) {
      rounds.push({ round, critique, revised: false, screens: shotPaths });
      return done();
    }

    if (left() < 0.05) {
      rounds.push({ round, critique, revised: false, screens: shotPaths });
      return ((stopped = "The spend limit was reached before the designer could fix the issues."), done());
    }

    try {
      const rev = await writePrototype({
        repoDir,
        id,
        feedback: critiqueFeedback(critique),
        config: cfg,
        agents: req.agents,
        systemPrompt: req.designerPrompt,
        isProtected: req.isProtected,
        maxBudgetUsd: left(),
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.onEvent ? { onEvent: req.onEvent } : {}),
      });
      spent += rev.costUsd;
    } catch (e) {
      if (e instanceof PrototypeError) spent += e.costUsd;
      rounds.push({ round, critique, revised: false, screens: shotPaths });
      return ((stopped = `The designer's fix did not go through: ${(e as Error).message}`), done());
    }
    rounds.push({ round, critique, revised: true, screens: shotPaths });
    previous = critique.issues;
  }
  return done();
}
