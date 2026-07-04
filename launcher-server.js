// launcher-server.js — tiny local backend for the Project Tracker buttons.
// Serves nothing critical; exposes two actions the static page can't do itself:
//   POST /api/session  {path,name}     -> open/boot that project's Claude session in Terminal Bridge
//   POST /api/use      {path,name,url} -> launch everything needed to actually USE the project
// Built-ins only (http, net, fs, path, child_process) so there's no npm install.
// Requests use a text/plain body (CORS-safelisted) so file:// pages reach it with no preflight.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 7795;
const HOME = "C:\\Users\\socia";
const TB = path.join(HOME, "terminal-bridge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = (s) => String(s || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(); // normalize a path key

// ---- launchers -------------------------------------------------------------
// Microsoft Edge — the user wants every project to open in Edge, not the default
// browser (Firefox). Resolve the exe once; fall back to "msedge" on PATH.
const EDGE = [
  process.env.ProgramFiles + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.LOCALAPPDATA + "\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "msedge";

// Open a target. Web pages (http/https URLs and local .htm/.html files) open in
// Microsoft Edge; everything else (folders, unityhub:// etc.) uses the default handler.
function openTarget(target) {
  const t = String(target);
  const isWeb = /^https?:\/\//i.test(t) || /\.html?$/i.test(t.split(/[?#]/)[0]);
  if (isWeb) {
    spawn(EDGE, [t], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn("cmd", ["/c", "start", "", t], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}
// Run a .bat in its own visible window, in the bat's own folder.
// `extraEnv` lets a caller pass env vars (e.g. a "no pause" flag) to the bat.
function runBatWindow(batPath, extraEnv) {
  const dir = path.dirname(batPath);
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  spawn("cmd", ["/c", "start", "/d", dir, "", batPath], { detached: true, stdio: "ignore", env }).unref();
}
// Run a shell command in a console window that stays open (/k), in `cwd`.
function runCmdWindow(cmdline, cwd) {
  spawn("cmd", ["/c", "start", "/d", cwd, "", "cmd", "/k", cmdline], { detached: true, stdio: "ignore" }).unref();
}
function newestUnity() {
  const base = "C:\\Program Files\\Unity\\Hub\\Editor";
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "Editor", "Unity.exe"))); } catch {}
  dirs.sort();
  return dirs.length ? path.join(base, dirs[dirs.length - 1], "Editor", "Unity.exe") : null;
}
function openUnity(proj) {
  const exe = newestUnity();
  if (!exe) { openTarget("unityhub://"); return "Unity editor not found — opened Unity Hub; add the GestureBlade folder."; }
  spawn(exe, ["-projectPath", proj], { detached: true, stdio: "ignore" }).unref();
  const ver = path.basename(path.dirname(path.dirname(exe)));
  return "Opening GestureBlade in Unity " + ver + " (loads the last-open scene = current state).";
}

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 900);
  });
}
async function ensureBridge() {
  if (await portOpen(7820)) return false; // already running
  runBatWindow(path.join(TB, "start-remote.bat"));
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await portOpen(7820)) return true; }
  throw new Error("Terminal Bridge didn't come up on :7820");
}
function tbOpen(cwd, name) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(TB, "tb.mjs"), "open", cwd, name], { cwd: TB });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim() || "tb.mjs exit " + code))));
  });
}
function readTunnelUrl(logPath) {
  try {
    const m = fs.readFileSync(logPath, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return m ? m[m.length - 1] : null;
  } catch { return null; }
}
// Read a plain current-url.txt (one https URL); returns null if missing/blank.
function readUrlFile(p) {
  try { const s = fs.readFileSync(p, "utf8").trim(); return /^https:\/\//i.test(s) ? s : null; } catch { return null; }
}
// Lenient reachability: a quick tunnel is flaky right after startup (transient
// 530s / DNS warmup), so don't condemn it on a single miss — probe a few times.
async function urlReachableLenient(url, suffix = "/", tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (await urlReachable(url, suffix)) return true;
    if (i < tries - 1) await sleep(1500);
  }
  return false;
}
// True if an HTTP(S) URL answers with any non-server-error status (it's reachable).
function urlReachable(url, suffix = "/") {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    try {
      const lib = url.startsWith("https") ? require("https") : require("http");
      const req = lib.get(url.replace(/\/$/, "") + suffix, { timeout: 9000 }, (r) => {
        r.resume(); finish(r.statusCode > 0 && r.statusCode < 500);
      });
      req.on("error", () => finish(false));
      req.on("timeout", () => { req.destroy(); finish(false); });
    } catch { finish(false); }
  });
}
// ── Bring-up helpers ────────────────────────────────────────────────────────
// Every launch returns a message IMMEDIATELY and finishes the heavy lifting
// (server boot, tunnel heal, open-in-Edge) in the BACKGROUND. The Project Tracker
// button only stays disabled for the ~1s the quick health-check takes — it is
// never stuck while a server or Cloudflare tunnel cold-starts (which can be 1-2min).
// The page is opened in Edge by the background worker the moment it's reachable.

