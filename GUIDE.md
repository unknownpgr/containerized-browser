# Operating guide for the agent driving this container

You are an LLM agent (e.g. Claude Code) running on a host that has `docker` and a
shell. This container is a **human-observable, isolated Chromium** that you drive
by **POSTing JavaScript to an HTTP surface** and reading JSON back. You need
nothing installed on the host except a shell with `curl` — no Playwright, no
node, no npm.

Throughout this guide the container is assumed to be reachable at
`http://localhost:8080` (the port the user mapped with `docker run -p 8080:8080`).
If a different host/port was used, substitute it everywhere.

---

## 0. FIRST — orient the user (do this before anything else)

The user may have only seen a bootstrap URL and nothing else, so they can be
confused about what just happened. Before you start driving the browser, tell
them, briefly and in their language:

- **What this is**: a real Chromium running inside a container that you (the
  agent) will drive on their behalf. They watch; they don't have to click.
- **How to watch**: open **http://localhost:8080/** in their browser — it is a
  live, read-only screencast of the page you are controlling. Give them the
  exact URL/port that is actually in use.
- **The workflow**: first you'll explore the site together by conversation
  (phase 1); then, on request, you'll turn what you did into a standalone script
  they can re-run later (phase 2).
- **Read-only viewer**: their browser tab only *watches*; corrections go through
  the chat with you, not by clicking in the viewer.

Then proceed.

---

## 1. Drive the page — `POST /exec`

Send a snippet of async JavaScript. It runs in the container against the live
page with these bindings in scope:

| binding   | what it is                                                        |
|-----------|-------------------------------------------------------------------|
| `page`    | the current Playwright `Page` (newest tab wins, follows new tabs)  |
| `context` | its `BrowserContext`                                               |
| `browser` | the Playwright `Browser`                                          |
| `log(...)`| push a debug line into the response's `logs[]`                     |

The snippet is an **async function body**, so you may `await` and `return`. The
return value is sent back as JSON (`result`). Example:

```bash
curl -s -X POST localhost:8080/exec --data-binary @- <<'JS'
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
return { title: await page.title(), url: page.url() };
JS
# -> {"ok":true,"result":{"title":"Example Domain","url":"https://example.com/"},"logs":[]}
```

Response shape:

- success (non-binary): `200` `{ "ok": true, "result": <json|null>, "logs": [...] }`
- success (Buffer result): `200` with raw bytes — see §2
- failure: `422` `{ "ok": false, "error": "...", "stack": "...", "logs": [...] }`
  (use plain `curl -s` for JSON calls so you still get the error body to fix it)

Notes:
- **State persists** between calls — cookies, the open page, scroll position all
  live in the container's Chromium. Build up a task across many small `/exec`
  calls.
- The return value must be JSON-serializable. To inspect a DOM element, return a
  derived value (`await page.locator('h1').innerText()`), not the handle itself.
- Default per-call timeout is 30s; override with header `X-Exec-Timeout: 60000`.
- Only **successful** snippets are recorded for phase 2 (see §3). Failed
  experiments don't pollute the eventual script.
- Keep selectors stable and human-meaningful (roles, text, labels) so the
  generated script stays robust:
  `page.getByRole('button', { name: 'Sign in' })`, `page.getByLabel('Email')`.

---

## 2. See the page — same `/exec`, just return bytes

Visual feedback matters. There is **no separate screenshot/pdf endpoint** — a
screenshot or PDF is simply an `/exec` snippet that **returns a Buffer**. When
the result is binary, `/exec` streams the raw bytes with a sniffed content-type
(`image/png`, `image/jpeg`, `application/pdf`) instead of JSON. Download it to a
file and open it (your Read/file-view tool can display PNG/JPEG/PDF). Use
`-f` so an error never overwrites your file:

```bash
curl -fs -X POST localhost:8080/exec --data-binary 'return await page.screenshot()' -o /tmp/page.png
curl -fs -X POST localhost:8080/exec --data-binary 'return await page.screenshot({ fullPage: true })' -o /tmp/full.png
curl -fs -X POST localhost:8080/exec --data-binary 'return await page.locator("#main").screenshot()' -o /tmp/el.png
curl -fs -X POST localhost:8080/exec --data-binary 'return await page.pdf({ format: "A4" })' -o /tmp/page.pdf
```

Because it's just `page`/`locator` you have the full Playwright API (clip,
element shots, jpeg quality, etc.). Binary results are observations, so they are
**not** recorded into the session. The human is also watching everything live at
`/` — use that and screenshots together.

---

## 3. Turn the session into a script — phase 2 (codify)

When the user asks to "make a script / automate this", fetch the recorded steps:

```bash
curl -s localhost:8080/session     # -> { "steps": [ { "ts": ..., "code": "..." }, ... ] }
```

Each `code` is a Playwright snippet you already ran successfully, in order.
Render them into a **standalone `.js` file that assumes this container is running
at a host:port** and reproduces the task. Default to a `playwright-core`
client that attaches over CDP:

```js
// flow.js — run with: CDP=http://localhost:8080/cdp node flow.js [args]
// requires once on the runner:  npm i playwright-core
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP(process.env.CDP || 'http://localhost:8080/cdp');
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // ---- recorded steps from /session, cleaned up & parameterized ----
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  // ...

  await browser.close();           // detaches; does NOT kill the container
})().catch((e) => { console.error(e); process.exit(1); });
```

When you codify:
- **Parameterize** anything the user typed (emails, search terms) into `argv`/env.
- Drop dead-ends and redundant steps; keep the snippets that produced the result.
- Add sensible waits/assertions instead of bare sleeps.
- Make outputs explicit — `console.log(JSON.stringify(result))`, or
  `await page.screenshot({ path: 'out.png' })`.
- `browser.close()` on a `connectOverCDP` connection only **detaches**; it does
  not stop the container.

Zero-dependency variant (optional): if the user wants the script to run with
**nothing installed**, emit a plain node script that re-POSTs the snippets to
`/exec` using `fetch`. Prefer the `playwright-core` form unless they ask.

Call `POST /session/reset` to start recording a fresh task from scratch.

---

## 4. Endpoint reference

| method | path             | purpose                                         |
|--------|------------------|-------------------------------------------------|
| GET    | `/`              | live read-only screencast viewer (for the human)|
| GET    | `/guide`         | this document                                   |
| POST   | `/exec`          | run an async JS snippet; JSON result, or raw bytes if it returns a Buffer |
| GET    | `/session`       | recorded successful snippets, in order          |
| POST   | `/session/reset` | clear the recording                             |
| GET    | `/cdp`           | raw CDP endpoint (for external Playwright)       |

---

## 5. Limits & etiquette

- This is a **dev tool**. `/exec` evaluates arbitrary JS and the container is
  meant to be bound to localhost — do not expose it publicly or point it at
  untrusted pages.
- **Newest page wins**: when a click opens a new tab, both the viewer and
  `page` follow it.
- No audio; the viewer is observation-only by design.
