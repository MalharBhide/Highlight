FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# Use Debian's FFmpeg at runtime; esbuild uses its platform optional package.
RUN npm install --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]' \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/app/storage \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    YT_DLP_BIN=/opt/yt-dlp/bin/yt-dlp
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /app/storage \
    && chown node:node /app/storage
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 3000
CMD ["node", "dist-server/server.js"]
