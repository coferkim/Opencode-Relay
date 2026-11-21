# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server/ server/
COPY tsconfig.json ./

ENV NODE_ENV=production \
    PORT=8948 \
    RELAY_DATA_DIR=/app/data

RUN mkdir -p /app/data && chown -R 10001:10001 /app
USER 10001:10001

EXPOSE 8948
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8948/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/index.ts"]
