'use strict';

// containerized-browser hub
// -------------------------
// One Node process, one exposed port (8080), three jobs:
//   1. launch a headless Chromium with remote debugging on 127.0.0.1:9222
//   2. /cdp/*    -> reverse-proxy Chrome's CDP endpoint so Playwright (outside the
//                   container) can connectOverCDP without hitting Chrome's DNS-rebinding
//                   / host-header guard. The /json discovery responses are rewritten so
//                   the advertised WebSocket URLs point back at this hub.
//   3. /stream   -> a *separate* CDP client attaches to the live page, runs
//                   Page.startScreencast, and broadcasts JPEG frames to every browser
//                   watching the read-only viewer at /.
//
// Control (Playwright) and observation (screencast) are two independent CDP clients on
// the same Chrome. CDP allows that, so they don't fight.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');
const { WebSocket, WebSocketServer } = require('ws');
const pw = require('playwright-core');

const PORT = Number(process.env.PORT || 8080);
const CHROME_BIN = process.env.CHROME_BIN || '/usr/bin/chromium';
const CHROME_HOST = '127.0.0.1';
const CHROME_PORT = Number(process.env.CHROME_PORT || 9222);
const CHROME_BASE = `http://${CHROME_HOST}:${CHROME_PORT}`;
const WIDTH = Number(process.env.VIEW_WIDTH || 1280);
const HEIGHT = Number(process.env.VIEW_HEIGHT || 800);
const QUALITY = Number(process.env.VIEW_QUALITY || 60);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 0. auth ---------------------------------------------------------------
//
// A single shared secret guards the WHOLE surface: the human's read-only viewer
// (/ , /stream) and the agent's control plane (/exec, /session, /cdp). It comes
// from $AUTH_PASSWORD; if unset we mint a random one and print it at boot so the
// tool is never silently unprotected.
//
// The same secret is accepted as, in priority order:
//   - `Authorization: Bearer <secret>`  (agent / curl)
//   - `Authorization: Basic <user:secret>` (browser native login — any username)
//   - cookie `cb_auth=<secret>`          (set after a browser logs in, so the
//                                          /stream WebSocket handshake — which
//                                          can't carry an Authorization header —
//                                          authenticates automatically)
//   - `?token=<secret>` query param      (WebSocket clients / quick curl)

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

function presentedSecret(req) {
  const h = req.headers['authorization'];
  if (h) {
    const sp = h.indexOf(' ');
    const scheme = (sp === -1 ? h : h.slice(0, sp)).toLowerCase();
    const val = sp === -1 ? '' : h.slice(sp + 1).trim();
    if (scheme === 'bearer' && val) return val;
    if (scheme === 'basic' && val) {
      const dec = Buffer.from(val, 'base64').toString();
      const i = dec.indexOf(':');               // strip the username
      return i === -1 ? dec : dec.slice(i + 1);
    }
  }
  const cookie = req.headers['cookie'];
  if (cookie) {
    for (const part of cookie.split(';')) {
      const i = part.indexOf('=');
      if (i === -1) continue;
      if (part.slice(0, i).trim() === COOKIE_NAME) {
        return decodeURIComponent(part.slice(i + 1).trim());
      }
    }
  }
  try {
    const t = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (t) return t;
  } catch (_) {}
  return null;
}

function isAuthed(req) {
  const s = presentedSecret(req);
  return s != null && safeEqual(s, AUTH_PASSWORD);
}

// --- 1. launch Chromium ----------------------------------------------------

function launchChrome() {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-address=${CHROME_HOST}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    '--remote-allow-origins=*', // Chrome 111+ rejects the CDP WS upgrade without this
    `--window-size=${WIDTH},${HEIGHT}`,
    '--user-data-dir=/tmp/cdp-profile',
    'about:blank',
  ];
  log('launching chromium:', CHROME_BIN, args.join(' '));
  const proc = spawn(CHROME_BIN, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('exit', (code) => {
    log(`chromium exited (${code}) — shutting down hub`);
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
  throw new Error('Chromium did not become ready on ' + CHROME_BASE);
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

// --- 3. screencast: one CDP client -> all viewers --------------------------

const viewers = new Set();
function broadcast(b64) {
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) {
      ws.send(b64);
    }
  }
}

async function startScreencaster() {
  const ver = await fetch(`${CHROME_BASE}/json/version`).then((r) => r.json());
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  let session = null;   // active CDP session id
  let target = null;    // active page target id

  async function attach(targetId) {
    if (target === targetId) return;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    session = sessionId;
    target = targetId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.startScreencast',
      { format: 'jpeg', quality: QUALITY, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 },
      sessionId);
    log('screencast attached to page', targetId);
  }

  cdp.on(async (msg) => {
    try {
      if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page') {
        // newest page wins (e.g. Playwright opened a fresh tab)
        await attach(msg.params.targetInfo.targetId);
      } else if (msg.method === 'Target.targetDestroyed' && msg.params.targetId === target) {
        session = null; target = null;
        const { targetInfos } = await cdp.send('Target.getTargets');
        const page = targetInfos.find((t) => t.type === 'page');
        if (page) await attach(page.targetId);
      } else if (msg.method === 'Page.screencastFrame' && msg.sessionId === session) {
        broadcast(msg.params.data);
        // MUST ack or Chrome stops sending frames
        cdp.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, session).catch(() => {});
      }
    } catch (e) {
      log('screencaster error:', e.message);
    }
  });

  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  if (page) await attach(page.targetId);
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

function wireContext(ctx) {
  ctx.on('page', (p) => {            // newest page wins, matching the viewer
    currentPage = p;
    p.on('close', () => { if (currentPage === p) currentPage = allPages().slice(-1)[0] || null; });
  });
}

async function startController() {
  pwBrowser = await pw.chromium.connectOverCDP(CHROME_BASE);
  pwBrowser.contexts().forEach(wireContext);
  const ctx = pwBrowser.contexts()[0] || (await pwBrowser.newContext());
  currentPage = ctx.pages()[0] || (await ctx.newPage());
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
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

function serveStatic(req, res) {
  const rel = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '').split('?')[0];
  const file = path.join(STATIC_DIR, path.normalize(rel));
  if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
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
    if (!isAuthed(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="containerized-browser", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('401 Unauthorized — supply the password (Basic auth, Bearer token, or ?token=).\n');
      return;
    }
    // Bridge browser logins to the cookie that the /stream WS handshake needs.
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(AUTH_PASSWORD)}; Path=/; HttpOnly; SameSite=Strict`);
    if (p === '/exec' && req.method === 'POST') {
      await handleExec(req, res);
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
      serveStatic(req, res);
    }
  } catch (e) {
    log('http error:', e.message);
    res.writeHead(500).end(e.message);
  }
});

const streamWss = new WebSocketServer({ noServer: true });
streamWss.on('connection', (ws) => {
  viewers.add(ws);
  log(`viewer connected (${viewers.size} total)`);
  ws.on('close', () => { viewers.delete(ws); log(`viewer left (${viewers.size} total)`); });
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
  launchChrome();
  await waitForChrome();
  await startScreencaster();
  await startController();
  server.listen(PORT, () => {
    log(`hub listening on http://0.0.0.0:${PORT}`);
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
  });
})().catch((e) => { log('fatal:', e); process.exit(1); });
