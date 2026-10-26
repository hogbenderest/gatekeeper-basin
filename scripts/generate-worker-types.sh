#!/usr/bin/env bash
# Regenerates packages/gatekeeper-basin/worker-configuration.d.ts with mainModule
# pointing at the real source, matching the committed upstream files: `wrangler types`
# writes `typeof import("./.wrangler/validate/src/worker")` from the build-main
# config, which drags the capnweb-validate build copy into every tsc program.
# The swap is temporary; the committed wrangler.jsonc (build main) is restored after.
set -euo pipefail

cd "$(dirname "$0")/../packages/gatekeeper-basin"
cp wrangler.jsonc /tmp/basin-wrangler-orig.jsonc
sed 's#"main": ".wrangler/validate/src/worker.ts"#"main": "src/worker.ts"#' \
  /tmp/basin-wrangler-orig.jsonc > wrangler.jsonc
../../node_modules/.bin/wrangler types
cp /tmp/basin-wrangler-orig.jsonc wrangler.jsonc
echo "generated packages/gatekeeper-basin/worker-configuration.d.ts"
