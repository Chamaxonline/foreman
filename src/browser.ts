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

// Runs in the page after load. It measures the page and names the outermost
// elements that stick out past the right edge (ignoring anything inside a
// clipping or scrolling ancestor, and fixed-position or hidden elements). This
// also catches pages that hide a sideways overflow with `overflow-x: hidden`
// on <html> or <body>, which leaves the content unreachable. The result goes
// to the parent frame (the measuring wrapper) and into <title>.
const MEASURE =
  `<script>addEventListener('load',function(){var o;try{` +
  `var de=document.documentElement,b=document.body,iw=window.innerWidth;` +
  `var hid=getComputedStyle(de).overflowX!=='visible'||(b&&getComputedStyle(b).overflowX!=='visible');` +
  `o={h:Math.max(de.scrollHeight,b?b.scrollHeight:0),iw:iw,sw:Math.max(de.scrollWidth,b?b.scrollWidth:0),hid:hid,over:[]};` +
  `if(b&&(o.sw>iw+1||hid)){` +
  `var clipped=function(el){for(var p=el;p&&p!==b&&p!==de;p=p.parentElement){var cs=getComputedStyle(p);if(cs.position==='fixed')return true;if(p!==el&&cs.overflowX!=='visible')return true}return false};` +
  `var hit=[],all=b.getElementsByTagName('*');` +
  `for(var i=0;i<all.length&&i<3000;i++){var el=all[i],r=el.getBoundingClientRect();if(r.width>0&&r.height>0&&r.right>iw+1&&getComputedStyle(el).visibility!=='hidden'&&!clipped(el))hit.push({el:el,right:Math.round(r.right),width:Math.round(r.width)})}` +
  `var set=new Set(hit.map(function(x){return x.el}));` +
  `hit=hit.filter(function(x){return !set.has(x.el.parentElement)}).sort(function(a,c){return c.right-a.right}).slice(0,5);` +
  `o.over=hit.map(function(x){var el=x.el,s=el.tagName.toLowerCase();if(el.id)s+='#'+el.id;` +
  `var c=typeof el.className==='string'?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2):[];if(c.length)s+='.'+c.join('.');` +
  `return{sel:s,right:x.right,width:x.width}})}` +
  `}catch(e){o={error:1}}` +
  `document.title='FOREMAN_M='+JSON.stringify(o);try{parent.postMessage({foremanMeasure:o},'*')}catch(e){}});</script>`;

/** A copy of the page that measures itself, for --dump-dom. */
export function injectMeasure(html: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + MEASURE : html.slice(0, at) + MEASURE + html.slice(at);
}

export interface Measure {
  height: number;
  viewportWidth: number;
  scrollWidth: number;
  /** The page clips its own sideways overflow (`overflow-x` on <html> or <body>), so it cannot scroll to it. */
  hidden: boolean;
  /** Outermost elements sticking out past the right edge, widest reach first. */
  over: Array<{ sel: string; right: number; width: number }>;
}

/** The measurement a measured page left in its <title>, from a --dump-dom result. */
export function parseMeasure(dom: string): Measure | undefined {
  const m = /FOREMAN_M=(\{[^<]*\})/.exec(dom);
  if (!m) return undefined;
  try {
    const o = JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Record<string, unknown>;
    if (typeof o.h !== "number" || typeof o.iw !== "number" || typeof o.sw !== "number") return undefined;
    const over = Array.isArray(o.over)
      ? o.over
          .filter((x): x is { sel: string; right: number; width: number } => !!x && typeof x.sel === "string" && typeof x.right === "number" && typeof x.width === "number")
          .map((x) => ({ sel: x.sel.slice(0, 80), right: x.right, width: x.width }))
      : [];
    return { height: o.h, viewportWidth: o.iw, scrollWidth: o.sw, hidden: o.hid === true, over };
  } catch {
    return undefined;
  }
}

