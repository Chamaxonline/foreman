import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserArgs,
  declaredScreens,
  findBrowser,
  forceDarkCopy,
  injectMeasure,
  layoutIssueText,
  NO_VIEWPORT_TAG,
  parseConsoleIssues,
  parseMeasure,
  pngSize,
  renderScreens,
  wrapperHtml,
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
  it("injectMeasure puts the measuring script before </body>, or at the end without one", () => {
    expect(injectMeasure("<html><body>hi</body></html>")).toMatch(/hi<script>.*FOREMAN_M=.*<\/script><\/body>/s);
    expect(injectMeasure("<div>hi</div>")).toMatch(/^<div>hi<\/div><script>/);
  });

  it("wrapperHtml frames the page at an exact size and relays what the page measured", () => {
    const html = wrapperHtml('file:///p/index.html#/a&b="x"', 390, 900);
    expect(html).toContain('src="file:///p/index.html#/a&amp;b=&quot;x&quot;"');
    expect(html).toMatch(/iframe\{[^}]*width:390px;height:900px/);
    expect(html).toContain("foremanMeasure");
    expect(html).toContain("FOREMAN_M=");
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

describe("parseMeasure and layoutIssueText", () => {
  const raw = '{"h":1200,"iw":390,"sw":620,"hid":false,"over":[{"sel":"div.tabs","right":620,"width":620}]}';
  const measured = { height: 1200, viewportWidth: 390, scrollWidth: 620, hidden: false, over: [{ sel: "div.tabs", right: 620, width: 620 }] };

  it("reads what the page wrote into its title, including HTML-escaped quotes", () => {
    expect(parseMeasure(`<html><head><title>FOREMAN_M=${raw}</title></head></html>`)).toEqual(measured);
    expect(parseMeasure(`<title>FOREMAN_M=${raw.replace(/"/g, "&quot;")}</title>`)).toEqual(measured);
    expect(parseMeasure(`<title>FOREMAN_M=${raw.replace('"hid":false', '"hid":true')}</title>`)!.hidden).toBe(true);
    expect(parseMeasure('<title>FOREMAN_M={"h":1,"iw":2,"sw":3}</title>')).toEqual({ height: 1, viewportWidth: 2, scrollWidth: 3, hidden: false, over: [] });
  });

  it("gives up cleanly on a missing, failed or malformed measurement", () => {
    expect(parseMeasure("<title>nothing here</title>")).toBeUndefined();
    expect(parseMeasure('<title>FOREMAN_M={"error":1}</title>')).toBeUndefined();
    expect(parseMeasure('<title>FOREMAN_M={"h":"tall","iw":1,"sw":1}</title>')).toBeUndefined();
    expect(parseMeasure("<title>FOREMAN_M={not json}</title>")).toBeUndefined();
  });

  it("says a page that scrolls sideways does, and names what sticks out", () => {
    const text = layoutIssueText(measured, "Ticket detail screen")!;
    expect(text).toMatch(/^At 390px wide \(Ticket detail screen\) the page scrolls sideways: its content is 620px wide\./);
    expect(text).toContain("div.tabs (reaches 620px, 620px wide)");
  });

  it("flags content the page hides with overflow clipping, however wide it reports itself", () => {
    for (const scrollWidth of [620, 390]) {
      const text = layoutIssueText({ ...measured, scrollWidth, hidden: true })!;
      expect(text, String(scrollWidth)).toMatch(/hidden by overflow clipping/);
      expect(text).toContain("div.tabs");
      expect(text).not.toMatch(/scrolls sideways/);
    }
  });

  it("is silent when everything fits, including a page that clips overflow but has none", () => {
    const fits = { height: 900, viewportWidth: 390, scrollWidth: 390, hidden: false, over: [] };
    expect(layoutIssueText(fits)).toBeUndefined();
    expect(layoutIssueText({ ...fits, scrollWidth: 391 })).toBeUndefined(); // 1px of rounding
    expect(layoutIssueText({ ...fits, hidden: true })).toBeUndefined();
  });
});

describe("declaredScreens", () => {
  const block = (json: string) => `<body><script type="application/json" id="foreman-screens">${json}</script></body>`;

  it("reads the list the page declares, up to the limit, and slugs the names", () => {
    const html = block('[{"name":"Ticket detail","hash":"#/tickets/1"},{"name":"No results!","hash":"#/empty"},{"name":"Third","hash":"#/c"}]');
    expect(declaredScreens(html, 2)).toEqual([
      { name: "Ticket detail", hash: "#/tickets/1", slug: "ticket-detail" },
      { name: "No results!", hash: "#/empty", slug: "no-results" },
    ]);
    expect(declaredScreens(html, 0)).toEqual([]);
  });

  it("makes duplicate names unique and falls back for names with no letters", () => {
    const out = declaredScreens(block('[{"name":"Detail","hash":"#/a"},{"name":"Detail","hash":"#/b"},{"name":"!!!","hash":"#/c"}]'), 5);
    expect(out.map((s) => s.slug)).toEqual(["detail", "detail-2", "screen"]);
  });

  it("ignores bad entries, malformed JSON, a non-list and a missing block", () => {
    expect(declaredScreens(block('[{"name":"No hash","hash":"/x"},{"name":5,"hash":"#/a"},{"name":"  ","hash":"#/b"},{"hash":"#/c"},null,"x",{"name":"Ok","hash":"#/ok"}]'), 5)).toEqual([
      { name: "Ok", hash: "#/ok", slug: "ok" },
    ]);
    expect(declaredScreens(block("[not json"), 5)).toEqual([]);
    expect(declaredScreens(block('{"name":"x","hash":"#/a"}'), 5)).toEqual([]);
    expect(declaredScreens("<body>no block</body>", 5)).toEqual([]);
    expect(declaredScreens(block(`[{"name":"Long","hash":"#${"x".repeat(300)}"}]`), 5)).toEqual([]);
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
    // A browser window is never narrower than about 500px, so the 390px view is a
    // 390px frame centered in a 500px-wide image.
    expect(r.screens.map((s) => s.width)).toEqual([1280, 500, 1280]);
    expect(r.screens[1]!.description).toMatch(/390px-wide frame in the middle of a gray canvas/);
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

  const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const page = (head: string, body: string) => `<!doctype html><html><head><meta charset="utf-8">${VIEWPORT}<style>body{margin:0}${head}</style></head><body>${body}</body></html>`;
  const render = async (name: string, html: string, maxScreens = 0) => {
    const file = path.join(dir, `${name}.html`);
    await writeFile(file, lockdownHtml(html));
    return renderScreens(browser!, file, path.join(dir, name), "r1", { maxScreens });
  };

  it("lays a page out at exactly 390px wide: a responsive page is clean, and a page that really overflows is named", async () => {
    const ok = await render(
      "responsive",
      page(".row{display:flex;flex-wrap:wrap;gap:8px;padding:8px}.card{flex:1 1 150px;height:40px;background:#0a7}", '<div class="row"><div class="card"></div><div class="card"></div><div class="card"></div></div>'),
    );
    expect(ok.layoutIssues).toEqual([]);

    // 620px wide: fine on a desktop, wider than a 390px phone
    const wide = await render("wide", page(".tabs{display:flex;width:620px;height:40px;background:#0a7}", '<div class="tabs" id="tabs"></div>'));
    expect(wide.layoutIssues).toHaveLength(1);
    expect(wide.layoutIssues[0]).toMatch(/^At 390px wide the page scrolls sideways: its content is 620px wide\./);
    expect(wide.layoutIssues[0]).toContain("div#tabs.tabs (reaches 620px, 620px wide)");
  }, 180_000);

  it("catches overflow that the page hides with overflow-x: hidden", async () => {
    const hidden = await render(
      "hidden",
      page("html,body{overflow-x:hidden}.tabs{display:flex;width:620px;height:40px;background:#0a7}", '<div class="tabs" id="tabs"></div>'),
    );
    expect(hidden.layoutIssues).toHaveLength(1);
    expect(hidden.layoutIssues[0]).toMatch(/hidden by overflow clipping/);
    expect(hidden.layoutIssues[0]).toContain("div#tabs.tabs");
  }, 180_000);

  it("does not blame a wide table that sits inside its own scrolling box", async () => {
    const r = await render(
      "scrollbox",
      page(".box{overflow-x:auto}table{width:800px;border-collapse:collapse}td{border:1px solid #999;padding:8px}", '<div class="box"><table><tr><td>a</td><td>b</td></tr></table></div>'),
    );
    expect(r.layoutIssues).toEqual([]);
  }, 180_000);

  it("reports a missing viewport tag", async () => {
    const r = await render("noviewport", "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>hi</body></html>");
    expect(r.layoutIssues).toContain(NO_VIEWPORT_TAG);
  }, 180_000);

  it("captures the screens a page declares, at desktop and mobile, by opening their hash", async () => {
    const routed = page(
      "",
      `<div id="v"></div><script>function r(){document.getElementById('v').textContent=location.hash||'HOME';document.body.style.background=location.hash?'#fde68a':'#fff'}addEventListener('hashchange',r);r()</script>` +
        `<script type="application/json" id="foreman-screens">[{"name":"Ticket detail","hash":"#/tickets/1"},{"name":"No results","hash":"#/empty"}]</script>`,
    );

    const none = await render("routes0", routed);
    expect(none.screens).toHaveLength(3); // declared screens are opt-in

    const some = await render("routes2", routed, 2);
    expect(some.screens.map((s) => path.basename(s.file))).toEqual([
      "r1-desktop.png",
      "r1-mobile.png",
      "r1-desktop-dark.png",
      "r1-ticket-detail-desktop.png",
      "r1-ticket-detail-mobile.png",
      "r1-no-results-desktop.png",
      "r1-no-results-mobile.png",
    ]);
    expect(some.screens[3]!.description).toMatch(/"Ticket detail" screen \(the page opened at #\/tickets\/1\), desktop/);
    // the hash was really opened: the declared screen is not the same picture as the first screen
    expect(await sha(some.screens[3]!.file)).not.toBe(await sha(some.screens[0]!.file));

    expect((await render("routes1", routed, 1)).screens).toHaveLength(5);
  }, 240_000);
});
