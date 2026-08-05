// renders dist/resume.pdf from the built /resume page, so the downloadable pdf
// can never drift from the page again. the boring look is not a second document:
// it is the same resume.astro through its @media print stylesheet, printed by a
// headless chromium. one source of truth, two skins.
//
//   node scripts/render-resume-pdf.mjs        (after astro build)
//
// the browser is driven over the devtools protocol rather than --print-to-pdf,
// because the cli prints at the load event, before the webfont has applied.
// fallback metrics wrap a few extra lines, the second sheet overflows, and the
// pdf grows a third page. the protocol path waits for document.fonts.ready and
// two settled frames, which makes the layout deterministic.
//
// deliberately dependency-free: node:http serves dist, node's built-in
// WebSocket speaks the protocol (node 22+), and the browser is whatever
// chromium the machine already has (chrome on the ubuntu runners, edge on a
// windows dev box). nothing new enters package.json for this.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = process.cwd();
const DIST = resolve(ROOT, "dist");
const OUT = join(DIST, "resume.pdf");
const PAGE_PATH = "/resume";
const EXPECTED_PAGES = 2;
const DEADLINE_MS = 90_000;

if (!existsSync(join(DIST, "resume", "index.html"))) {
  console.error("dist/resume/index.html not found. run the build first.");
  process.exit(1);
}
if (typeof globalThis.WebSocket !== "function") {
  console.error(`node ${process.version} has no global WebSocket; node 22+ required.`);
  process.exit(1);
}

// ---- locate a chromium ------------------------------------------------------

function findBrowser() {
  if (process.env.RESUME_PDF_BROWSER) return process.env.RESUME_PDF_BROWSER;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];

  for (const c of candidates) {
    if (c.includes("/") || c.includes("\\")) {
      if (existsSync(c)) return c;
    } else {
      const probe = spawnSync(c, ["--version"], { stdio: "ignore" });
      if (!probe.error && probe.status === 0) return c;
    }
  }
  return null;
}

// ---- tiny static server over dist -------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
};

