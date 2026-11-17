FROM node:20-bookworm-slim

# chromium + fonts so headless rendering (and screencast) actually has glyphs.
# fonts-noto-cjk: Korean/Japanese/Chinese — without it Hangul renders as tofu (□).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY GUIDE.md ./
COPY public ./public

EXPOSE 8080
CMD ["node", "server.js"]
