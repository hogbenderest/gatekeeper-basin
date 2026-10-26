#!/usr/bin/env bash
# Dev setup: clone the pinned upstream checkout this package is developed against,
# install its workspace, then install this repository's workspace (whose package
# `link:`s into the clone), and generate the committed artifacts. Run from the
# repository root:
#
#   bash scripts/dev-setup.sh [upstream-commit-or-branch]   # default: the pinned commit below
#
# The package builds and tests against @gadgets/workshop-shared, @gadgets/gatekeeper-kit
# and @gadgets/configurator-ui, which only exist inside the cloudflare-os checkout.
# CI does the same at the pinned commit in .github/workflows/ci.yml. Update the pin
# deliberately: it is the compatibility contract (see README).

set -euo pipefail

UPSTREAM_REMOTE="https://github.com/cloudflare/cloudflare-os.git"
# The upstream commit this package is currently developed and tested against.
PIN="${1:-bd10b0ece6842b8f486b3467eab6cc3b9c920920}"

cd "$(dirname "$0")/.."

if [ ! -d cloudflare-os/.git ]; then
  git clone "$UPSTREAM_REMOTE" cloudflare-os
fi
(
  cd cloudflare-os
  git fetch --all >/dev/null
  git checkout -q "$PIN"
)

echo "Installing the upstream workspace (cloudflare-os)..."
pnpm --dir cloudflare-os install

echo "Installing this repository's workspace..."
pnpm install

echo "Building configurator frames..."
pnpm exec vp run -F @gadgets/gatekeeper-basin build:configurator

echo "Generating wrangler.jsonc with the upstream generator..."
node --experimental-strip-types scripts/generate-configs.mjs

echo "Generating worker types against the real source..."
bash scripts/generate-worker-types.sh

echo
echo "Done. Checks:"
echo "  pnpm test:run      # pure-logic suites (Node)"
echo "  pnpm types:check   # tsc against the upstream contracts"
echo "  cd packages/gatekeeper-basin && ../../node_modules/.bin/wrangler deploy --dry-run"
