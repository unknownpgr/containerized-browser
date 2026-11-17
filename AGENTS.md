# Working on this repo

containerized-browser is one container: headless Chromium plus a Node hub
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
   - smoke-tests that exact image (reported version, auth, sign-in, viewer, `/exec`),
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
`package.json`, `server.js`, `GUIDE.md`, `public/`).

To try a change before releasing, build and run it locally instead:

```bash
docker build -t cb-dev . && docker run --rm -p 8080:8080 -e AUTH_PASSWORD=dev cb-dev
```

A local build like this reports its version as `dev`.

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
