'use strict';

// containerized-browser hub
// -------------------------
// One Node process, one exposed port (8080), three jobs:
//   1. launch Google Chrome — a normal desktop window on a virtual screen (Xvfb), not
//      --headless — with remote debugging on 127.0.0.1:9222
//   2. /cdp/*    -> reverse-proxy Chrome's CDP endpoint so Playwright (outside the
//                   container) can connectOverCDP without hitting Chrome's DNS-rebinding
//                   / host-header guard. The /json discovery responses are rewritten so
//                   the advertised WebSocket URLs point back at this hub.
//   3. /stream   -> a *separate* CDP client attaches to every open tab and
//                   screencasts whichever tabs the read-only viewers at / are watching
//                   (the agent's tab by default, any pinned tab, or all of them).
//
// Control (Playwright) and observation (screencast) are two independent CDP clients on
// the same Chrome. CDP allows that, so they don't fight.
//
// The controller is Patchright, a drop-in Playwright fork: stock Playwright sends
// CDP `Runtime.enable` to every page, and bot detection can see that a page's
// runtime is being watched. The screencaster only uses the Page domain, which
// pages can't observe.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const httpProxy = require('http-proxy');
const { WebSocket, WebSocketServer } = require('ws');
const pw = require('patchright-core'); // Playwright's API, minus its automation tells

const PORT = Number(process.env.PORT || 8080);
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const CHROME_HOST = '127.0.0.1';
const CHROME_PORT = Number(process.env.CHROME_PORT || 9222);
const CHROME_BASE = `http://${CHROME_HOST}:${CHROME_PORT}`;
// The virtual screen (headful) or window (HEADLESS=1) size.
const WIDTH = Number(process.env.VIEW_WIDTH || 1920);
const HEIGHT = Number(process.env.VIEW_HEIGHT || 1080);
const QUALITY = Number(process.env.VIEW_QUALITY || 60);
const HEADLESS = /^(1|true|yes)$/i.test(process.env.HEADLESS || '');
const DISPLAY = ':99'; // the Xvfb screen Chrome runs on
// Height of the strip at the bottom of the screen that the browser window leaves
// free, as a desktop taskbar would.
const TASKBAR = 40;
// Release version: an increasing integer `vN`, baked into the image by
// scripts/release.sh (version.txt is the source of truth; package.json's
// version is meaningless). Local/unreleased builds report `dev`.
const VERSION = process.env.CB_VERSION || 'dev';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 0. auth ---------------------------------------------------------------
//
// A single shared secret guards the WHOLE surface: the human's read-only viewer
// (/ , /stream) and the agent's control plane (/exec, /session, /cdp). It comes
// from $AUTH_PASSWORD; if unset we mint a random one and print it at boot so the
// tool is never silently unprotected.
//
// The same secret is accepted as any of (a request passes if one matches):
//   - `Authorization: Bearer <secret>`  (agent / curl)
//   - `Authorization: Basic <user:secret>` (`curl -u any:<secret>`)
//   - cookie `cb_auth=<secret>`          (set by the login page and on every
//                                          authed response, so the /stream
//                                          WebSocket handshake — which can't
//                                          carry an Authorization header —
//                                          authenticates automatically)
//   - `?token=<secret>` query param      (WebSocket clients / quick curl)
//
// Humans never see a native browser auth prompt: an unauthenticated page load
// gets the login page (public/login.html), which POSTs to /login for the cookie.

