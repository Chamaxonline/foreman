import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserArgs,
  findBrowser,
  forceDarkCopy,
  injectMeasure,
  parseConsoleIssues,
  pngSize,
  renderScreens,
} from "../src/browser.js";
import { lockdownHtml } from "../src/prototype.js";

describe("findBrowser", () => {
  const only = (...present: string[]) => (p: string) => present.includes(p);

  it("prefers Chrome over Edge over Chromium on Windows, across the usual install roots", () => {
    const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(findBrowser({ platform: "win32", env, exists: only(edge, chrome) })).toBe(chrome);
    expect(findBrowser({ platform: "win32", env, exists: only(edge) })).toBe(edge);
    const perUser = "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    expect(findBrowser({ platform: "win32", env, exists: only(perUser) })).toBe(perUser);
  });

  it("finds the macOS app bundles", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(findBrowser({ platform: "darwin", env: {}, exists: only(chrome) })).toBe(chrome);
  });

  it("searches PATH on Linux", () => {
    const env = { PATH: "/usr/local/bin:/usr/bin" };
    expect(findBrowser({ platform: "linux", env, exists: only("/usr/bin/chromium") })).toBe("/usr/bin/chromium");
    expect(findBrowser({ platform: "linux", env, exists: only("/usr/bin/chromium", "/usr/local/bin/google-chrome") })).toBe("/usr/local/bin/google-chrome");
  });

  it("returns undefined when there is none", () => {
    expect(findBrowser({ platform: "linux", env: { PATH: "/usr/bin" }, exists: () => false })).toBeUndefined();
    expect(findBrowser({ platform: "win32", env: {}, exists: () => true })).toBeUndefined(); // no roots to look in
  });

  it("an explicit browser is used or nothing is: no silent fallback to a different one", () => {
    const exists = only("/opt/mine/chrome", "/usr/bin/chromium");
    expect(findBrowser({ configured: "/opt/mine/chrome", platform: "linux", env: { PATH: "/usr/bin" }, exists })).toBe("/opt/mine/chrome");
    expect(findBrowser({ configured: "/opt/gone/chrome", platform: "linux", env: { PATH: "/usr/bin" }, exists })).toBeUndefined();
    expect(findBrowser({ platform: "linux", env: { FOREMAN_BROWSER: "/opt/mine/chrome", PATH: "/usr/bin" }, exists })).toBe("/opt/mine/chrome");
    expect(findBrowser({ platform: "linux", env: { FOREMAN_BROWSER: "/opt/gone/chrome", PATH: "/usr/bin" }, exists })).toBeUndefined();
  });
});

describe("browserArgs", () => {
  const base = { url: "file:///p/index.html", width: 390, height: 1200, dark: false, profileDir: "/tmp/prof", platform: "darwin" as const };

  it("takes a screenshot at the requested size with a throwaway profile", () => {
    const a = browserArgs({ ...base, mode: { screenshot: "/tmp/out.png" } });
    expect(a).toContain("--headless=new");
    expect(a).toContain("--window-size=390,1200");
    expect(a).toContain("--screenshot=/tmp/out.png");
    expect(a).toContain("--user-data-dir=/tmp/prof");
    expect(a).toContain("--force-device-scale-factor=1");
    expect(a).not.toContain("--dump-dom");
    expect(a.at(-1)).toBe("file:///p/index.html");
  });

  it("dark mode is --force-dark-mode on its own (the blink setting undoes it)", () => {
    const dark = browserArgs({ ...base, dark: true, mode: { screenshot: "/tmp/o.png" } });
    expect(dark).toContain("--force-dark-mode");
    expect(dark.some((x) => x.includes("preferredColorScheme"))).toBe(false);
    expect(browserArgs({ ...base, mode: { screenshot: "/tmp/o.png" } })).not.toContain("--force-dark-mode");
  });

  it("dumps the DOM for height measurement, and only drops the sandbox when running as root", () => {
    const m = browserArgs({ ...base, mode: { dumpDom: true } });
    expect(m).toContain("--dump-dom");
    expect(m.some((x) => x.startsWith("--screenshot"))).toBe(false);
    expect(m).not.toContain("--no-sandbox");
    expect(browserArgs({ ...base, asRoot: true, mode: { dumpDom: true } })).toContain("--no-sandbox");
  });

  it("adds the shared-memory workaround on Linux only", () => {
    expect(browserArgs({ ...base, platform: "linux", mode: { dumpDom: true } })).toContain("--disable-dev-shm-usage");
    expect(browserArgs({ ...base, platform: "win32", mode: { dumpDom: true } })).not.toContain("--disable-dev-shm-usage");
  });
});

