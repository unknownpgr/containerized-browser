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
   │  GET  /session  (codify)  ──►│   Chromium (headless) + Playwright │
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
   independent CDP client screencasts the live page to the viewer at `/`. The
   agent and the viewer operate independently (CDP allows multiple clients on one
   Chrome).

## Quick start

Pull and run the published image (no build needed):

```bash
docker run --rm -d -p 8080:8080 --name cb unknownpgr/containerized-browser:latest
```

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
| GET    | `/cdp`           | raw CDP endpoint for an external Playwright       |
| WS     | `/stream`        | JPEG screencast frames to the viewer             |

## Knobs (env vars)

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `8080` | hub / viewer / api / cdp port |
| `VIEW_WIDTH` `VIEW_HEIGHT` | `1280` `800` | window + screencast max size |
| `VIEW_QUALITY` | `60` | screencast JPEG quality (1–100) |
| `CHROME_BIN` | `/usr/bin/chromium` | chromium binary path |

## Notes & limits

- **Dev tool, not production.** `/exec` evaluates arbitrary JavaScript; bind the
  container to localhost and don't point it at untrusted pages. `--no-sandbox` is
  used (runs as root in the container).
- **Newest page wins.** When a click opens a new tab, both the viewer and the
  controller's `page` follow it.
- **Frame-based, not video.** Fine for dev; swap to WebRTC if you need smooth
  60fps.
- No audio; the viewer is observation-only by design.