const COOKIE_NAME = 'cb_auth';
let AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const AUTH_GENERATED = !AUTH_PASSWORD;
if (AUTH_GENERATED) AUTH_PASSWORD = crypto.randomBytes(18).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // length leak is unavoidable; the timing-safe compare needs equal lengths
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Every secret the request carries. All are checked, so a stale credential in
// one place (say, old cached Basic auth) can't shadow a good login cookie.
function presentedSecrets(req) {
  const found = [];
  const h = req.headers['authorization'];
  if (h) {
    const sp = h.indexOf(' ');
    const scheme = (sp === -1 ? h : h.slice(0, sp)).toLowerCase();
    const val = sp === -1 ? '' : h.slice(sp + 1).trim();
    if (scheme === 'bearer' && val) found.push(val);
    if (scheme === 'basic' && val) {
      const dec = Buffer.from(val, 'base64').toString();
      const i = dec.indexOf(':');               // strip the username
      found.push(i === -1 ? dec : dec.slice(i + 1));
    }
  }
  const cookie = req.headers['cookie'];
  if (cookie) {
    for (const part of cookie.split(';')) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      if (part.slice(0, i).trim() === COOKIE_NAME) {
        try { found.push(decodeURIComponent(part.slice(i + 1).trim())); } catch (_) {}
      }
    }
  }
  try {
    const t = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (t) found.push(t);
  } catch (_) {}
  return found;
}

function isAuthed(req) {
  return presentedSecrets(req).some((s) => safeEqual(s, AUTH_PASSWORD));
}

const authCookie = () =>
  `${COOKIE_NAME}=${encodeURIComponent(AUTH_PASSWORD)}; Path=/; HttpOnly; SameSite=Strict`;

// --- 1. launch Chrome ------------------------------------------------------
//
// By default Chrome runs headFUL on a virtual X display (Xvfb), not with
// --headless. Sites that block bots look for headless tells — "HeadlessChrome"
// in the user agent, a screen smaller than the window, no mouse, no scrollbars,
// no WebGL — and a real browser window on a real (virtual) screen has none of
// them: it is the same desktop Chrome a person would run. HEADLESS=1 brings
// back the old --headless mode.

