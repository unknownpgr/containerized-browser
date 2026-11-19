# Working on this repo

containerized-browser is one container: desktop Google Chrome on a virtual screen
(Xvfb) plus a Node hub
(`server.js`) that exposes `/exec`, `/session`, `/cdp`, a live viewer at `/`
(`public/index.html`, behind the sign-in page `public/login.html`) and the
agent manual at `/guide` (`GUIDE.md`). README.md
explains the design.

## Development procedure

Every change ships through the same four steps. A change isn't done until all
four have happened.

1. **Update the code**, plus the docs it affects (see [Docs](#docs-put-each-fact-where-its-reader-is)).
2. **Release the image** by running `scripts/release.sh`. It:
   - bumps the version by one (`version.txt`: N → N+1),
   - builds the image from the working tree with `vN+1` baked in,
   - smoke-tests that exact image (reported version, auth, sign-in, viewer,
     `/exec`, a non-headless user agent),
   - pushes `unknownpgr/containerized-browser:vN+1` and `:latest`,
   - re-pins the image tag in the `docker run` commands of BOOTSTRAP.md and
     README.md to `vN+1`.
3. **Add a release note**: a new row at the top of the "Release notes" table
   in README.md with the version, the date and the user-visible changes.
4. **Commit and push**: commit everything (code, docs, `version.txt`,
   README) to `main`, then run `git push`. Start the commit subject with the
   version, e.g. `v2: Add …`.

The image is built from the working tree in step 2, so don't release with
unrelated uncommitted edits in anything the image copies (`Dockerfile`,
`package.json`, `package-lock.json`, `server.js`, `GUIDE.md`, `public/`,
`chrome-policies.json`).

To try a change before releasing, build and run it locally instead:

```bash
docker build -t cb-dev . && docker run --rm -p 8080:8080 -e AUTH_PASSWORD=dev cb-dev
```

A local build like this reports its version as `dev`.

## Looking like a desktop browser

Sites must not be able to tell this browser from a person's desktop Chrome.
Chrome therefore runs headful on Xvfb rather than with `--headless`, and the
hub drives it with Patchright (`patchright-core`), not stock `playwright-core`,
whose `Runtime.enable` on every page is detectable. Keep it that way: any CDP
client the hub adds must not enable the `Runtime` (or `Console`) domain on
pages. When you change launch flags, the driver or anything that touches pages,
compare before and after on <https://deviceandbrowserinfo.com/are_you_a_bot>
("You are human!"), <https://bot.sannysoft.com> (no red rows) and
<https://www.browserscan.net/bot-detection> ("Normal").

## Chrome is frozen in a base image

So that no release picks up a different browser by accident, Google Chrome is
installed once into a base image, not on every build:

- `base/Dockerfile` installs Chrome from Google's signed apt repository, plus
  Xvfb, fonts and Node, then removes the repository so nothing can upgrade it.
  System packages belong there, not in `Dockerfile`, so they are frozen too.
- `scripts/build-base.sh` builds it, publishes it as
  `unknownpgr/containerized-browser-base:chrome-<version>` and pins the
  `FROM` line of `Dockerfile` to that tag *and its digest*. Like `vN`, a base
  tag is immutable: the script refuses to overwrite one.
- An ordinary release reuses the pinned base. To move to a newer Chrome (e.g.
  for a security fix), run `scripts/build-base.sh`, compare the bot-detection
  pages below against the previous release, then follow the development
  procedure as usual and name the new Chrome version in the release note.
- npm dependencies are pinned exactly too (`package.json` and
  `package-lock.json`, installed with `npm ci`). Update them on purpose, e.g.
  `npm install --save-exact patchright-core@<version>`, and test.

## Versioning

- Versions are plain increasing integers: `v1`, `v2`, … `v999`. There is no
  major/minor/patch, because this is an API server and every release is
  simply the next one.
- `version.txt` (repo root) holds the last released number and is the only
  source of truth. Only `scripts/release.sh` changes it. Edit it by hand only
  to repair a failed release; for example, if `:vN` was pushed but `:latest`
  failed, `version.txt` already says N, so just re-push `:latest`.
- `package.json`'s `version` field is ignored. Don't bump it.
- Docker Hub tags:
  - `vN` is immutable. The script refuses to overwrite a published one.
  - `latest` moves to the newest release.
  - `0.1.0` predates this scheme.
- The docs pin the exact release (`…:vN`), not `:latest`. `docker run` reuses
  a stale cached `:latest` without pulling, whereas a pinned tag is always
  fetched. Pinning also means BOOTSTRAP.md on `main` always describes the
  image it launches. The release script rewrites every
  `unknownpgr/containerized-browser:<latest|vN>` in BOOTSTRAP.md and
  README.md, so when a doc mentions another tag in passing, write it without
  the image name (e.g. "`:0.1.0`"). GUIDE.md ships inside the image, so it is
  always the matching version and names no tag.
- The version is baked into the image: `ARG VERSION` sets the `CB_VERSION`
  env var and the `org.opencontainers.image.version` label. A running
  container shows it in three places:
  - the boot log line `VERSION=vN` (`docker logs cb | grep '^VERSION='`)
  - `GET /version`, which returns `{"version":"vN"}` and needs auth like
    every endpoint except `/guide`
  - the viewer's floating panel

## Docs: put each fact where its reader is

- **BOOTSTRAP.md** is read by an agent *before* the container exists, fetched
  from its raw GitHub URL on `main`. It covers pulling, running and picking
  up the password.
- **GUIDE.md** is served at `GET /guide` from inside the image and read
  *after* the container is running. It covers how to operate the container,
  with no pull, run or setup steps.
- **README.md** is for humans: design, setup, reference and release notes.