describe("parseConsoleIssues", () => {
  const line = (msg: string, source = "file:///C:/tmp/index.html") => `[1:2:1121/001546.803:INFO:CONSOLE:6] "${msg}", source: ${source} (6)`;

  it("keeps script errors and blocked requests from the page", () => {
    const out = parseConsoleIssues(
      [
        line("Uncaught TypeError: Cannot read properties of null (reading 'x')"),
        line(`Loading the image 'https://e.com/x.png' violates the following Content Security Policy directive: "img-src data:". The action has been blocked`),
        line("Refused to connect to 'https://e.com' because it violates the document's Content Security Policy."),
      ].join("\n"),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^Uncaught TypeError/);
    expect(out[1]).toMatch(/violates the following Content Security Policy/);
  });

  it("drops plain logs, other origins (extensions), duplicates and non-console noise", () => {
    const out = parseConsoleIssues(
      [
        line("hello from the page"),
        line("Uncaught Error: from an extension", "chrome-extension://abcdef/background.js"),
        line("Uncaught Error: boom"),
        line("Uncaught Error: boom"),
        "[1:2:1121/001546.803:ERROR:gpu_process_host.cc(1)] GPU process exited unexpectedly",
      ].join("\r\n"),
    );
    expect(out).toEqual(["Uncaught Error: boom"]);
  });

  it("caps the list and the length of each entry", () => {
    const many = Array.from({ length: 20 }, (_, i) => line(`Uncaught Error: n${i}`)).join("\n");
    expect(parseConsoleIssues(many)).toHaveLength(8);
    expect(parseConsoleIssues(line("Uncaught Error: " + "x".repeat(500)))[0]!.length).toBe(220);
  });
});

describe("pngSize", () => {
  it("reads the dimensions from a PNG header and rejects anything else", () => {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(1280, 16);
    buf.writeUInt32BE(2000, 20);
    expect(pngSize(buf)).toEqual({ width: 1280, height: 2000 });
    expect(pngSize(Buffer.from("not a png at all, just text........"))).toBeUndefined();
    expect(pngSize(Buffer.alloc(4))).toBeUndefined();
  });
});

describe("page copies", () => {
  it("injectMeasure puts the height script before </body>, or at the end without one", () => {
    expect(injectMeasure("<html><body>hi</body></html>")).toMatch(/hi<script>.*FOREMAN_H=.*<\/script><\/body>/s);
    expect(injectMeasure("<div>hi</div>")).toMatch(/^<div>hi<\/div><script>/);
  });

  it("forceDarkCopy makes the dark rules always apply and the light ones never", () => {
    const out = forceDarkCopy(
      "<html><head><style>@media (prefers-color-scheme: dark){a{color:#fff}} @media (prefers-color-scheme:light){a{color:#000}}</style></head></html>",
    );
    expect(out).toContain("@media all{a{color:#fff}}");
    expect(out).toContain("@media not all{a{color:#000}}");
    expect(out).toMatch(/<style>:root\{color-scheme:dark\}<\/style><\/head>/);
  });
});

// Runs for real wherever Chrome, Edge or Chromium is installed (CI runners have one).
const browser = findBrowser();
describe.skipIf(!browser)("renderScreens (real browser)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "foreman-render-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>
body{margin:0;background:#fff;color:#111;font:16px system-ui}
@media (prefers-color-scheme: dark){body{background:#101418;color:#eee}}
.tall{height:2600px;background:linear-gradient(#fff0,#0a7)}</style></head>
<body><h1>Hello</h1><div class="tall"></div><img src="https://example.com/x.png" alt=""></body></html>`;
  const sha = async (f: string) => createHash("sha1").update(await readFile(f)).digest("hex");

  it("captures desktop, mobile and dark at the right widths and a tall page's real height, and reports a blocked request", async () => {
    const file = path.join(dir, "index.html");
    await writeFile(file, lockdownHtml(PAGE));
    const r = await renderScreens(browser!, file, path.join(dir, "shots"), "r1");

    expect(r.screens.map((s) => s.viewport.name)).toEqual(["desktop", "mobile", "desktop-dark"]);
    expect(r.screens.map((s) => s.width)).toEqual([1280, 390, 1280]);
    for (const s of r.screens) {
      expect(path.basename(s.file)).toBe(`r1-${s.viewport.name}.png`);
      expect(s.height).toBeGreaterThan(1500); // the page is 2600px tall: capped at 2000, not cut at one screen
      expect(s.height).toBeLessThanOrEqual(2000);
    }
    // the dark screenshot really is dark (whichever way the browser got there)
    const [desktop, , dark] = r.screens;
    expect(await sha(dark!.file)).not.toBe(await sha(desktop!.file));
    expect(r.consoleIssues.some((i) => /Content Security Policy/.test(i))).toBe(true);
  }, 180_000);
});