function serveDist() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const url = decodeURIComponent((req.url || "/").split("?")[0]);
      // normalize inside dist so a hand-crafted path cannot escape it
      const clean = normalize(url).replace(/^([.\\/])+/, "");
      let file = join(DIST, clean);
      if (!file.startsWith(DIST)) file = DIST;
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
      if (!existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

// ---- minimal cdp client -----------------------------------------------------

function connect(wsUrl) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const waiters = new Map();
    ws.addEventListener("open", () =>
      ok({
        ws,
        call(method, params = {}, sessionId) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timed out`));
            }, 30_000);
            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        once(method, sessionId) {
          return new Promise((res, rej) => {
            const key = `${sessionId ?? ""}:${method}`;
            const timer = setTimeout(() => {
              waiters.delete(key);
              rej(new Error(`waiting for ${method} timed out`));
            }, 30_000);
            waiters.set(key, { res, timer });
          });
        },
      }),
    );
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.rej(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
        else entry.res(msg.result);
        return;
      }
      const waiter = waiters.get(`${msg.sessionId ?? ""}:${msg.method}`);
      if (waiter) {
        waiters.delete(`${msg.sessionId ?? ""}:${msg.method}`);
        clearTimeout(waiter.timer);
        waiter.res(msg.params);
      }
    });
    ws.addEventListener("error", () => fail(new Error("devtools socket failed")));
  });
}

// ---- run --------------------------------------------------------------------

const browser = findBrowser();
if (!browser) {
  console.error("no chromium found. install chrome or edge, or point RESUME_PDF_BROWSER at one.");
  process.exit(1);
}

const server = await serveDist();
const port = server.address().port;
// a scratch profile so the run never fights a logged-in browser instance; the
// browser also drops its DevToolsActivePort file here
const profile = mkdtempSync(join(tmpdir(), "resume-pdf-"));

const args = [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,1000",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=0",
  "about:blank",
];
if (process.env.CI) args.splice(1, 0, "--no-sandbox");

const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const deadline = setTimeout(() => {
  console.error(`render did not finish within ${DEADLINE_MS / 1000}s`);
  console.error(stderr.slice(0, 800));
  child.kill();
  process.exit(1);
}, DEADLINE_MS);

async function waitForPortFile() {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const [p, path] = readFileSync(file, "utf8").split("\n");
      if (p && path) return `ws://127.0.0.1:${p.trim()}${path.trim()}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("browser never wrote DevToolsActivePort");
}

try {
  const cdp = await connect(await waitForPortFile());
  // start on a blank target and only navigate once page events are wired, so
  // the load event cannot fire into the void and the settle expression cannot
  // race the navigation's context teardown
  const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
  await cdp.call("Page.enable", {}, sessionId);
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await cdp.call("Page.navigate", { url: `http://127.0.0.1:${port}${PAGE_PATH}` }, sessionId);
  await loaded;

  // measure under print media so the numbers describe the layout that will be
  // printed, not the screen one
  await cdp.call("Emulation.setEmulatedMedia", { media: "print" }, sessionId);

  // settle: fonts applied, then two frames so layout is final. the returned
  // numbers land in the deploy log, so a failed run explains itself.
  const settle = await cdp.call(
    "Runtime.evaluate",
    {
      expression: `(async () => {
        await document.fonts.ready;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const sheets = [...document.querySelectorAll(".resume-sheet")].map((s) => {
          const top = s.getBoundingClientRect().top;
          let deep = 0;
          for (const el of s.querySelectorAll("*")) {
            if (getComputedStyle(el).position === "absolute") continue;
            deep = Math.max(deep, el.getBoundingClientRect().bottom - top);
          }
          return Math.round(deep);
        });
        return JSON.stringify({
          font: document.fonts.check('10pt "InterResume"'),
          sheets,
          doc: Math.round(document.documentElement.scrollHeight),
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  console.log(`layout: ${settle.result.value}`);

  const { data } = await cdp.call(
    "Page.printToPDF",
    {
      preferCSSPageSize: true,
      printBackground: true,
      // devtools defaults to 1cm margins, which shrink the printable area
      // under the full-bleed sheets and fragment a third page
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    },
    sessionId,
  );
  writeFileSync(OUT, Buffer.from(data, "base64"));

  await cdp.call("Browser.close").catch(() => {});
  cdp.ws.close();
} catch (error) {
  console.error(`render failed: ${error.message}`);
  console.error(stderr.slice(0, 800));
  child.kill();
  process.exit(1);
} finally {
  clearTimeout(deadline);
  server.close();
  // wait for the browser to actually exit before removing its profile; a
  // timer-based cleanup raced the file locks and crashed the process on EPERM
  const exited = new Promise((r) => child.once("close", r));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // a still-locked temp profile is not worth failing a deploy over
  }
}

// ---- validate the artifact --------------------------------------------------
// the checks are the reason this script can gate a deploy: a blank or truncated
// pdf must fail loudly here, not surface as a broken download on the live site.

const pdf = readFileSync(OUT);
const problems = [];
if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) problems.push("missing %PDF header");
const counts = [...pdf.toString("latin1").matchAll(/\/Count (\d+)/g)].map((m) => +m[1]);
const pages = counts.length ? Math.max(...counts) : 0;
if (pages !== EXPECTED_PAGES) problems.push(`${pages} pages, expected ${EXPECTED_PAGES}`);
if (pdf.length < 20_000) problems.push(`suspiciously small (${pdf.length} bytes)`);
if (pdf.length > 5_000_000) problems.push(`suspiciously large (${pdf.length} bytes)`);

if (problems.length) {
  console.error(`resume.pdf failed validation: ${problems.join("; ")}`);
  process.exit(1);
}

console.log(`resume.pdf: ${pages} pages, ${(pdf.length / 1024).toFixed(0)} KB`);
