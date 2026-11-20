import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "./exec.js";

/** The browser is missing, crashed or timed out. The prototype itself is fine. */
export class BrowserError extends Error {
  override name = "BrowserError";
}

export interface Viewport {
  name: string;
  width: number;
  /** Tall pages are captured up to this height. */
  maxHeight: number;
  dark: boolean;
  description: string;
}

export const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1280, maxHeight: 2000, dark: false, description: "desktop, 1280px wide, light mode" },
  { name: "mobile", width: 390, maxHeight: 2000, dark: false, description: "mobile, 390px wide, light mode" },
  { name: "desktop-dark", width: 1280, maxHeight: 2000, dark: true, description: "desktop, 1280px wide, dark mode" },
];

export interface FindBrowserOptions {
  /** prototype.browser. When set (here or in FOREMAN_BROWSER) it is used or nothing is: no silent fallback. */
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

/** A Chrome, Edge or Chromium executable, or undefined. */
export function findBrowser(o: FindBrowserOptions = {}): string | undefined {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;

  const explicit = o.configured ?? env.FOREMAN_BROWSER;
  if (explicit) return exists(explicit) ? explicit : undefined;

  const p = platform === "win32" ? path.win32 : path.posix;
  const candidates: string[] = [];
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    for (const rel of ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe"]) {
      for (const root of roots) candidates.push(p.join(root, rel));
    }
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    const dirs = (env.PATH ?? "").split(":").filter(Boolean);
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"]) {
      for (const d of dirs) candidates.push(p.join(d, name));
    }
  }
  return candidates.find((c) => exists(c));
}

export interface ArgsOptions {
  url: string;
  width: number;
  height: number;
  dark: boolean;
  profileDir: string;
  mode: { screenshot: string } | { dumpDom: true };
  /** Chrome refuses to start as root without this (containers). */
  asRoot?: boolean;
  platform?: NodeJS.Platform;
}

export function browserArgs(o: ArgsOptions): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    `--user-data-dir=${o.profileDir}`,
    "--force-device-scale-factor=1",
    `--window-size=${o.width},${o.height}`,
    // let scripts and transitions settle before capturing
    "--virtual-time-budget=2000",
    // the page's console output arrives on stderr
    "--enable-logging=stderr",
    "--v=0",
    // On its own this makes `prefers-color-scheme: dark` match. Combined with
    // --blink-settings=preferredColorScheme it falls back to light, so don't.
    ...(o.dark ? ["--force-dark-mode"] : []),
    ...(o.asRoot ? ["--no-sandbox"] : []),
    ...((o.platform ?? process.platform) === "linux" ? ["--disable-dev-shm-usage"] : []),
    ..."screenshot" in o.mode ? [`--screenshot=${o.mode.screenshot}`] : ["--dump-dom"],
    o.url,
  ];
}

/**
 * Problems the page itself reported: script errors and blocked requests (the
 * prototype's policy blocks the network, and the browser says when something
 * tried). Lines from anything else, such as browser extensions, are dropped.
 */
export function parseConsoleIssues(stderr: string): string[] {
  const found = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    const m = /CONSOLE:\d+\]\s+"(.*)", source: file:\/\//.exec(line);
    if (!m) continue;
    const msg = m[1]!;
    if (/^(Uncaught|Refused to|Failed to load)|Content Security Policy/.test(msg)) found.add(msg.slice(0, 220));
  }
  return [...found].slice(0, 8);
}

/** Width and height from a PNG's header, or undefined if it isn't one. */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || magic.some((b, i) => buf[i] !== b)) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const MEASURE =
  "<script>addEventListener('load',function(){document.title='FOREMAN_H='+Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)})</script>";

/** A copy of the page that writes its own height into <title>, for --dump-dom. */
export function injectMeasure(html: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + MEASURE : html.slice(0, at) + MEASURE + html.slice(at);
}

/** A copy of the page with its dark rules forced on, for browsers where --force-dark-mode does nothing. */
export function forceDarkCopy(html: string): string {
  const out = html
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, "all")
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, "not all");
  const style = "<style>:root{color-scheme:dark}</style>";
  const at = out.toLowerCase().indexOf("</head>");
  return at === -1 ? style + out : out.slice(0, at) + style + out.slice(at);
}

