/**
 * Read an environment variable, treating unexpanded CI placeholders as unset.
 * Azure Pipelines passes `$(MY_SECRET)` literally when the variable is not
 * defined, and GitHub Actions passes "" for missing secrets.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!t || /^\$\([\w.\-]+\)$/.test(t) || /^\$\{\{.*\}\}$/.test(t)) return undefined;
  return v;
}
