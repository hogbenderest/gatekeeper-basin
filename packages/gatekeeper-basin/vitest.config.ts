import { defineConfig } from "vitest/config";

/**
 * The pure-logic suites (guardrails, scope, budget, client parsing, discovery), which
 * are far cheaper in Node. Workers-API modules (the gatekeeper DOs and sessions) need
 * the sibling workerd harness, added in a later pass.
 */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