/** A plain-language finding when the page is wider than the screen, else undefined. */
export function layoutIssueText(m: Measure, where?: string): string | undefined {
  const scrolls = m.scrollWidth > m.viewportWidth + 1;
  if (!scrolls && m.over.length === 0) return undefined;
  const at = `At ${m.viewportWidth}px wide${where ? ` (${where})` : ""}`;
  const offenders = m.over.length ? ` Sticking out past the screen: ${m.over.map((o) => `${o.sel} (reaches ${o.right}px, ${o.width}px wide)`).join("; ")}.` : "";
  return m.hidden
    ? `${at} content sticks out past the screen edge and is hidden by overflow clipping on the page, so it cannot be reached.${offenders}`
    : `${at} the page scrolls sideways: its content is ${m.scrollWidth}px wide.${offenders}`;
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * A page that shows `src` in an iframe of exactly `width` x `height`. An iframe's
 * layout width is exact, unlike a browser window, which will not go below about
 * 500px and is smaller than requested by its own frame. It also relays what the
 * measuring script inside reports. The gray canvas and thin outline mark where
 * the frame ends when the window is wider than the frame.
 */
export function wrapperHtml(src: string, width: number, height: number): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;height:100%;background:#cbd5e1}body{display:flex;justify-content:center;align-items:flex-start}` +
    `iframe{border:0;display:block;flex:none;width:${width}px;height:${height}px;background:#fff;box-shadow:0 0 0 1px rgba(15,23,42,.35)}` +
    `</style></head><body><iframe src="${escAttr(src)}"></iframe>` +
    `<script>addEventListener('message',function(e){var d=e.data;if(d&&d.foremanMeasure)document.title='FOREMAN_M='+JSON.stringify(d.foremanMeasure)})</script>` +
    `</body></html>`
  );
}

/** Chrome will not open a window narrower than this. Narrower views are shown in a frame inside one. */
const MIN_WINDOW = 500;

export const NO_VIEWPORT_TAG =
  'The page has no <meta name="viewport" content="width=device-width, initial-scale=1"> tag, so a phone would lay it out about 980px wide and shrink it.';

export interface ScreenSpec {
  name: string;
  hash: string;
  slug: string;
}

/**
 * The extra screens and states a prototype lists for review, from a
 * `<script type="application/json" id="foreman-screens">` block of
 * `[{ "name": "...", "hash": "#/route" }]`. Read as data, never executed.
 */
export function declaredScreens(html: string, max: number): ScreenSpec[] {
  if (max <= 0) return [];
  const m = /<script\b[^>]*\bid=["']foreman-screens["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ScreenSpec[] = [];
  const taken = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const { name, hash } = e as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || typeof hash !== "string" || !/^#.{1,200}$/.test(hash)) continue;
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "screen";
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    out.push({ name: name.trim().slice(0, 60), hash, slug });
    if (out.length >= max) break;
  }
  return out;
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
  /** What the critic is told this image shows. Defaults to the viewport's description. */
  description?: string;
  /** Absolute path of the PNG. */
  file: string;
  width: number;
  height: number;
}

export interface RenderResult {
  screens: Screen[];
  consoleIssues: string[];
  /** Measured facts about the layout, such as the page being wider than a phone screen. */
  layoutIssues: string[];
}

export interface RenderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  viewports?: Viewport[];
  /** How many of the page's declared extra screens to capture, at desktop and mobile. Default 0. */
  maxScreens?: number;
}

const sha = async (file: string) => createHash("sha1").update(await readFile(file)).digest("hex");

interface Target {
  /** "" for the page as it first loads. */
  label: string;
  hash: string;
  slug: string;
  viewports: Viewport[];
}