async function startDisplay() {
  const socket = '/tmp/.X11-unix/X' + DISPLAY.slice(1);
  // after `docker restart` the previous server's lock and socket are still here
  for (const f of [`/tmp/.X${DISPLAY.slice(1)}-lock`, socket]) fs.rmSync(f, { force: true });
  // -noreset: keep the root window's properties (the work area set below) when
  // the last X client disconnects
  const args = [DISPLAY, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-noreset'];
  log('launching Xvfb:', args.join(' '));
  const proc = spawn('Xvfb', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('exit', (code) => {
    log(`Xvfb exited (${code}) — shutting down hub`);
    process.exit(code ?? 1);
  });
  for (let i = 0; !fs.existsSync(socket); i++) {
    if (i === 100) throw new Error('Xvfb did not come up on ' + DISPLAY);
    await sleep(100);
  }
  // Every real desktop has a taskbar or panel, so screen.availHeight is less
  // than screen.height. Reserve one, the way a window manager announces it.
  const workArea = `0, 0, ${WIDTH}, ${HEIGHT - TASKBAR}`;
  await new Promise((resolve, reject) => execFile('xprop',
    ['-display', DISPLAY, '-root', '-f', '_NET_WORKAREA', '32c', '-set', '_NET_WORKAREA', workArea],
    (e) => (e ? reject(e) : resolve())));
}

function launchChrome() {
  const mode = HEADLESS
    ? ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${WIDTH},${HEIGHT}`]
    : [
        // one maximized window: the whole screen above the taskbar
        '--window-position=0,0',
        `--window-size=${WIDTH},${HEIGHT - TASKBAR}`,
        // no first-run, default-browser, keyring or "restore pages?" prompts
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--hide-crash-restore-bubble',
        // WebGL on Mesa's software renderer (llvmpipe), like a desktop without
        // a GPU driver. Chrome blocklists it, and no WebGL at all is a bot tell.
        '--ignore-gpu-blocklist',
      ];
  const args = [
    ...mode,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // tabs the agent drives or a viewer watches keep running at full speed,
    // even when they are behind another tab or window
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--remote-debugging-address=${CHROME_HOST}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    '--remote-allow-origins=*', // Chrome 111+ rejects the CDP WS upgrade without this
    '--user-data-dir=/tmp/cdp-profile',
    ...(process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean),
    'about:blank',
  ];
  log('launching chrome:', CHROME_BIN, args.join(' '));
  const env = HEADLESS ? process.env : { ...process.env, DISPLAY };
  const proc = spawn(CHROME_BIN, args, { env, stdio: ['ignore', 'inherit', 'pipe'] });
  // A container has no D-Bus, and headful Chrome logs an ERROR line for every
  // failed attempt to reach it. Drop those; pass everything else through.
  readline.createInterface({ input: proc.stderr }).on('line', (line) => {
    if (!/:ERROR:dbus\//.test(line)) process.stderr.write(line + '\n');
  });
  proc.on('exit', (code) => {
    log(`chrome exited (${code}) — shutting down hub`);
    process.exit(code ?? 1);
  });
  return proc;
}

async function waitForChrome() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${CHROME_BASE}/json/version`);
      if (r.ok) return r.json();
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('Chrome did not become ready on ' + CHROME_BASE);
}

// --- minimal CDP client (raw WebSocket) ------------------------------------

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this._id = 0;
    this._pending = new Map();
    this._handlers = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else {
        for (const h of this._handlers) h(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(fn) { this._handlers.push(fn); }
}

// --- 3. screencast: one CDP client, every tab, frames routed per viewer -----
//
// The hub tracks EVERY page target (tab), not just the newest. Each viewer picks
// what it watches — `follow` (whatever tab the agent's `page` is; the default),
// specific tab ids, or `all` (grid) — and the hub screencasts exactly the union of
// what viewers watch, so tabs nobody is looking at cost nothing.
//
// Chrome only emits screencast frames when a page repaints, so a viewer joining a
// static page used to see nothing. Now a tab that starts streaming gets Chrome's
// initial frame (with a captureScreenshot fallback), and a tab that is already
// streaming hands its cached last frame to anyone who starts watching it.
//
// /stream wire format — JSON text messages:
//   hub -> viewer : { type: 'tabs', agent: <id|null>, tabs: [{ id, title, url }] }
//                   { type: 'frame', id, data: <base64 jpeg> }
//   viewer -> hub : { type: 'watch', follow: true } | { type: 'watch', all: true }
//                   | { type: 'watch', ids: [id, ...] }

const tabs = new Map();    // targetId -> { id, title, url, sessionId, streaming, lastFrame }
const viewers = new Map(); // ws -> { watch: {follow}|{all}|{ids}, shown: Set<targetId> }
let agentTab = null;       // targetId of the controller's current `page`
let castCdp = null;        // the screencaster's CDP client

const isLive = (t) => !!(t && t.sessionId); // attached and ready to screencast

function sendJson(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const frameMsg = (id, data) => JSON.stringify({ type: 'frame', id, data });

function sendFrame(ws, msg) {
  // drop frames for a viewer that can't keep up rather than buffer without bound
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(msg);
}

function tabsMessage() {
  const list = [...tabs.values()].filter(isLive).map(({ id, title, url }) => ({ id, title, url }));
  return { type: 'tabs', agent: agentTab, tabs: list };
}

function broadcastTabs() {
  const msg = tabsMessage();
  for (const ws of viewers.keys()) sendJson(ws, msg);
}

function watchedIds(v) {
  const live = [...tabs.values()].filter(isLive).map((t) => t.id);
  if (v.watch.all) return new Set(live);
  if (v.watch.ids) return new Set(v.watch.ids.filter((id) => isLive(tabs.get(id))));
  // follow: the agent's tab; until the controller has reported one, the newest tab
  const id = agentTab ?? live[live.length - 1];
  return new Set(isLive(tabs.get(id)) ? [id] : []);
}

// Recompute what every viewer sees, give each newly watched tab's cached frame
// immediately, then start/stop per-tab screencasts so exactly the watched tabs stream.
function refreshViewers() {
  const needed = new Set();
  for (const [ws, v] of viewers) {
    const next = watchedIds(v);
    for (const id of next) {
      needed.add(id);
      const t = tabs.get(id);
      if (!v.shown.has(id) && t.lastFrame) sendFrame(ws, frameMsg(id, t.lastFrame));
    }
    v.shown = next;
  }
  for (const t of tabs.values()) {
    if (!isLive(t)) continue;
    if (needed.has(t.id) && !t.streaming) startCast(t);
    else if (!needed.has(t.id) && t.streaming) stopCast(t);
  }
}

function onFrame(t, data) {
  t.lastFrame = data;
  const msg = frameMsg(t.id, data); // serialize once, not per viewer
  for (const [ws, v] of viewers) if (v.shown.has(t.id)) sendFrame(ws, msg);
}

async function startCast(t) {
  t.streaming = true;
  try {
    await castCdp.send('Page.startScreencast',
      { format: 'jpeg', quality: QUALITY, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 },
      t.sessionId);
  } catch (e) {
    t.streaming = false;
    log('screencast start failed:', e.message);
    return;
  }
  // Chrome normally emits one frame right away even for a static page; if it
  // doesn't (e.g. mid-navigation), grab one so the viewer is never left blank.
  setTimeout(async () => {
    if (!t.streaming || t.lastFrame || tabs.get(t.id) !== t) return;
    try {
      const { data } = await castCdp.send('Page.captureScreenshot',
        { format: 'jpeg', quality: QUALITY }, t.sessionId);
      if (t.streaming && !t.lastFrame) onFrame(t, data);
    } catch (_) {}
  }, 1000);
}

function stopCast(t) {
  t.streaming = false;
  t.lastFrame = null; // would go stale while not streaming
  castCdp.send('Page.stopScreencast', {}, t.sessionId).catch(() => {});
}

function setAgentTab(id) {
  if (id === agentTab) return;
  agentTab = id;
  broadcastTabs(); // before any frame of the new tab, so follow-mode viewers relabel first
  refreshViewers();
}

async function startScreencaster() {
  const ver = await fetch(`${CHROME_BASE}/json/version`).then((r) => r.json());
  const cdp = (castCdp = new CDP(ver.webSocketDebuggerUrl));
  await cdp.ready;

  const isTab = (info) => info.type === 'page' && info.subtype !== 'prerender';

  // -> true if a live tab's title/url changed (i.e. viewers need a new tab list)
  function updateInfo(info) {
    const t = tabs.get(info.targetId);
    if (!t || (t.title === info.title && t.url === info.url)) return false;
    t.title = info.title;
    t.url = info.url;
    return isLive(t);
  }

  async function attach(info) {
    if (tabs.has(info.targetId)) return;
    const t = { id: info.targetId, title: info.title, url: info.url,
      sessionId: null, streaming: false, lastFrame: null };
    tabs.set(t.id, t); // not live until attached; title/url updates still land on it
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.id, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      if (tabs.get(t.id) !== t) return; // closed while we were attaching
      t.sessionId = sessionId;
      broadcastTabs();
      refreshViewers();
    } catch (e) {
      if (tabs.get(t.id) === t) tabs.delete(t.id);
      log('attach failed:', e.message);
    }
  }

  cdp.on((msg) => {
    const p = msg.params || {};
    if (msg.method === 'Page.screencastFrame') {
      // MUST ack or Chrome stops sending frames
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, msg.sessionId).catch(() => {});
      for (const t of tabs.values()) {
        if (t.sessionId === msg.sessionId) { if (t.streaming) onFrame(t, p.data); break; }
      }
    } else if (msg.method === 'Target.targetCreated' && isTab(p.targetInfo)) {
      attach(p.targetInfo);
    } else if (msg.method === 'Target.targetInfoChanged') {
      if (updateInfo(p.targetInfo)) broadcastTabs();
    } else if (msg.method === 'Target.targetDestroyed') {
      const t = tabs.get(p.targetId);
      if (t) {
        tabs.delete(p.targetId);
        t.streaming = false;
        if (isLive(t)) { broadcastTabs(); refreshViewers(); }
      }
    }
  });

  // discovery reports every existing tab as targetCreated, then keeps us posted
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  // ...except about <title> changes, which Chrome doesn't announce. Poll for
  // them, but only while someone is looking at the tab strip.
  setInterval(async () => {
    if (!viewers.size) return;
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      let changed = false;
      for (const info of targetInfos) changed = updateInfo(info) || changed;
      if (changed) broadcastTabs();
    } catch (_) {}
  }, 1000);
  log('screencaster ready');
}

