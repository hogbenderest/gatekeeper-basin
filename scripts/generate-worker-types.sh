#!/usr/bin/env bash
# Regenerates packages/gatekeeper-basin/worker-configuration.d.ts with mainModule
# pointing at the real source, matching the committed upstream files: `wrangler types`
# writes `typeof import("./.wrangler/validate/src/worker")` from the build-main
# config, which drags the capnweb-validate build copy into every tsc program.
# The swap is temporary; the committed wrangler.jsonc (build main) is restored
# after - unconditionally, including on failure (audit run 1, finding 9: the
# previous fixed-/tmp-path version could leave the sed'd file committed on a
# set -e abort, and concurrent runs shared the same backup path).
set -euo pipefail

cd "$(dirname "$0")/../packages/gatekeeper-basin"
BACKUP=$(mktemp)
trap 'cp "$BACKUP" wrangler.jsonc && rm -f "$BACKUP"' EXIT
cp wrangler.jsonc "$BACKUP"
sed 's#"main": ".wrangler/validate/src/worker.ts"#"main": "src/worker.ts"#' \
  "$BACKUP" > wrangler.jsonc
../../node_modules/.bin/wrangler types
echo "generated packages/gatekeeper-basin/worker-configuration.d.ts"
