import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

/**
 * Two modes, selected by configuration:
 *
 *  - Per-user connect (no deployment env): each user connects their own Basin warehouse by
 *    pasting account ID, bucket, and an R2 API token on the connect form.
 *  - Deployment auto-provision (BASIN_SQL_TOKEN secret set): one shared credential for the
 *    whole deployment, minted as an ambient singleton account per user; the token and the
 *    warehouse identity come from BASIN_ACCOUNT_ID / BASIN_BUCKET / BASIN_SCOPE vars.
 *
 * No KV, R2 or D1 resources are used: all gatekeeper state lives in Durable Object storage.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-basin",
  entrypoint: ".wrangler/validate/src/worker.ts",
  // Sessions persist approval-queue stubs in irrevocable-stub storage across RPC calls.
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt"]),
} satisfies WranglerExtras;

/**
 * BasinGatekeeper is instantiated as an Overseer facet per binding (per workspace/resource
 * grant); UserAccount exists per connected account in per-user mode; BasinOwnerRecord
 * stores the provisioning owner's email per auto-provisioned account. All are reached
 * through ctx.exports; no bindings are required.
 */
export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["BasinGatekeeper", "UserAccount"] },
  { tag: "v1", new_sqlite_classes: ["BasinOwnerRecord"] },
];
