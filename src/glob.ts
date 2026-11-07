/**
 * Small gitignore-flavoured glob matcher (no dependency):
 *   `**` any number of path segments, `*` within a segment, `?` one char,
 *   `{a,b}` alternatives. A pattern without `/` matches at any depth.
 * Matching is case-insensitive, so `Vitest.Config.ts` cannot slip past on
 * case-insensitive filesystems.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/");
  if (g.startsWith("/")) g = g.slice(1);
  else if (!g.includes("/") || g.startsWith("**/")) g = g.startsWith("**/") ? g : `**/${g}`;
  if (g.endsWith("/")) g += "**";

  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        continue;
      }
      const alts = g.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
      re += `(?:${alts.join("|")})`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export function makeMatcher(globs: string[]): (p: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p) => {
    const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
    return res.some((r) => r.test(norm));
  };
}
