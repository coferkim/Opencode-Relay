# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION} AS bun-runtime
FROM ghcr.io/astral-sh/uv:0.13.6 AS uv-runtime

FROM python:3.13-slim-bookworm AS api
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv-runtime /uv /usr/local/bin/uv
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/ backend/
COPY bridge/ bridge/
RUN groupadd --system relay && useradd --system --create-home --gid relay relay \
    && mkdir /app/data && chown relay:relay /app/data && chmod 700 /app/data
USER relay
EXPOSE 8949
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8949/api/health', timeout=3)"
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8949"]

FROM node:22-bookworm-slim AS web-build
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY frontend/package.json frontend/package.json
RUN bun install --frozen-lockfile
COPY frontend/ frontend/
RUN bun run --cwd frontend build

FROM nginxinc/nginx-unprivileged:1.28-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/frontend/dist/ /usr/share/nginx/html/
EXPOSE 8948
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8948/healthz || exit 1