// Background worker for a tunnel-backed app: ensure the local server AND the
// public tunnel are healthy, opening the local UI in Edge as soon as the port
// answers. The start .bat is IDEMPOTENT (skips a live server, only recycles a
// dead tunnel), so re-running it is always safe. Never throws (logs instead).
async function bringTunnelAppOnline({ port, startBat, urlFile, logPath, reachPath = "/", bootSecs = 45, tunnelSecs = 35, name, batEnv }) {
  const local = "http://127.0.0.1:" + port;
  try {
    const serverUp = await portOpen(port);
    const pub = (urlFile && readUrlFile(urlFile)) || (logPath && readTunnelUrl(logPath)) || null;
    const pubOk = serverUp && pub ? await urlReachableLenient(pub, reachPath) : false;
    if (serverUp && pubOk) { openTarget(local); return; }           // already healthy → just show it

    runBatWindow(startBat, batEnv);                                  // boot / heal
    let up = serverUp;
    for (let i = 0; i < bootSecs && !up; i++) { await sleep(1000); up = await portOpen(port); }
    if (up) openTarget(local);                                       // show the local UI the moment it answers
    else { console.log("[" + (name || "app") + "] :" + port + " never came up — check its launcher window."); return; }
    for (let i = 0; i < tunnelSecs; i++) {                           // best-effort: confirm the public tunnel
      await sleep(1000);
      const u = (urlFile && readUrlFile(urlFile)) || (logPath && readTunnelUrl(logPath));
      if (u && (await urlReachable(u, reachPath))) { console.log("[" + (name || "app") + "] public link: " + u); break; }
    }
  } catch (e) { console.log("[" + (name || "app") + "] bring-up: " + ((e && e.message) || e)); }
}

// Fast, non-blocking entry for tunnel apps (used by the USE handlers).
async function ensureTunnelApp(opts) {
  const local = "http://127.0.0.1:" + opts.port;
  const up = await portOpen(opts.port);     // single quick check, just for the toast wording
  bringTunnelAppOnline(opts);               // fire-and-forget; opens Edge when ready
  const app = opts.name || "App";
  if (up) return app + " is already running — opening it in Edge (" + local + ") and re-checking its public tunnel in the background.";
  return "Bringing " + app + " online (server + Cloudflare tunnel)… it'll open in Edge automatically once it's ready. A cold start can take up to a minute.";
}

// Background worker for a plain local web app (no tunnel): ensure the port is up,
// then open it in Edge. `start` is the caller's launcher. Never throws.
async function bringLocalAppOnline({ port, start, openUrl, bootSecs = 30, name }) {
  const url = openUrl || ("http://localhost:" + port);
  try {
    let up = await portOpen(port);
    if (!up && start) { start(); for (let i = 0; i < bootSecs && !up; i++) { await sleep(1000); up = await portOpen(port); } }
    openTarget(url);
  } catch (e) { console.log("[" + (name || "app") + "] bring-up: " + ((e && e.message) || e)); }
}

// Fast, non-blocking entry for plain local apps (used by the USE handlers).
async function ensureLocalApp(opts) {
  const url = opts.openUrl || ("http://localhost:" + opts.port);
  const up = await portOpen(opts.port);
  bringLocalAppOnline(opts);
  const app = opts.name || "App";
  return up ? app + " is running — opening it in Edge (" + url + ")."
            : "Starting " + app + " — it'll open in Edge automatically once it's ready.";
}

