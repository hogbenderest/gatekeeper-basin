#!/usr/bin/env node
// Generates packages/gatekeeper-basin/wrangler.jsonc with the genuine upstream
// generator (cloudflare-os/scripts/generate-worker-configs.ts), so the committed
// artifact stays byte-identical to what the cloudflare-os workspace would produce.
//
// Run from anywhere; paths resolve relative to this script. Requires cloudflare-os/
// to be checked out and its workspace installed (scripts/dev-setup.sh does both).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const generator = await import(
  pathToFileURL(join(repo, "cloudflare-os/scripts/generate-worker-configs.ts")).href
);
const dir = join(repo, "packages/gatekeeper-basin");
writeFileSync(join(dir, "wrangler.jsonc"), await generator.renderWorkerConfig(dir));
console.log("generated packages/gatekeeper-basin/wrangler.jsonc");