// --- 2b. controller: drive the page via Playwright, expose POST /exec -------
//
// A single in-container Playwright client attaches to the SAME Chrome the viewer
// is screencasting. POST /exec runs an arbitrary async JS snippet with
// { page, context, browser, log } in scope and returns the JSON result, so an
// LLM agent on the host needs nothing but `curl` — no Playwright, no npm, no
// node on the host side. Every SUCCESSFUL snippet is recorded so the session can
// later be rendered into a standalone script (GET /session).

const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
let pwBrowser = null;
let currentPage = null;
const session = []; // [{ ts, code }] — successful /exec snippets, in order

function allPages() {
  return pwBrowser ? pwBrowser.contexts().flatMap((c) => c.pages()) : [];
}

// Map a Playwright Page to its CDP targetId, so the viewer can mark (and follow)
// the tab the agent is driving.
const targetIds = new WeakMap();
async function targetIdOf(page) {
  if (!targetIds.has(page)) {
    const s = await page.context().newCDPSession(page);
    try {
      targetIds.set(page, (await s.send('Target.getTargetInfo')).targetInfo.targetId);
    } finally {
      s.detach().catch(() => {});
    }
  }
  return targetIds.get(page);
}

// Publish which tab `page` currently is. Never throws; fire-and-forget is fine.
async function syncAgentTab() {
  const p = currentPage;
  let id = null;
  if (p && !p.isClosed()) {
    try { id = await targetIdOf(p); } catch (_) { return; }
  }
  if (p === currentPage) setAgentTab(id); // a newer sync owns it otherwise
}

