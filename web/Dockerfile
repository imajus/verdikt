# Build from the repo root: docker build -f web/Dockerfile .
# The pnpm workspace spans the monorepo, so @verdikt/web can't be built from
# this directory alone — it needs its workspace siblings (sdk, sla, cre,
# fixtures) resolved by the root lockfile.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

# Vite inlines these at build time, not at container start, so they must be
# supplied here rather than at `docker run`. Left unset, the dashboard falls
# back to seeded demo data (web/src/source.js) instead of failing to load.
ARG VITE_ARC_RPC_URL
ARG VITE_SEPOLIA_RPC_URL
ENV VITE_ARC_RPC_URL=$VITE_ARC_RPC_URL
ENV VITE_SEPOLIA_RPC_URL=$VITE_SEPOLIA_RPC_URL

RUN pnpm --filter @verdikt/web build

FROM nginx:1.27-alpine AS serve
COPY --from=build /app/web/dist /usr/share/nginx/html
# Real paths (web/src/router.js) need an unmatched request to fall back to
# index.html — nginx's default config has no such rule.
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
