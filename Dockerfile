# syntax=docker/dockerfile:1
#
# Qu Lite relay/mirror + browser demo on one port (default 8787):
#   HTTP  /     -> demo/ (index.html + bundle built below)
#   WS    /ws   -> the mirror peer (bin/mirror.mjs: SQLite store, sync role 'mirror')
#   SSE   /sse  -> the same peer for clients behind WebSocket-blocking proxies
#
#   docker build -t qu-lite .
#   docker run -p 8787:8787 -v qu-lite-data:/data qu-lite
#
# or `docker compose up --build`.
FROM node:22-alpine AS builder
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN node demo/build.mjs && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    QU_PORT=8787 \
    QU_HOST=0.0.0.0 \
    QU_DB=/data/mirror.sqlite \
    QU_STATIC=/app/demo
RUN addgroup -S qu && adduser -S qu -G qu && mkdir -p /data && chown qu:qu /data
COPY --from=builder --chown=qu:qu /app/node_modules ./node_modules
COPY --from=builder --chown=qu:qu /app/package.json ./
COPY --from=builder --chown=qu:qu /app/src ./src
COPY --from=builder --chown=qu:qu /app/bin ./bin
COPY --from=builder --chown=qu:qu /app/demo ./demo
USER qu
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.QU_PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "bin/mirror.mjs"]