function wireContext(ctx) {
  ctx.on('page', (p) => {            // newest page wins; follow-mode viewers go with it
    currentPage = p;
    syncAgentTab();
    p.on('close', () => {
      if (currentPage === p) currentPage = allPages().slice(-1)[0] || null;
      syncAgentTab();
    });
  });
}

async function startController() {
  pwBrowser = await pw.chromium.connectOverCDP(CHROME_BASE);
  pwBrowser.contexts().forEach(wireContext);
  const ctx = pwBrowser.contexts()[0] || (await pwBrowser.newContext());
  currentPage = ctx.pages()[0] || (await ctx.newPage());
  await syncAgentTab();
  log('controller ready (playwright attached over CDP)');
}

async function getPage() {
  if (!currentPage || currentPage.isClosed()) {
    currentPage = allPages().slice(-1)[0] || null;
    if (!currentPage) {
      const ctx = pwBrowser.contexts()[0] || (await pwBrowser.newContext());
      currentPage = await ctx.newPage();
    }
  }
  return currentPage;
}

function readBody(req, limit = Infinity) {
  return new Promise((resolve, reject) => {
    let d = '';
    const onData = (c) => {
      d += c;
      // over the cap: stop buffering, drain the rest unread and let the caller answer
      if (d.length > limit) { req.off('data', onData); req.resume(); reject(new Error('body too large')); }
    };
    req.on('data', onData);
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function jsonSafe(v) {
  if (v === undefined) return null;
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`exec timeout after ${ms}ms`)), ms)),
  ]);
}

// Sniff a content-type from a binary result's magic bytes (png/jpeg/pdf).
function sniffContentType(buf) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  }
  return 'application/octet-stream';
}

