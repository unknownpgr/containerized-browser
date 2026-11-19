# Frozen base of containerized-browser: Google Chrome, the virtual screen it runs
# on, fonts and Node. scripts/build-base.sh builds and publishes it only when
# Chrome is deliberately updated, and the main Dockerfile pins it by digest, so
# a release never picks up a different browser by accident. See AGENTS.md.
FROM node:20-bookworm-slim

# Chrome comes from Google's signed apt repository (apt verifies the signature).
# The repository and its key — including the copies Chrome's install script adds
# for its own updates — are removed afterwards, so nothing in the image can
# upgrade Chrome later.
# xvfb: the virtual screen Chrome runs on (it also brings Mesa for WebGL).
# x11-utils: xprop, which gives that screen a taskbar-sized work area.
# fonts-noto-cjk: Korean/Japanese/Chinese — without it Hangul renders as tofu (□).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /usr/share/keyrings/google-linux.asc \
 && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.asc] https://dl.google.com/linux/chrome/deb/ stable main' \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      xvfb \
      x11-utils \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
 && rm -f /etc/apt/sources.list.d/google-chrome.* /usr/share/keyrings/google-* /etc/cron.daily/google-chrome \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
