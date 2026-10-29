import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd harness: the gatekeeper Durable Object reached through a `TestHooks`
 * facet, as the overseer reaches it, with the Basin SQL endpoint faked at the fetch
 * boundary (__tests__/workerd/fake-basin.ts). The `@validateRpc()` decorators are
 * applied in-memory by the capnweb-validate plugin, since `.wrangler/validate` is
 * not built for tests; the undecorated subclasses in the test worker are what
 * register in `ctx.exports`.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
        durableObjects: {
          BASIN_GATEKEEPER: { className: "BasinGatekeeper", useSQLite: true },
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          BASIN_OWNER_RECORD: { className: "BasinOwnerRecord", useSQLite: true },
          BASIN_AUTO_ACCOUNT: { className: "BasinAutoAccount", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          // The token is a fake; it never leaves the test isolate.
          BASIN_SQL_TOKEN: "test-basin-token",
          BASIN_ACCOUNT_ID: "023e105f4ecef8ad9ca31a8372d0c353",
          BASIN_BUCKET: "basin-demo",
          // A 3 MB cap with a 1 MB reservation: three billed queries fit per facet,
          // the fourth is refused before its fetch - the audit run 1, finding 1 model.
          BASIN_DAILY_SCAN_MB: "3",
          BASIN_RESERVE_MB: "1",
          // 1 MB: comfortably over any response the built-in fake serves, under the
          // oversized body the read-cap test injects.
          BASIN_MAX_RESPONSE_MB: "1",
          BASE_URL: "http://localhost:8787/gatekeeper/basin",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../cloudflare-os/scripts/assert-workerd.ts"],
  },
});
