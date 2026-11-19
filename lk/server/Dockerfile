# Сборка из каталога lk/ (нужен ../pricing.js):
#   docker build -f server/Dockerfile -t cleanhub-lk lk/
FROM node:22-alpine
WORKDIR /app
COPY pricing.js ./pricing.js
COPY server ./server
RUN rm -rf server/test server/data && mkdir -p /data && chown node:node /data
WORKDIR /app/server
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/lk.sqlite
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "server.js"]
