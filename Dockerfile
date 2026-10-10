# syntax=docker/dockerfile:1
#
# Qu Lite relay/mirror + browser demo on one port (default 8787):
#   HTTP  /     -> packages/lite/demo (index.html + bundle built below)
#   WS    /ws   -> the mirror peer (bin/mirror.mjs: SQLite store, sync role 'mirror')
#
# Build context MUST be the repo root (npm workspaces need the whole tree):
#
#   docker build -f packages/lite/Dockerfile -t qu-lite .
#   docker run -p 8787:8787 -v qu-lite-data:/data qu-lite
#
# or `docker compose -f docker-compose.lite.yml up`.
FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
RUN node packages/lite/demo/build.mjs

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    QU_PORT=8787 \
    QU_HOST=0.0.0.0 \
    QU_DB=/data/mirror.sqlite \
    QU_STATIC=/app/packages/lite/demo
RUN addgroup -S qu && adduser -S qu -G qu && mkdir -p /data && chown qu:qu /data
COPY --from=builder --chown=qu:qu /app .
USER qu
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.QU_PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "packages/lite/bin/mirror.mjs"]
