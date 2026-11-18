FROM node:20-bookworm-slim

# chromium + fonts so rendering (and screencast) actually has glyphs.
# fonts-noto-cjk: Korean/Japanese/Chinese — without it Hangul renders as tofu (□).
# chromium-l10n: Chromium's translations, without which it ignores $LANG and
#   always presents itself as en-US.
# xvfb: the virtual screen Chromium runs on, headful, so sites see a desktop
#   browser rather than a headless one (it also brings Mesa for WebGL, and xprop).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      chromium-l10n \
      xvfb \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
# Hides the "unsupported command-line flag: --no-sandbox" bar a headful window
# would otherwise show above every page.
COPY chromium-policies.json /etc/chromium/policies/managed/containerized-browser.json
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY GUIDE.md ./
COPY public ./public

# Release version (vN), injected by scripts/release.sh — see AGENTS.md. Kept
# last so a version bump doesn't invalidate the cached apt/npm layers above.
ARG VERSION=dev
ENV CB_VERSION=$VERSION
LABEL org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.source=https://github.com/unknownpgr/containerized-browser

EXPOSE 8080
CMD ["node", "server.js"]
