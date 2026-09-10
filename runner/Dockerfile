# Build from the repo root: docker build -f runner/Dockerfile .
# The pnpm workspace spans the monorepo (like web/Dockerfile), and
# cre/workflows is a separate bun island (cre/workflows/README.md) that this
# image also needs, since it is what actually runs `cre workflow simulate`.
#
# Validate this image in the target environment before relying on it for
# verification traffic.

# CRE CLI v1.33 requires glibc >= 2.38; Debian Bookworm provides 2.36, while
# Trixie provides 2.41.
FROM node:22-trixie-slim AS base
RUN corepack enable
WORKDIR /app

# --- CRE CLI + bun, for the workflow simulator ---------------------------
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip gnupg \
    && curl -sSfL https://cre.chain.link/install.sh | bash \
    && curl -fsSL https://bun.sh/install | bash \
    && apt-get purge -y curl unzip gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.bun/bin:/root/.local/bin:${PATH}"

# --- pnpm workspace (the runner package + its workspace deps) ------------
COPY . .
RUN pnpm install --frozen-lockfile

# --- the bun island (cre/workflows) ---------------------------------------
# README.md: bun-only, kept out of pnpm-workspace.yaml, workspace packages
# linked with file: + a bun `overrides` entry.
WORKDIR /app/cre/workflows/verify
RUN bun install

WORKDIR /app

# Deliberately no COPY of any .env / .env.* file — .dockerignore already
# excludes them repo-wide, and this Dockerfile does not override that. See
# README.md "Credentials — do not bake these into the image" for how
# RUNNER_TRIGGER_ADDRESS, the CRE CLI's login session, and (if --broadcast is
# ever turned on) CRE_ETH_PRIVATE_KEY are meant to reach the container instead.

EXPOSE 8787
CMD ["node", "runner/src/server.js"]
