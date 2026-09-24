# syntax=docker/dockerfile:1.7
#
# BYOND core API image. Build from the REPOSITORY ROOT, not from this folder:
#   docker build -f infra/docker/api.Dockerfile -t byond/api .
#
# The image carries production dependencies and the compiled Nest bundle only.
# Optional local CV runtimes (Python/Ultralytics/Ollama) are deliberately NOT
# baked in: they are opt-in adapters selected by environment variables, and a
# cloud control-plane image has no business shipping model weights.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# deps — resolve the workspace from manifests alone so this layer is cached
# until a package.json or the lockfile actually changes.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN pnpm install --frozen-lockfile --filter @byond/api...

# ---------------------------------------------------------------------------
# build — generate the Prisma client, compile, then reconcile the tree down to
# production dependencies IN PLACE. Running the prod install after `generate`
# keeps the already-materialised @prisma/client (and the client it generated
# into it) while dropping the CLI, Jest, ESLint and the TypeScript toolchain.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY services/api services/api
RUN pnpm --filter @byond/api run build \
 && pnpm install --frozen-lockfile --prod --filter @byond/api...

# ---------------------------------------------------------------------------
# runtime — non-root, production dependencies only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
RUN apk add --no-cache wget \
 && addgroup -S byond \
 && adduser -S -G byond -h /repo byond
WORKDIR /repo

COPY --from=build --chown=byond:byond /repo/node_modules ./node_modules
COPY --from=build --chown=byond:byond /repo/package.json ./package.json
COPY --from=build --chown=byond:byond /repo/services/api/node_modules ./services/api/node_modules
COPY --from=build --chown=byond:byond /repo/services/api/dist ./services/api/dist
COPY --from=build --chown=byond:byond /repo/services/api/package.json ./services/api/package.json
# Schema and migrations travel with the image so `prisma migrate deploy` can be
# run as a one-shot job from the same artifact that serves traffic.
COPY --from=build --chown=byond:byond /repo/services/api/prisma ./services/api/prisma

USER byond
WORKDIR /repo/services/api
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --spider "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/main.js"]
