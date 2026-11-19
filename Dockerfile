# Google Chrome, Xvfb, fonts and Node, frozen in a base image pinned by digest
# (Docker verifies it). Built from base/Dockerfile by scripts/build-base.sh,
# which also rewrites this line; see AGENTS.md.
FROM unknownpgr/containerized-browser-base:chrome-158.0.8127.36@sha256:5aae932a29ef2eabe43f03b7add64323434d6f15a3eb64cbaa8c51537b5802a4

ENV CHROME_BIN=/usr/bin/google-chrome
# Hides the "unsupported command-line flag: --no-sandbox" bar a headful window
# would otherwise show above every page.
COPY chrome-policies.json /etc/opt/chrome/policies/managed/containerized-browser.json
ENV NODE_ENV=production

WORKDIR /app
# exact dependency versions from the lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY GUIDE.md ./
COPY public ./public

# Release version (vN), injected by scripts/release.sh — see AGENTS.md. Kept
# last so a version bump doesn't invalidate the cached npm layer above.
ARG VERSION=dev
ENV CB_VERSION=$VERSION
LABEL org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.source=https://github.com/unknownpgr/containerized-browser

EXPOSE 8080
CMD ["node", "server.js"]