// ---- per-project "Use" sequences (keyed by normalized folder path) ---------
const USE = {
  [N(TB)]: async () => ensureLocalApp({
    name: "Terminal Bridge",
    port: 7820,
    openUrl: "http://localhost:7820",
    start: () => runBatWindow(path.join(TB, "start-remote.bat")),
  }),
  [N(HOME + "\\kana-flashcards")]: async () => { openTarget(HOME + "\\kana-flashcards\\index.html"); return "Opened Anpi locally (index.html) to view the current build."; },
  [N(HOME + "\\betlink")]: async () => { openTarget("https://join.anpieo7.workers.dev/admin"); return "Opened the AnpiesPicks admin cockpit (live)."; },
  [N(HOME + "\\dropship-command")]: async () => ensureTunnelApp({
    name: "dropship-command",
    port: 3000,
    startBat: HOME + "\\dropship-command\\start-remote.bat",
    logPath: HOME + "\\dropship-command\\tunnel.log",
    reachPath: "/",
    bootSecs: 150,   // first cold start runs `npm run build`
    tunnelSecs: 40,
  }),
  [N(HOME + "\\VN-Tools")]: async () => { openTarget(HOME + "\\Downloads\\vn-studio-hub.html"); return "Opened the VN Studio hub (tiles launch ComfyUI / Blender / Ren'Py)."; },
  [N(HOME + "\\fight-sync")]: async () => ensureTunnelApp({
    name: "FightSync",
    port: 8765,
    startBat: HOME + "\\fight-sync\\start-remote.bat",
    urlFile: HOME + "\\fight-sync\\current-url.txt",
    logPath: HOME + "\\fight-sync\\tunnel.log",
    reachPath: "/login",
    bootSecs: 45,
    tunnelSecs: 35,
    batEnv: { FIGHTSYNC_NOPAUSE: "1" },   // button-driven: don't leave a "press any key" window
  }),
  [N(HOME + "\\edge-finder")]: async () => { runCmdWindow("python main.py", HOME + "\\edge-finder"); return "Launched Edge Finder (python main.py — it auto-opens the browser)."; },
  [N(HOME + "\\GestureBlade")]: async () => openUnity(HOME + "\\GestureBlade"),
  [N(HOME + "\\diet-planner")]: async () => { runBatWindow(HOME + "\\diet-planner\\Gentle Plate.bat"); return "Launched Gentle Plate (diet planner + your vape tracker)."; },
  [N(HOME + "\\claude-control")]: async () => ensureLocalApp({
    name: "Claude Control",
    port: 7830,
    openUrl: "http://localhost:7830",
    start: () => runBatWindow(HOME + "\\claude-control\\start.bat"),
  }),
  [N(HOME + "\\build-service")]: async () => { openTarget(HOME + "\\build-service\\portfolio\\index.html"); return "Opened the Build Service portfolio page."; },
  [N(HOME + "\\project-tracker")]: async () => "You're already using Project Tracker 🙂 (this is it).",
};

// ---- http ------------------------------------------------------------------
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, obj, code = 200) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x");

  if (u.pathname === "/api/health") return json(res, { ok: true, configured: Object.keys(USE).length });

  if (u.pathname === "/" || u.pathname === "/index.html") {
    try { const html = fs.readFileSync(path.join(__dirname, "index.html")); res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }); return res.end(html); }
    catch { res.writeHead(404); return res.end("index.html not found"); }
  }

  if (req.method === "POST" && (u.pathname === "/api/session" || u.pathname === "/api/use")) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let d = {};
      try { d = JSON.parse(body || "{}"); } catch {}
      if (!d.path) return json(res, { ok: false, message: "This project has no local path set — add one in Edit." }, 400);
      try {
        if (u.pathname === "/api/session") {
          const started = await ensureBridge();
          const msg = await tbOpen(d.path, d.name || "");
          return json(res, { ok: true, message: (started ? "Started Terminal Bridge. " : "") + msg + ". View it in Terminal Bridge." });
        }
        const fn = USE[N(d.path)];
        let message;
        if (fn) message = await fn();
        else if (d.url) { openTarget(d.url); message = "No custom launch for this one — opened its live URL."; }
        else { openTarget(d.path); message = "No custom launch yet — opened the project folder."; }
        return json(res, { ok: true, message });
      } catch (e) {
        return json(res, { ok: false, message: String((e && e.message) || e) }, 500);
      }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log("Launcher already running on :" + PORT); process.exit(0); }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => console.log("Project Tracker launcher on http://127.0.0.1:" + PORT));
