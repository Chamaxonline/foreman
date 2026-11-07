import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const CONFIG_FILE = "foreman.config.yaml";

const checkSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  timeoutMinutes: z.number().positive().optional(),
});

/**
 * Checks may be written as a map (`build: npm run build`) or as a list of
 * `{ name, run, timeoutMinutes }` objects. Both normalize to the list form.
 * Order is preserved: checks run in the order they are declared.
 */
const checksSchema = z
  .union([z.record(z.string(), z.string().min(1)), z.array(checkSchema)])
  .transform((v) =>
    Array.isArray(v) ? v : Object.entries(v).map(([name, run]) => ({ name, run })),
  )
  .refine((v) => v.length > 0, "at least one check command is required");

const modelsSchema = z
  .object({
    planner: z.string().default("opus"),
    coder: z.string().default("sonnet"),
    reviewer: z.string().default("opus"),
    /** Model the coder is switched to after `limits.escalateAfterFailures` failures. */
    escalation: z.string().default("opus"),
  })
  .prefault({});

const limitsSchema = z
  .object({
    maxAttemptsPerTask: z.number().int().min(1).max(50).default(5),
    escalateAfterFailures: z.number().int().min(1).default(2),
    stuckThreshold: z.number().int().min(2).default(3),
    maxMinutesPerTask: z.number().positive().default(45),
    maxSpendPerTaskUsd: z.number().positive().optional(),
    maxSpendPerRunUsd: z.number().positive().default(25),
    maxSpendPerDayUsd: z.number().positive().default(100),
    checkTimeoutMinutes: z.number().positive().default(15),
    /** Max agent turns per single Claude invocation. */
    maxTurnsPerCall: z.number().int().positive().default(80),
  })
  .prefault({});

const reviewSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** How many times the reviewer may send work back to the coder. */
    maxRounds: z.number().int().min(0).default(1),
  })
  .prefault({});

const ciSchema = z
  .object({
    wait: z.boolean().default(false),
    timeoutMinutes: z.number().positive().default(30),
    pollSeconds: z.number().positive().default(30),
  })
  .prefault({});

const prSchema = z
  .object({
    labels: z.array(z.string()).default(["foreman"]),
    needsHumanLabel: z.string().default("needs-human"),
    draft: z.boolean().default(false),
  })
  .prefault({});

const issuesSchema = z
  .object({
    enabled: z.boolean().default(false),
    label: z.string().default("foreman"),
  })
  .prefault({});

const watchSchema = z
  .object({
    pollSeconds: z.number().positive().default(300),
  })
  .prefault({});

const agentSchema = z
  .object({
    /**
     * Which Claude credential agents use:
     *  - auto (default): CLAUDE_CODE_OAUTH_TOKEN if set, else ANTHROPIC_API_KEY, else stored `claude login`
     *  - subscription: Claude Pro/Max/Team/Enterprise via CLAUDE_CODE_OAUTH_TOKEN (or `claude login`)
     *  - api-key: ANTHROPIC_API_KEY, billed per use in the Claude Console
     */
    auth: z.enum(["auto", "subscription", "api-key"]).default("auto"),
    /** Minutes to wait after a usage limit when the reset time is unknown. */
    rateLimitWaitMinutes: z.number().positive().default(30),
    /**
     * Allow the coder to run Bash commands. Even when enabled, Bash is limited to
     * the configured check commands plus read-only git and file listing commands.
     */
    allowBash: z.boolean().default(true),
    /** Extra command prefixes the coder may run via Bash (e.g. "npx tsc --noEmit"). */
    extraAllowedCommands: z.array(z.string()).default([]),
    /** Use Claude Code's OS-level Bash sandbox where the platform supports it. */
    sandbox: z.boolean().default(true),
    /**
     * Extra environment variables passed to agents (e.g. for Bedrock/Vertex).
     * GitHub/npm tokens and deploy credentials are always stripped.
     */
    envPassthrough: z.array(z.string()).default([]),
  })
  .prefault({});

const azureSchema = z
  .object({
    /** https://dev.azure.com/<org> (or an Azure DevOps Server collection URL). Inferred from the remote when omitted. */
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    /** How to send the token: PAT (Basic) or bearer (System.AccessToken / Entra ID). auto: SYSTEM_ACCESSTOKEN → bearer, else PAT. */
    tokenType: z.enum(["auto", "pat", "bearer"]).default("auto"),
  })
  .prefault({});

export const configSchema = z.object({
  /** Where PRs are opened. auto: detected from the remote URL. */
  provider: z.enum(["auto", "github", "azure-devops"]).default("auto"),
  azureDevOps: azureSchema,
  /** GitHub owner/name. Inferred from the `origin` remote when omitted. */
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "repo must look like owner/name")
    .optional(),
  baseBranch: z.string().min(1).default("main"),
  remote: z.string().min(1).default("origin"),
  tasksFile: z.string().default("tasks.yaml"),
  checks: checksSchema,
  models: modelsSchema,
  limits: limitsSchema,
  review: reviewSchema,
  ci: ciSchema,
  pr: prSchema,
  issues: issuesSchema,
  watch: watchSchema,
  agent: agentSchema,
  /** Extra globs agents may never modify, on top of the built-in protected set. */
  protectedPaths: z.array(z.string()).default([]),
  /** "utc" or "local": which midnight resets the daily spend cap. */
  dayBoundary: z.enum(["utc", "local"]).default("utc"),
});

export type ForemanConfig = z.infer<typeof configSchema>;
export type CheckCommand = z.infer<typeof checkSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

export function parseConfig(text: string, source = CONFIG_FILE): ForemanConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`${source}: invalid YAML: ${(e as Error).message}`);
  }
  const res = configSchema.safeParse(raw ?? {});
  if (!res.success) {
    throw new ConfigError(`${source} is invalid:\n${formatZodError(res.error)}`);
  }
  if (res.data.limits.escalateAfterFailures >= res.data.limits.maxAttemptsPerTask) {
    // Not fatal, but escalation would never happen.
    process.emitWarning(
      `${source}: limits.escalateAfterFailures >= maxAttemptsPerTask; the escalation model will never be used`,
    );
  }
  return res.data;
}

export async function loadConfig(repoDir: string): Promise<ForemanConfig> {
  const file = path.join(repoDir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        `No ${CONFIG_FILE} found in ${repoDir}. Run \`foreman init\` to create one.`,
      );
    }
    throw e;
  }
  return parseConfig(text, file);
}
