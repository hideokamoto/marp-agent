# ECR Public Galleryを使用（Docker Hubのレート制限を回避）
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim

WORKDIR /app

# Chromium、日本語フォント、LibreOffice Impress（編集可能PPTX用）をインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    libreoffice-impress \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -fv

# Marp CLI をインストール
RUN npm install -g @marp-team/marp-cli

# Chromium パス設定（Marp CLIのPuppeteerと折衷デッキのplaywright-coreの両方が参照）
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Node 依存関係をインストール
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ランタイムのソースとアセットをコピーしてビルド
COPY tsconfig.json ./
COPY src/ ./src/
COPY decks/ ./decks/
RUN npm run build && npm prune --omit=dev

# テーマCSS（`npm run copy-themes` でランタイムルートに配置されたもの）をコピー
COPY *.css ./

EXPOSE 8080

ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
