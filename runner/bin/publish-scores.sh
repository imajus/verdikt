#!/usr/bin/env bash
# One hourly publish of the trailing-window reputation scores to ENS
# (Specification.md §1). Runs once and exits — it is not a daemon. The window
# itself is WINDOW_SECONDS in cre/lib/reputation.js, currently cut to one day
# for the demo — see the TEMPORARY (demo window) note there.
#
# WHY THIS IS A SCRIPT AND NOT A CRON ENTRY BAKED INTO THE IMAGE
#
# The schedule lives in Dokploy, which runs a scheduled job as
# `docker exec <container> <command>` against an already-running container.
# So the runner container does not need a scheduler of its own — it only
# needs one command worth exec'ing, versioned here rather than typed into a
# UI text box where nothing reviews it. See README.md "Hourly score
# publishing" for the Dokploy job definition.
#
# WHY IT CAN SHARE THE RUNNER'S CONTAINER
#
# `cre workflow simulate` refuses `--listen` for a cron trigger ("not
# supported by cron", per the CLI's own help), so the aggregate workflow is
# inherently a fire-once-and-exit run. That is what makes it safe to exec
# alongside the long-lived `verify --listen` process the container exists
# for: the two workflows compile into their own directories, and only
# `verify` binds the HTTP trigger port.
#
# WHY IT READS THE SCORES BACK
#
# The KeystoneForwarder swallows a receiver revert and mines anyway, so a
# successful `cre` run is not evidence that anything was written (CLAUDE.md,
# "Two silent failures"). Without the read-back this job's happiest-looking
# output and its total failure are the same text. See
# `check-published-scores.mjs`.

set -euo pipefail

WORKFLOW_DIR="${RUNNER_WORKFLOW_DIR:-/app/cre/workflows}"
TARGET="${RUNNER_CRE_TARGET:-staging-settings}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Refuse rather than run without it. Without --broadcast the workflow still
# compiles, still reads Arc and still prints a plausible per-service summary
# — it just writes nothing. A scheduled job that looks identical whether or
# not it did its work is worse than one that fails.
if [ -z "${CRE_ETH_PRIVATE_KEY:-}" ]; then
  echo "publish-scores: CRE_ETH_PRIVATE_KEY is unset — the run would read Arc and write nothing" >&2
  exit 1
fi

echo "publish-scores: $(date -u +%FT%TZ) simulating aggregate --target ${TARGET} --broadcast"

# `cre` resolves the workflow folder relative to the project root holding
# project.yaml, which is why this runs from WORKFLOW_DIR and passes a bare
# name — the same shape src/simulator.js spawns `verify` with.
cd "$WORKFLOW_DIR"
cre workflow simulate aggregate \
  --target "$TARGET" \
  --non-interactive \
  --trigger-index 0 \
  --broadcast

echo "publish-scores: $(date -u +%FT%TZ) simulate finished — reading the records back"

# Separate exit code from the simulate step: "the CLI failed" and "the CLI
# succeeded and nothing landed on Sepolia" are different operational
# problems, and the second is the one that hid for days.
exec node "${HERE}/check-published-scores.mjs"
