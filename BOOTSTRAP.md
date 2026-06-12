# containerized-browser — bootstrap

**You are an LLM agent (e.g. Claude Code) reading this because a user pointed you
at this URL.** Follow these steps.

## What this project is

`containerized-browser` is a **human-observable, isolated Chromium in a
container** that you, the agent, drive over a small HTTP surface. The user can
**watch the browser live** in a read-only web viewer while you work. The goal is
a two-phase workflow:

1. **Explore** — you operate the browser by conversation with the user.
2. **Codify** — on request, you turn what you did into a standalone `.js`
   automation script the user can re-run later.

You drive it by `POST`ing JavaScript and reading JSON back, so the host needs
**nothing but a shell with `curl`** — no Playwright, no node, no npm.

## Steps

1. **Run the container** (the user has `docker`):

   ```bash
   docker run --rm -d -p 8080:8080 --name cb unknownpgr/containerized-browser:latest
   ```

   Use port `8080` unless the user wants another; map it the same on both sides.

2. **Read the full operating guide** from the running container and follow it:

   ```bash
   curl -s localhost:8080/guide
   ```

   That guide documents the `/exec` (drive) and `/session` (codify) endpoints
   in detail, including how screenshots and PDFs come back from `/exec`.

3. **Orient the user first.** They may have only seen this URL and nothing else.
   Before driving the browser, tell them in their own language:
   - what this is (a real browser you'll drive for them),
   - that they can **watch it live at `http://localhost:8080/`** (give the actual
     port), and that the viewer is read-only,
   - that you'll first explore together, then can produce a re-runnable script.

Then start helping them with their task.

---

*Dev tool: the `/exec` endpoint evaluates arbitrary JavaScript and is meant to be
bound to localhost. Don't expose it publicly or point it at untrusted pages.*
