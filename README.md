# containerized-browser

A **human-observable, isolated Chromium in a container** that an LLM agent drives
over a tiny HTTP surface — and that a human watches **live** in a read-only web
viewer. The point: explore a website by talking to the agent, then have the agent
hand you a **standalone script** that reproduces what you just did.

```
 Agent (Claude Code, host shell)
   │  POST /exec  (JS in → JSON,  ┌───────────────────────────────────┐
   │     or raw bytes for a    ──►│  one container, one port (8080)   │
   │     screenshot/pdf Buffer)   │                                   │
   │  GET  /session  (codify)  ──►│   Chromium (desktop) + Playwright │
   │  GET  /guide  (self-doc)  ──►│   + hub + live screencast viewer  │
 You (browser)  GET / ───────────►└───────────────────────────────────┘
        live read-only view
```

## Point an agent at it

On a machine that has only `docker` and an agent CLI (e.g. Claude Code), give the
agent this one URL and ask it to follow it:

```
https://raw.githubusercontent.com/unknownpgr/containerized-browser/main/BOOTSTRAP.md
```

The agent pulls the image, runs it on port 8080, reads `GET /guide` from the
running container, tells you how to watch (<http://localhost:8080/>), and starts
driving the browser for you. No other setup.

## Why it's shaped this way

This design is the endpoint of a few deliberate decisions:

1. **The agent can't "run Playwright" — it runs shell commands and reads text.**
   So instead of shipping a client library to the host, we put Playwright
   *inside* the container and expose a **"code in, JSON out"** surface
   (`POST /exec`). The agent drives the browser with nothing but `curl`.

2. **Zero host dependencies, zero project files.** Because driving is just HTTP,
   the user needs no npm package, no `playwright-core`, no init step that writes
   a `CLAUDE.md` into their repo (which would clobber an existing one or force a
   throwaway project). You can use this as a dev tool from *any* directory.

3. **The container is self-describing.** Operating instructions live *in the
   image* and are served at `GET /guide`. The only thing a user shares is a URL
   to [`BOOTSTRAP.md`](./BOOTSTRAP.md): "pull this container, run it on port 8080,
   then `curl /guide` and follow it." The agent figures out the rest.

4. **Explore and codify share the same primitives.** Every successful `/exec`
   snippet is Playwright code *and* is recorded. "Make this a script" then
   renders the recording (`GET /session`) into a standalone `playwright-core`
   file that assumes the container is running at a host:port.

5. **Humans watch the live page instead of one-off screenshots.** A second,
   independent CDP client screencasts the browser's tabs to the viewer at `/` —
   by default the tab the agent is driving, but the human can pin any open tab
   or watch all of them side by side. The agent and the viewer operate
   independently (CDP allows multiple clients on one Chrome).

6. **Sites see an ordinary desktop browser.** Many sites turn headless or
   automated browsers away. So Chromium is not run with `--headless`: it is a
   normal window, maximized on a virtual 1920×1080 screen (Xvfb) above a
   taskbar-sized strip, with a mouse, scrollbars and WebGL. The driver is
   [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), a drop-in
   Playwright fork that leaves out the CDP calls (`Runtime.enable`) that let a
   page notice it is being automated. The screencast uses only the Page domain,
   which pages can't observe. Time zone and language follow `TZ` and `LANG`.

## Quick start

Pull and run the published image (no build needed):

```bash
docker run --rm -d -p 8080:8080 --name cb unknownpgr/containerized-browser:v4
```

The tag is the current release (see [Versions](#versions)). `:latest` also
exists, but `docker run` silently reuses a stale cached `:latest` instead of
pulling the new one.

To make the browser match your own desktop's time zone and language, add them
before the image name, e.g. `-e TZ=Asia/Seoul -e LANG=ko_KR.UTF-8`. The default
is UTC and US English.

Or build from source:

```bash
docker build -t containerized-browser .
docker run --rm -d -p 8080:8080 --name cb containerized-browser
```

- **Watch:** open <http://localhost:8080/>
- **Agent guide:** `curl -s localhost:8080/guide`
- **Drive it:**

  ```bash
  curl -s -X POST localhost:8080/exec --data-binary @- <<'JS'
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  return await page.title();
  JS
  ```

## HTTP surface

| method | path             | purpose                                          |
|--------|------------------|--------------------------------------------------|
| GET    | `/`              | live read-only screencast viewer                 |
| GET    | `/guide`         | agent operating manual (served from the image)   |
| POST   | `/exec`          | run async JS with `{ page, context, browser, log }`; JSON result, or raw bytes if the snippet returns a Buffer (e.g. `page.screenshot()`, `page.pdf()`) |
| GET    | `/session`       | recorded successful snippets, in order (for codify) |
| POST   | `/session/reset` | clear the recording                              |
| GET    | `/version`       | the running release, e.g. `{"version":"v1"}`     |
| POST   | `/login`         | sign-in page's form post (`password=…`): sets the auth cookie |
| GET    | `/cdp`           | raw CDP endpoint for an external Playwright       |
| WS     | `/stream`        | viewer feed: tab list + JPEG frames of the tabs it watches |

All paths require the password (see [Auth](#auth)) **except `/guide`**, which is
public so an agent can read it before it has the secret, and `/login`. A
browser that opens any other page without the password gets the sign-in page
instead.

## Knobs (env vars)

| var | default | meaning |
|-----|---------|---------|
| `AUTH_PASSWORD` | *(auto-generated, printed to logs)* | shared secret guarding the whole surface — viewer password **and** agent token |
| `PORT` | `8080` | hub / viewer / api / cdp port |
| `VIEW_WIDTH` `VIEW_HEIGHT` | `1920` `1080` | virtual screen size; the browser window is maximized on it above a 40px taskbar strip. Also the screencast's max size |
| `VIEW_QUALITY` | `60` | screencast JPEG quality (1–100) |
| `TZ` | `UTC` | the browser's time zone, e.g. `Asia/Seoul` |
| `LANG` | *(US English)* | the browser's language: UI, `navigator.languages`, `Accept-Language` and `Intl`, e.g. `ko_KR.UTF-8` |
| `HEADLESS` | *(off)* | `1` runs Chromium with `--headless` as before v4, with no virtual screen. Sites can tell |
| `CHROME_ARGS` | *(none)* | extra Chromium command-line flags, space-separated |
| `CHROME_BIN` | `/usr/bin/chromium` | chromium binary path |

## Auth

Every endpoint — the viewer, `/exec`, `/session`, `/cdp` — is guarded by a single
shared secret:

- Set it yourself: `docker run ... -e AUTH_PASSWORD=hunter2 ...`
- Or leave it unset and the container **mints a random one and prints it to its
  logs** at startup (`docker logs cb`), so the surface is never silently open.

The same secret works two ways:

- **Human (viewer):** open `/` in a browser; it shows a sign-in page that asks
  for the secret. Signing in sets a cookie for the rest of the browser session.
- **Agent (curl / Playwright):** send `Authorization: Bearer <secret>` (or append
  `?token=<secret>`). Example:

  ```bash
  curl -s -H "Authorization: Bearer $AUTH_PASSWORD" \
    -X POST localhost:8080/exec --data-binary 'return await page.title()'
  ```

## Notes & limits

- **Dev tool, not production.** `/exec` evaluates arbitrary JavaScript; keep the
  password secret, bind the container to localhost and don't point it at
  untrusted pages. `--no-sandbox` is used (runs as root in the container); a
  Chromium policy (`chromium-policies.json`) hides the warning bar it would show.
- **Newest page wins.** When a click opens a new tab, the controller's `page`
  follows it.
- **Every tab is watchable.** The page fills the viewer window. A small panel
  floating at the bottom lists all open tabs, with the agent's tab marked; it
  fades out while the mouse is idle and comes back when the mouse moves. By
  default the viewer follows the agent's tab; click any tab to pin it, or
  **All tabs** for a live grid. A viewer that joins gets the current
  frame right away, even if the page is static. Only tabs that someone is
  watching are screencast.
- **Fonts.** Latin, CJK (Korean/Japanese/Chinese, via Noto CJK) and color emoji
  are bundled. Other scripts (e.g. Arabic, Thai) may render as tofu (□).
- **What still differs from a desktop.** It is Chromium, not Google Chrome (no
  Widevine DRM, so Netflix-style video won't play). WebGL renders in software
  (Mesa llvmpipe), as on a machine without a GPU driver. There are no audio
  devices. And a site may still show a CAPTCHA because of the network's
  reputation; the viewer is read-only, so it can't be solved there.
- **Agent API differences.** Because the driver is Patchright, `page.evaluate`
  runs in an isolated world (it sees the DOM, not the page's own variables, unless
  you pass `false` as its 4th argument) and `page.on('console')` never fires.
  [GUIDE.md](./GUIDE.md) tells the agent.
- **Frame-based, not video.** Fine for dev; swap to WebRTC if you need smooth
  60fps.
- No audio; the viewer is observation-only by design.

## Versions

Releases are numbered with plain increasing integers (`v1`, `v2`, …), because
there is no major/minor/patch for an API server. Each one is published as the
immutable image tag `:vN` and also moves `:latest`.

To see which release a container is running, use any of these:

- its log line `VERSION=vN` (`docker logs cb | grep '^VERSION='`)
- `GET /version`
- the viewer's floating panel
- the `org.opencontainers.image.version` image label

A local build reports `dev`. How a release is made is described in
[AGENTS.md](./AGENTS.md).

## Release notes

| version | date | changes |
|---------|------------|---------|
| v4 | 2026-11-18 | Sites now see an ordinary desktop browser, so many that refused the headless one open normally. Chromium runs as a normal window on a virtual screen instead of `--headless`: no "HeadlessChrome" in the user agent, a real screen with a taskbar, mouse, scrollbars and WebGL. The driver is now Patchright, which hides automation from pages. Its API is Playwright's, except that `page.evaluate` runs in an isolated world (pass `false` as the 4th argument to reach page variables) and `page.on('console')` doesn't fire. The default screen is 1920×1080 (was 1280×800). `TZ` and `LANG` set the browser's time zone and language. `HEADLESS=1` restores the old mode, and `CHROME_ARGS` adds Chromium flags. Generated scripts should use `patchright-core` instead of `playwright-core`. |
| v3 | 2026-11-17 | The viewer has its own sign-in page instead of the browser's native login prompt; a browser that opens any page without the password lands there, and returns to that page after signing in. New `POST /login`. If the container restarts with a different password, an open viewer goes back to the sign-in page by itself. Agents are unaffected: Bearer, `?token=` and `curl -u` all work as before. |
| v2 | 2026-11-17 | Redesigned viewer. The page now fills the whole window, and the tabs, URL, view mode, connection status and version sit in a small panel floating at the bottom that fades out while the mouse is idle. The viewer uses the system font with a neutral look, follows the OS light/dark setting, and scales the page up to fit large windows. |
| v1 | 2026-11-17 | First versioned release. The running version is shown in the log (`VERSION=v1`), at `GET /version` and in the viewer header, and the docs pin the release tag. The viewer can watch every tab: follow the agent (the default), pin a tab, or see all tabs as a live grid. A viewer that connects sees the current frame immediately, even on a static page. Korean, Japanese and Chinese fonts are bundled. Fixed a hub crash on `GET /?token=…`. |

Images published before v1 (`:0.1.0` and older `:latest`s) are unversioned.
