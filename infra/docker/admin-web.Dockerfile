# syntax=docker/dockerfile:1.7
#
# BYOND admin console image. Build from the REPOSITORY ROOT:
#   docker build -f infra/docker/admin-web.Dockerfile \
#     --build-arg VITE_API_BASE_URL=https://api.example.com -t byond/admin-web .
#
# The API base URL is baked in at build time because Vite inlines VITE_* values
# into the bundle. Different environments therefore need different builds — the
# alternative (runtime config fetched from the server) is a later change.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY services/api/package.json services/api/package.json
RUN pnpm install --frozen-lockfile --filter @byond/admin-web...
COPY apps/admin-web apps/admin-web
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @byond/admin-web run build

# ---------------------------------------------------------------------------
# runtime — nginx serving the static bundle, with SPA history fallback so deep
# links such as /pricing resolve to index.html instead of a 404.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY infra/docker/admin-web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/admin-web/dist /usr/share/nginx/html

# nginx:alpine ships an unprivileged `nginx` user; run as it and bind above 1024.
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html
USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:8080/ || exit 1
