#!/bin/bash
# Verdikt — Claude Code cloud environment setup script.
#
# This file is the source of truth; the cloud environment reads its script from
# the settings dialog, not from the repo. Paste the contents into
# claude.ai/code -> environment settings -> Setup script after editing.
#
# Runs as root on Ubuntu 24.04, before Claude Code launches. The resulting
# filesystem is snapshotted and reused, so later sessions skip this entirely.
#
# Three constraints shape everything below:
#   1. NEVER exit non-zero — a failure here stops the session from starting.
#      Hence no `set -e`, and `|| true` on anything non-critical.
#   2. Finish inside ~5 minutes — independent installs run in parallel.
#   3. Only FILES survive into the snapshot, not processes and not exported
#      variables. A binary is "installed" only once it is on PATH for the
#      shells Claude opens later, which is why everything gets symlinked into
#      /usr/local/bin rather than left in ~/.foundry/bin with a PATH export.
#
# Preinstalled already (don't reinstall): node 20/21/22 (22 default), npm, pnpm,
# yarn, git, gh, jq, ripgrep, Go, Rust, Docker, PostgreSQL, Redis.

log() { echo "[verdikt-setup] $*"; }

BIN_DIR=/usr/local/bin
export DEBIAN_FRONTEND=noninteractive
export CI=1

# Symlink named tools from a directory into /usr/local/bin.
link_bins() {
  local src="$1"; shift
  local tool
  for tool in "$@"; do
    [ -x "$src/$tool" ] && ln -sf "$src/$tool" "$BIN_DIR/$tool"
  done
}

# --------------------------------------------------------------- 1. Foundry
# Not preinstalled, and the thing this project most needs: contracts/ is a
# Foundry project and `forge build` is the only check on IVerdiktRegistry.sol.
#
# foundryup pulls release assets from github.com/foundry-rs/foundry. Cloud
# sessions route GitHub through a proxy that scopes release-asset requests to
# repositories attached to the session, so that download can come back 403.
# If it does, fall back to the ghcr.io image: container-registry traffic does
# not go through the GitHub proxy, and ghcr.io is on the Trusted allowlist.
install_foundry() {
  if command -v forge >/dev/null 2>&1; then
    log "foundry: already present"
    return 0
  fi
  log "foundry: trying foundryup"
  if curl -fsSL --max-time 60 https://foundry.paradigm.xyz -o /tmp/foundryup.sh 2>/dev/null &&
    bash /tmp/foundryup.sh >/dev/null 2>&1; then
    PATH="$HOME/.foundry/bin:$PATH" "$HOME/.foundry/bin/foundryup" >/dev/null 2>&1
    link_bins "$HOME/.foundry/bin" forge cast anvil chisel
  fi
  if command -v forge >/dev/null 2>&1; then
    log "foundry: installed via foundryup"
    return 0
  fi
  log "foundry: foundryup unavailable, falling back to the container image"
  install_foundry_via_docker
}

install_foundry_via_docker() {
  docker info >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
  if ! docker pull ghcr.io/foundry-rs/foundry:latest >/dev/null 2>&1; then
    log "foundry: UNAVAILABLE — neither foundryup nor ghcr.io worked"
    return 0
  fi
  local tool
  for tool in forge cast anvil chisel; do
    cat >"$BIN_DIR/$tool" <<SHIM
#!/bin/bash
# Foundry via container. The pulled image survives in the environment snapshot;
# the docker daemon does not, so start it on demand.
docker info >/dev/null 2>&1 || service docker start >/dev/null 2>&1
exec docker run --rm -i -v "\$PWD":/work -w /work \\
  --entrypoint $tool ghcr.io/foundry-rs/foundry:latest "\$@"
SHIM
    chmod +x "$BIN_DIR/$tool"
  done
  log "foundry: installed as container shims"
}

# ----------------------------------------------------- 2. Chainlink CRE CLI
# Needed for `cre workflow simulate`, which is the submission's only evidence
# for the workflows since production enrollment is private-beta (spec §2).
# cre.chain.link is NOT on the default Trusted allowlist — see the note at the
# bottom of this file about switching the environment to Custom.
install_cre() {
  if command -v cre >/dev/null 2>&1; then
    log "cre: already present"
    return 0
  fi
  if ! curl -sSfL --max-time 120 https://cre.chain.link/install.sh -o /tmp/cre-install.sh 2>/dev/null; then
    log "cre: UNAVAILABLE — cre.chain.link unreachable, add it to the allowlist"
    return 0
  fi
  bash /tmp/cre-install.sh >/dev/null 2>&1 || true
  link_bins "$HOME/.cre/bin" cre
  link_bins "$HOME/.local/bin" cre
  command -v cre >/dev/null 2>&1 && log "cre: installed" || log "cre: install script ran but no binary found"
}

# --------------------------------------------------------- 3. Circle CLI
# The demo caller's x402 wallet (Requirements §8). Plain npm, so registry
# access is covered by the default allowlist. Drop this block if the demo
# stops using it.
install_circle() {
  npm install -g @circle-fin/cli >/dev/null 2>&1 &&
    log "circle: installed" || log "circle: install failed (non-blocking)"
}

# ---------------------------------------------- 4. Workspace dependencies
# pnpm itself is preinstalled, but package.json pins pnpm@12.3.4 via
# packageManager, so corepack has to fetch that exact version. Warming the
# store here means it lands in the snapshot and every later session starts
# with node_modules already populated.
#
# The repo may not be cloned yet when this runs, so this is best-effort — it
# is a warm cache, never a guarantee. For a guarantee on every session, pair
# this with a SessionStart hook in .claude/settings.json; the repo has no such
# hook today, so if this step is skipped Claude just runs pnpm install itself.
install_workspace() {
  corepack enable pnpm >/dev/null 2>&1 || true
  local dir
  for dir in /workspace/verdikt /workspace/* "$HOME/verdikt" /repo; do
    if [ -f "$dir/pnpm-workspace.yaml" ]; then
      log "workspace: installing dependencies in $dir"
      (cd "$dir" && corepack pnpm install --frozen-lockfile >/dev/null 2>&1) &&
        log "workspace: dependencies installed" ||
        log "workspace: install failed (Claude can rerun pnpm install)"
      return 0
    fi
  done
  log "workspace: repo not cloned yet, deferring to the SessionStart hook"
}

# ------------------------------------------------------------------- run
# Independent installs in parallel to stay inside the five-minute budget.
log "starting"
install_foundry &
install_cre &
install_circle &
wait
install_workspace

# ---------------------------------------------------------------- verify
# Report rather than fail. A missing tool must not stop the session — Claude
# can work around it, but only if this output says which one is missing.
log "--- versions ---"
node --version 2>/dev/null || log "node: MISSING"
corepack pnpm --version 2>/dev/null || log "pnpm: MISSING"
forge --version 2>/dev/null || log "forge: MISSING"
cre version 2>/dev/null || cre --version 2>/dev/null || log "cre: MISSING"
circle --version 2>/dev/null || log "circle: MISSING"
go version 2>/dev/null || true
log "done"

exit 0
