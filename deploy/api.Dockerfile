# syntax=docker/dockerfile:1
#
# DevDigest API image (server mode). Build from the REPO ROOT:
#   docker build -f deploy/api.Dockerfile -t devdigest-api .
#
# The same image runs two services in deploy/compose.yml:
#   - `migrate` (one-shot): pnpm db:migrate && pnpm db:bootstrap
#   - `api`              : tsx src/server.ts (the API never migrates on boot)
#
# Layout mirrors the repo because server consumes reviewer-core as RAW source
# via the tsconfig alias `../reviewer-core/src`, and reviewer-core's runtime deps
# (openai, zod) resolve from reviewer-core/node_modules — a sibling of server/,
# so they must be installed there (npm ci), not in server (root INSIGHTS.md).
#
# Only explicit paths are copied: no .env, no node_modules, no clones/ — and no
# secret is ever passed as ARG/ENV. All secrets arrive at runtime from compose.

FROM node:22.20.0-bookworm-slim

# git: simple-git clones PR repos. ripgrep: code search. ca-certificates: TLS
# to GitHub/GitLab/LLM/Google. tini via compose `init: true`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# server's lockfile/store is pnpm v11 (server/node_modules/.modules.yaml).
RUN npm install -g pnpm@11.22.0 && npm cache clean --force

ENV NODE_ENV=production \
    API_PORT=3001 \
    DEVDIGEST_CLONE_DIR=/data/clones

WORKDIR /app

# 1) reviewer-core deps (npm, lockfile-exact, runtime only).
COPY reviewer-core/package.json reviewer-core/package-lock.json ./reviewer-core/
RUN cd reviewer-core && npm ci --omit=dev && npm cache clean --force

# 2) server deps. Dev deps are kept on purpose: the API runs via `tsx` (a
#    devDependency) — there is no JS emit step for the server today.
#    strict-dep-builds=false: server/pnpm-workspace.yaml leaves cpu-features /
#    esbuild / protobufjs / ssh2 builds unapproved (testcontainers + esbuild
#    platform binaries need none); pnpm 11 would otherwise fail the install.
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml server/.npmrc ./server/
RUN cd server && NODE_ENV=development pnpm install --frozen-lockfile --config.strict-dep-builds=false \
 && pnpm store prune

# 3) sources.
COPY reviewer-core/tsconfig.json ./reviewer-core/
COPY reviewer-core/src ./reviewer-core/src
COPY server/tsconfig.json server/drizzle.config.ts ./server/
COPY server/src ./server/src

# Non-root runtime; the clones volume inherits this ownership on first mount.
RUN mkdir -p /data/clones && chown -R node:node /data /app
USER node

WORKDIR /app/server
EXPOSE 3001
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
