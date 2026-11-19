#!/usr/bin/env bash
# Publish a new frozen base image and pin the Dockerfile to it. See AGENTS.md.
#
#   scripts/build-base.sh
#
# Run it only to move deliberately to a newer Google Chrome (the base's other
# packages come along). It
# 1. builds base/Dockerfile, which installs the current Chrome stable,
# 2. tags it $BASE:chrome-<version>, refusing to overwrite a published tag,
# 3. pushes it,
# 4. pins the Dockerfile's FROM line to that tag and digest.
#
# Afterwards: compare the bot-detection pages (AGENTS.md), then release as usual.
set -euo pipefail

BASE="${BASE:-unknownpgr/containerized-browser-base}"
cd "$(dirname "$0")/.."

fail() { echo "build-base: $*" >&2; exit 1; }

echo "==> building $BASE from base/Dockerfile"
docker build --pull --load --platform linux/amd64 -t "$BASE:candidate" base/
version="$(docker run --rm "$BASE:candidate" google-chrome --version | grep -oE '[0-9]+(\.[0-9]+){3}' || true)"
[[ -n "$version" ]] || fail "could not read the Chrome version from the built image"
tag="chrome-$version"

# Base tags are immutable, like release tags: one Chrome version, one image.
if docker buildx imagetools inspect "$BASE:$tag" >/dev/null 2>&1; then
  docker rmi "$BASE:candidate" >/dev/null
  fail "$BASE:$tag is already published — Chrome $version is not new"
fi

echo "==> pushing $BASE:$tag"
docker tag "$BASE:candidate" "$BASE:$tag"
docker rmi "$BASE:candidate" >/dev/null
docker push "$BASE:$tag"
digest="$(docker buildx imagetools inspect "$BASE:$tag" --format '{{.Manifest.Digest}}')"
[[ "$digest" == sha256:* ]] || fail "could not read the digest of $BASE:$tag"

perl -pi -e "s#^FROM \\S+#FROM $BASE:$tag\\@$digest#" Dockerfile
grep -qx "FROM $BASE:$tag@$digest" Dockerfile || fail "could not pin the Dockerfile's FROM line"
echo "==> Dockerfile now builds on $BASE:$tag@$digest"

cat <<MSG

Published $BASE:$tag (Google Chrome $version).
Next, per AGENTS.md:
  1. compare the bot-detection pages against the previous release
  2. release as usual (scripts/release.sh), noting the Chrome version in the release notes
MSG
