#!/usr/bin/env bash
# Release the next version of the image. See AGENTS.md for the whole procedure.
#
#   scripts/release.sh
#
# 1. reads the last released version N from version.txt and picks v(N+1)
# 2. builds the image from the working tree with that version baked in
# 3. smoke-tests the exact image (version reported, auth enforced, sign-in, /exec works)
# 4. pushes :v(N+1) and :latest, recording N+1 in version.txt
# 5. re-pins the image tag in BOOTSTRAP.md / README.md run commands to v(N+1)
#
# Afterwards (not automated): add a v(N+1) row to README's "Release notes",
# then commit everything (incl. version.txt) and push.
set -euo pipefail

IMAGE="${IMAGE:-unknownpgr/containerized-browser}"
cd "$(dirname "$0")/.."

fail() { echo "release: $*" >&2; exit 1; }

prev="$(tr -d '[:space:]' < version.txt)"
[[ "$prev" =~ ^[0-9]+$ ]] || fail "version.txt must hold a single integer, got '$prev'"
next=$((prev + 1))
tag="v$next"

# Version tags are immutable: never overwrite one that is already published.
if docker buildx imagetools inspect "$IMAGE:$tag" >/dev/null 2>&1; then
  fail "$IMAGE:$tag is already published but version.txt says $prev — reconcile version.txt first"
fi

echo "==> building $IMAGE:$tag"
docker build --load --build-arg VERSION="$tag" -t "$IMAGE:$tag" -t "$IMAGE:latest" .

echo "==> smoke-testing $IMAGE:$tag"
name="cb-release-smoke-$$"
pass="smoke-$RANDOM$RANDOM"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p 127.0.0.1::8080 -e AUTH_PASSWORD="$pass" "$IMAGE:$tag" >/dev/null
port="$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
auth=(-H "Authorization: Bearer $pass")
for _ in $(seq 60); do
  curl -fs -o /dev/null "${auth[@]}" "$base/version" && break
  sleep 0.5
done
got="$(curl -s "${auth[@]}" "$base/version" || true)"
[[ "$got" == "{\"version\":\"$tag\"}" ]] || fail "/version should report $tag, got: $got"
docker logs "$name" 2>&1 | grep -qx "VERSION=$tag" || fail "boot log is missing VERSION=$tag"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/version")" == 401 ]] || fail "auth is not enforced"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/guide")" == 200 ]] || fail "/guide is not served"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$base/")" == 200 ]] || fail "viewer is not served"
[[ "$(curl -s -H 'Accept: text/html' "$base/")" == *'id="pw"'* ]] || fail "sign-in page is not served"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-urlencode "password=$pass" "$base/login")" == 204 ]] \
  || fail "signing in at /login failed"
out="$(curl -s "${auth[@]}" -X POST "$base/exec" \
  --data-binary 'await page.setContent("<title>smoke</title>"); return await page.title()' || true)"
[[ "$out" == *'"result":"smoke"'* ]] || fail "/exec failed: $out"
docker rm -f "$name" >/dev/null
trap - EXIT
echo "    ok"

echo "==> pushing $IMAGE:$tag and :latest"
docker push "$IMAGE:$tag"
echo "$next" > version.txt # recorded as soon as the immutable tag exists
docker push "$IMAGE:latest"

# Point the docs' run commands at the exact release. Unlike :latest, a pinned
# tag is always pulled fresh (`docker run` reuses a stale cached :latest), and
# the docs on main then describe precisely the image they launch.
perl -pi -e "s#\\Q$IMAGE\\E:(?:latest|v\\d+)\\b#$IMAGE:$tag#g" BOOTSTRAP.md README.md
echo "==> BOOTSTRAP.md / README.md now run $IMAGE:$tag"

cat <<EOF

Released $IMAGE:$tag (version.txt -> $next).
Next, per AGENTS.md:
  1. add a $tag row to the "Release notes" table in README.md
  2. commit everything (incl. version.txt and the re-pinned docs) and push to main
EOF