/**
 * Render `htmlFile` in a headless browser at each viewport and write
 * `<outDir>/<prefix>-<viewport>.png`. Each page is captured at its real
 * height (up to the viewport's limit), and the layout is measured, so a page
 * that scrolls sideways is reported with the elements responsible. Screens the
 * page declares are captured too, at desktop and mobile.
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
  const layout: string[] = [];
  let launches = 0;

  const urlFor = (file: string, hash: string) => {
    const u = pathToFileURL(file);
    if (hash) u.hash = hash;
    return u.href;
  };

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

  const lightPair = viewports.filter((v) => !v.dark && (v.name === "desktop" || v.name === "mobile"));
  const targets: Target[] = [{ label: "", hash: "", slug: "", viewports }];
  for (const s of declaredScreens(html, opts.maxScreens ?? 0)) {
    targets.push({ label: s.name, hash: s.hash, slug: s.slug, viewports: lightPair });
  }

  try {
    if (!/<meta\b[^>]*\bname=["']?viewport/i.test(html)) layout.push(NO_VIEWPORT_TAG);

    // measure each distinct target and width once: its real height, and whether it scrolls sideways
    const heights = new Map<string, number>();
    const measureCopy = path.join(work, "measure.html");
    await writeFile(measureCopy, injectMeasure(html));
    for (const t of targets) {
      for (const width of new Set(t.viewports.map((v) => v.width))) {
        // measured inside a frame of exactly `width`, so the result does not depend on the browser's window limits
        const wrap = path.join(work, `measure-${launches}.html`);
        await writeFile(wrap, wrapperHtml(urlFor(measureCopy, t.hash), width, 900));
        const r = await launch(pathToFileURL(wrap).href, { dumpDom: true }, Math.max(width + 120, MIN_WINDOW), 1000, false);
        const m = parseMeasure(r.stdout);
        heights.set(`${t.slug}:${width}`, m?.height ?? 900);
        const text = m && layoutIssueText(m, t.label ? `${t.label} screen` : undefined);
        if (text) layout.push(text);
      }
    }

    const shoot = async (t: Target, vp: Viewport, file: string, dark: boolean): Promise<string> => {
      const height = Math.min(vp.maxHeight, Math.max(heights.get(`${t.slug}:${vp.width}`) ?? 900, 600));
      const out = path.join(outDir, `${prefix}-${t.slug ? `${t.slug}-` : ""}${vp.name}.png`);
      await rm(out, { force: true });
      let url = urlFor(file, t.hash);
      let windowWidth = vp.width;
      if (vp.width < MIN_WINDOW) {
        // a 390px window would really be 500px wide, cropped; show the page in an exact 390px frame instead
        const frame = path.join(work, `frame-${launches}.html`);
        await writeFile(frame, wrapperHtml(url, vp.width, height));
        url = pathToFileURL(frame).href;
        windowWidth = MIN_WINDOW;
      }
      const res = await launch(url, { screenshot: out }, windowWidth, height, dark);
      if (!existsSync(out)) throw new BrowserError(`The browser produced no screenshot for ${t.label || "the page"} at ${vp.name} (exit code ${res.code}).`);
      return out;
    };

    const files = new Map<string, string>();
    const key = (t: Target, vp: Viewport) => `${t.slug}|${vp.name}`;
    for (const t of targets) {
      for (const vp of t.viewports) files.set(key(t, vp), await shoot(t, vp, htmlFile, vp.dark));
    }

    // Some browsers ignore --force-dark-mode. If a dark shot came out identical
    // to its light twin although the page has dark rules, force them in a copy.
    const main = targets[0]!;
    if (/prefers-color-scheme\s*:\s*dark/i.test(html)) {
      for (const vp of viewports.filter((v) => v.dark)) {
        const light = viewports.find((v) => !v.dark && v.width === vp.width);
        if (!light) continue;
        if ((await sha(files.get(key(main, vp))!)) !== (await sha(files.get(key(main, light))!))) continue;
        const copy = path.join(work, `dark-${vp.name}.html`);
        await writeFile(copy, forceDarkCopy(html));
        files.set(key(main, vp), await shoot(main, vp, copy, false));
      }
    }

    const screens: Screen[] = [];
    for (const t of targets) {
      for (const vp of t.viewports) {
        const file = files.get(key(t, vp))!;
        const size = pngSize(await readFile(file));
        if (!size) throw new BrowserError(`The browser wrote ${path.basename(file)} but it is not a PNG image.`);
        const base = t.label ? `the "${t.label}" screen (the page opened at ${t.hash}), ${vp.description}` : vp.description;
        screens.push({
          viewport: vp,
          description:
            vp.width < MIN_WINDOW
              ? `${base}. The page is the ${vp.width}px-wide frame in the middle of a gray canvas, so judge only what is inside the frame`
              : base,
          file,
          ...size,
        });
      }
    }
    return { screens, consoleIssues: [...issues].slice(0, 8), layoutIssues: layout.slice(0, 8) };
  } finally {
    // Browser processes can hold their profile open for a moment on Windows.
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
