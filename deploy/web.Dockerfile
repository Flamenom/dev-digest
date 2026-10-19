# syntax=docker/dockerfile:1
#
# DevDigest web image. Build from the REPO ROOT:
#   docker build -f deploy/web.Dockerfile -t devdigest-web .
#
# NEXT_PUBLIC_API_BASE is inlined into the browser bundle at BUILD time
# (client/next.config.mjs `env`). It is a public, non-secret value: the default
# `/api` makes every browser call same-origin (Caddy routes /api/* → api).
# Never pass a secret as a build arg — it ends up in the image and the bundle.

ARG NODE_IMAGE=node:22.20.0-bookworm-slim

# ── build ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
# client's lockfile/store is pnpm v10 (client/node_modules/.modules.yaml).
RUN npm install -g pnpm@10.34.5 && npm cache clean --force
WORKDIR /app

COPY client/package.json client/pnpm-lock.yaml client/.npmrc ./
RUN pnpm install --frozen-lockfile

# Explicit paths only — client/.env* is deliberately NOT copied.
COPY client/next.config.mjs client/postcss.config.mjs client/tsconfig.json client/next-env.d.ts ./
COPY client/messages ./messages
COPY client/src ./src

ARG NEXT_PUBLIC_API_BASE=/api
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN pnpm build && pnpm prune --prod

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/messages ./messages
COPY --from=build --chown=node:node /app/src/i18n ./src/i18n
USER node
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-p", "3000"]