export interface Screen {
  viewport: Viewport;
  /** Absolute path of the PNG. */
  file: string;
  width: number;
  height: number;
}

export interface RenderResult {
  screens: Screen[];
  consoleIssues: string[];
}

export interface RenderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  viewports?: Viewport[];
}

const sha = async (file: string) => createHash("sha1").update(await readFile(file)).digest("hex");

/**
 * Render `htmlFile` in a headless browser at each viewport and write
 * `<outDir>/<prefix>-<viewport>.png`. Each page is captured at its real
 * height (up to the viewport's limit), not just the first screen.
 */
export async function renderScreens(
  browser: string,
  htmlFile: string,
  outDir: string,
  prefix: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const viewports = opts.viewports ?? VIEWPORTS;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const html = await readFile(htmlFile, "utf8");
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(path.join(os.tmpdir(), "foreman-shot-"));
  const asRoot = process.getuid?.() === 0;
  const issues = new Set<string>();
  let launches = 0;

  const launch = async (url: string, mode: ArgsOptions["mode"], width: number, height: number, dark: boolean) => {
    const args = browserArgs({ url, width, height, dark, mode, asRoot, profileDir: path.join(work, `profile${launches++}`) });
    let res;
    try {
      res = await execFile(browser, args, { cwd: work, timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      throw new BrowserError(`Could not start the browser (${browser}): ${(e as Error).message}`);
    }
    if (res.timedOut) throw new BrowserError(`The browser took longer than ${Math.round(timeoutMs / 1000)}s to render the page.`);
    for (const i of parseConsoleIssues(res.stderr)) issues.add(i);
    return res;
  };

  try {
    const heights = new Map<number, number>();
    for (const width of new Set(viewports.map((v) => v.width))) {
      const copy = path.join(work, `measure-${width}.html`);
      await writeFile(copy, injectMeasure(html));
      const r = await launch(pathToFileURL(copy).href, { dumpDom: true }, width, 900, false);
      const m = /FOREMAN_H=(\d+)/.exec(r.stdout);
      heights.set(width, m ? Number(m[1]) : 900);
    }

    const shoot = async (vp: Viewport, url: string, dark: boolean): Promise<string> => {
      const height = Math.min(vp.maxHeight, Math.max(heights.get(vp.width) ?? 900, 600));
      const out = path.join(outDir, `${prefix}-${vp.name}.png`);
      await rm(out, { force: true });
      const res = await launch(url, { screenshot: out }, vp.width, height, dark);
      if (!existsSync(out)) throw new BrowserError(`The browser produced no screenshot for ${vp.name} (exit code ${res.code}).`);
      return out;
    };

    const files = new Map<string, string>();
    for (const vp of viewports) files.set(vp.name, await shoot(vp, pathToFileURL(htmlFile).href, vp.dark));

    // Some browsers ignore --force-dark-mode. If a dark shot came out identical
    // to its light twin although the page has dark rules, force them in a copy.
    if (/prefers-color-scheme\s*:\s*dark/i.test(html)) {
      for (const vp of viewports.filter((v) => v.dark)) {
        const light = viewports.find((v) => !v.dark && v.width === vp.width);
        if (!light) continue;
        if ((await sha(files.get(vp.name)!)) !== (await sha(files.get(light.name)!))) continue;
        const copy = path.join(work, `dark-${vp.name}.html`);
        await writeFile(copy, forceDarkCopy(html));
        files.set(vp.name, await shoot(vp, pathToFileURL(copy).href, false));
      }
    }

    const screens: Screen[] = [];
    for (const vp of viewports) {
      const file = files.get(vp.name)!;
      const size = pngSize(await readFile(file));
      if (!size) throw new BrowserError(`The browser wrote ${path.basename(file)} but it is not a PNG image.`);
      screens.push({ viewport: vp, file, ...size });
    }
    return { screens, consoleIssues: [...issues].slice(0, 8) };
  } finally {
    // Browser processes can hold their profile open for a moment on Windows.
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
