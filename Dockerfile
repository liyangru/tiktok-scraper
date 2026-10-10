FROM node:20-slim

# Chromium + 泰文/中文字体（Patchright 无头可用，无需 xvfb 虚拟显示）
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-thai-tlwg \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    BROWSER_HEADLESS=1 \
    HOST=0.0.0.0 \
    PORT=8899 \
    CONCURRENCY=1 \
    PROFILE_DIR=/app/data/profiles \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 8899

# Patchright 下无头可用，容器无需 xvfb 虚拟显示
CMD ["node", "server.js"]