async function handleExec(req, res) {
  const code = await readBody(req);
  const logs = [];
  try {
    const page = await getPage();
    const context = page.context();
    const fn = new AsyncFn('page', 'context', 'browser', 'log', code);
    const ms = Number(req.headers['x-exec-timeout'] || 30000);
    const result = await withTimeout(
      fn(page, context, pwBrowser, (...a) => logs.push(a.map(String).join(' '))),
      ms,
    );
    // A Buffer/typed-array result (e.g. page.screenshot()/page.pdf()) is an
    // observation, not a state change: stream the raw bytes and don't record it.
    if (Buffer.isBuffer(result) || ArrayBuffer.isView(result)) {
      const buf = Buffer.from(result.buffer || result);
      res.writeHead(200, { 'content-type': sniffContentType(buf) });
      res.end(buf);
      return;
    }
    session.push({ ts: Date.now(), code }); // record only successful, non-binary steps
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: jsonSafe(result), logs }));
  } catch (e) {
    // 422 so `curl -f -o file` won't overwrite the target with an error body.
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message, stack: e.stack, logs }));
  } finally {
    syncAgentTab(); // the snippet may have opened/closed tabs or re-pointed `page`
  }
}

// --- 2. CDP reverse proxy + static viewer ----------------------------------

const cdpProxy = httpProxy.createProxyServer({ target: CHROME_BASE, ws: true });
cdpProxy.on('error', (e) => log('cdp proxy error:', e.message));

const STATIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

// The agent-facing operating manual, served self-describingly at GET /guide.
const GUIDE = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'GUIDE.md'), 'utf8'); }
  catch { return '# guide unavailable\n'; }
})();

function serveStatic(res, pathname) {
  // `pathname` is query-free: `/?token=...` must map to index.html, not to the
  // public/ directory itself (reading a directory throws EISDIR and kills the hub).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = path.join(STATIC_DIR, path.normalize(rel));
  let isFile = false;
  try { isFile = file.startsWith(STATIC_DIR + path.sep) && fs.statSync(file).isFile(); } catch (_) {}
  if (!isFile) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// The human-facing login form. Served in place of any page an unauthenticated
// browser asks for (so it lands back on that page after signing in), and at
// /login itself.
function sendLoginPage(res, status) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(STATIC_DIR, 'login.html')).on('error', () => res.end()).pipe(res);
}

// A page navigation from a browser, as opposed to curl / fetch / an agent.
const wantsHtml = (req) => req.method === 'GET' && /\btext\/html\b/.test(req.headers['accept'] || '');

// POST /login with a form-encoded `password`: 204 + auth cookie, or 401.
async function handleLogin(req, res) {
  let body;
  try { body = await readBody(req, 4096); } catch (_) {
    res.writeHead(413, { connection: 'close' }).end();
    return;
  }
  const pw = new URLSearchParams(body).get('password') || '';
  if (!safeEqual(pw, AUTH_PASSWORD)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'wrong password' }));
    return;
  }
  res.writeHead(204, { 'Set-Cookie': authCookie() });
  res.end();
}

async function handleCdpJson(req, res, host) {
  // forward Chrome's /json discovery, rewrite advertised ws urls back to this hub
  const upstream = req.url.replace(/^\/cdp/, '');
  const r = await fetch(`${CHROME_BASE}${upstream}`, { method: req.method });
  let body = await r.text();
  body = body.split(`ws://${CHROME_HOST}:${CHROME_PORT}`).join(`ws://${host}/cdp`);
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    // /guide is just the operating manual: it must be readable WITHOUT the
    // password so a fresh agent can fetch it and learn how to authenticate.
    if (p === '/guide') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(GUIDE);
      return;
    }
    if (p === '/login') {
      if (req.method === 'POST') await handleLogin(req, res);
      else if (isAuthed(req)) res.writeHead(303, { location: '/' }).end();
      else sendLoginPage(res, 200);
      return;
    }
    if (!isAuthed(req)) {
      if (wantsHtml(req)) { sendLoginPage(res, 401); return; }
      // Bearer, not Basic: Basic would make browsers pop their native prompt.
      res.writeHead(401, {
        'WWW-Authenticate': 'Bearer realm="containerized-browser"',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('401 Unauthorized — supply the password (Bearer token, ?token=, or Basic auth).\n');
      return;
    }
    // Bridge every authed request (e.g. /?token=…) to the cookie that the
    // /stream WS handshake needs.
    res.setHeader('Set-Cookie', authCookie());
    if (p === '/exec' && req.method === 'POST') {
      await handleExec(req, res);
    } else if (p === '/version' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: VERSION }));
    } else if (p === '/session' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ steps: session }));
    } else if (p === '/session/reset' && req.method === 'POST') {
      session.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (p.startsWith('/cdp/json')) {
      await handleCdpJson(req, res, req.headers.host);
    } else if (p.startsWith('/cdp')) {
      req.url = req.url.replace(/^\/cdp/, '') || '/';
      cdpProxy.web(req, res);
    } else {
      serveStatic(res, p);
    }
  } catch (e) {
    log('http error:', e.message);
    res.writeHead(500).end(e.message);
  }
});

const streamWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
streamWss.on('connection', (ws) => {
  viewers.set(ws, { watch: { follow: true }, shown: new Set() });
  log(`viewer connected (${viewers.size} total)`);
  sendJson(ws, tabsMessage());
  refreshViewers(); // a newcomer gets the current frame now, not on the next repaint
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    const v = viewers.get(ws);
    if (!v || !m || m.type !== 'watch') return;
    v.watch = m.all ? { all: true }
      : Array.isArray(m.ids) ? { ids: m.ids.map(String) }
      : { follow: true };
    refreshViewers();
  });
  ws.on('close', () => {
    viewers.delete(ws);
    refreshViewers(); // stop screencasting tabs nobody watches any more
    log(`viewer left (${viewers.size} total)`);
  });
  ws.on('error', () => {});
});

server.on('upgrade', (req, socket, head) => {
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // route on the pathname so a `?token=` auth query doesn't break matching
  const upath = new URL(req.url, 'http://localhost').pathname;
  if (upath === '/stream') {
    streamWss.handleUpgrade(req, socket, head, (ws) => streamWss.emit('connection', ws, req));
  } else if (upath.startsWith('/cdp/devtools')) {
    req.url = req.url.replace(/^\/cdp/, '');
    cdpProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

// --- boot ------------------------------------------------------------------

(async () => {
  log(`containerized-browser ${VERSION} starting`);
  if (!HEADLESS) await startDisplay();
  launchChrome();
  await waitForChrome();
  await startScreencaster();
  await startController();
  server.listen(PORT, () => {
    log(`hub ${VERSION} listening on http://0.0.0.0:${PORT}`);
    log(`  viewer (read-only) : http://localhost:${PORT}/`);
    log(`  agent guide        : http://localhost:${PORT}/guide`);
    log(`  drive (code in)    : POST http://localhost:${PORT}/exec`);
    log(`  CDP for Playwright : http://localhost:${PORT}/cdp`);
    const banner = [
      '',
      '  ┌─────────────────────────────────────────────────────────────┐',
      '  │  AUTH ENABLED — every endpoint requires this password/token  │',
      `  │  password: ${AUTH_PASSWORD.padEnd(48)} │`,
      AUTH_GENERATED
        ? '  │  (auto-generated; set $AUTH_PASSWORD to pin your own)        │'
        : '  │  (from $AUTH_PASSWORD)                                       │',
      '  │  viewer: open / in a browser and enter it as the password    │',
      '  │  agent : -H "Authorization: Bearer <password>"  (or ?token=) │',
      '  └─────────────────────────────────────────────────────────────┘',
      '',
    ];
    for (const line of banner) console.log(line);
    // Clean, machine-readable line so `docker logs | grep` extracts the exact
    // secret (the boxed line above is padded/bordered and grep-hostile).
    console.log(`AUTH_PASSWORD=${AUTH_PASSWORD}`);
    console.log(`VERSION=${VERSION}`); // same grep-friendly form: which release is running
  });
})().catch((e) => { log('fatal:', e); process.exit(1); });
