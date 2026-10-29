/// <reference types="@cloudflare/vitest-plugin/types" />

// Types for the workerd suite's environment. The pool types `env` as `Cloudflare.Env`,
// so the test-only bindings, declared in vitest.worker.config.ts rather than in
// wrangler.jsonc, are added by augmenting it.

import type { TestHooks } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_HOOKS: DurableObjectNamespace<TestHooks>;
      BASIN_GATEKEEPER: DurableObjectNamespace;
      USER_ACCOUNT: DurableObjectNamespace;
      BASIN_OWNER_RECORD: DurableObjectNamespace;
      BASIN_AUTO_ACCOUNT: DurableObjectNamespace;
    }
  }
}
