// The per-user scope map: parse BASIN_USER_SCOPES, resolve a user's scope, and prove
// the fail-closed rules. Pure logic: the scope specs parse through the same grammar as
// BASIN_SCOPE.

import { describe, expect, it } from "vitest";
import { parseUserScopeMap, resolveUserScope } from "../src/user-scopes.js";
import { parseDeploymentScope } from "../src/scope-map.js";

const MAP = JSON.stringify({
  exact: {
    "ian@corp.example": "bucket",
    "Analyst@corp.example": "table:finance/transactions",
  },
  patterns: [
    { pattern: "*@finance.example.com", scope: "namespace:finance" },
    { pattern: "*@corp.example", scope: "namespace:public" },
  ],
  default: "namespace:public",
});

describe("parseUserScopeMap", () => {
  it("parses exact, patterns, and default", () => {
    const r = parseUserScopeMap(MAP);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(Object.keys(r.map.exact)).toContain("ian@corp.example");
    expect(r.map.patterns).toHaveLength(2);
    expect(r.map.default).toBe("namespace:public");
  });

  it("normalizes exact keys case-insensitively", () => {
    const r = parseUserScopeMap(MAP);
    if (!r.ok) throw new Error(r.error);
    expect(r.map.exact["analyst@corp.example"]).toBe("table:finance/transactions");
  });

  it("treats an unset var as an empty map (callers keep BASIN_SCOPE)", () => {
    const r = parseUserScopeMap(undefined);
    expect(r).toEqual({ ok: true, map: { exact: {}, patterns: [] } });
  });

  it("rejects malformed configuration loudly, never silently", () => {
    expect(!parseUserScopeMap("{oops").ok).toBe(true);
    expect(!parseUserScopeMap("[]").ok).toBe(true);
    expect(!parseUserScopeMap('{"exact": []}').ok).toBe(true);
    expect(!parseUserScopeMap('{"exact": {"a@b.c": 5}}').ok).toBe(true);
    expect(!parseUserScopeMap('{"exact": {"a@b.c": "warehouse:*"}}').ok).toBe(true);
    expect(!parseUserScopeMap('{"patterns": {"x": "bucket"}}').ok).toBe(true);
    expect(!parseUserScopeMap('{"patterns": [{"pattern": "@x", "scope": "bucket"}]}').ok).toBe(true);
    expect(!parseUserScopeMap('{"patterns": [{"pattern": "*@x", "scope": "nonsense"}]}').ok).toBe(true);
    expect(!parseUserScopeMap('{"default": 5}').ok).toBe(true);
  });
});

describe("resolveUserScope", () => {
  const parsed = parseUserScopeMap(MAP);
  if (!parsed.ok) throw new Error(parsed.error);
  const map = parsed.map;

  it("exact match wins over patterns, case-insensitively", () => {
    const r = resolveUserScope("IAN@CORP.EXAMPLE", map);
    expect(r.ok && r.scope.kind === "bucket").toBe(true);
    expect(r.ok && r.matched === "exact").toBe(true);
    const t = resolveUserScope("analyst@Corp.Example", map);
    expect(t.ok && t.scope.kind === "table" && t.scope.namespace === "finance" && t.scope.table === "transactions").toBe(true);
  });

  it("patterns match by suffix, in order, after exact", () => {
    const r = resolveUserScope("bob@finance.example.com", map);
    expect(r.ok && r.scope.kind === "namespace" && r.scope.namespace === "finance").toBe(true);
    // first matching pattern wins
    const second = resolveUserScope("carol@corp.example", map);
    expect(second.ok && second.matched === "patterns").toBe(true);
  });

  it("the default covers unmatched users", () => {
    const r = resolveUserScope("someone@else.org", map);
    expect(r.ok && r.matched === "default" && r.scope.kind === "namespace").toBe(true);
  });

  it("fails closed for unmatched users when there is no default", () => {
    const { default: _omit, ...noDefault } = map;
    const r = resolveUserScope("someone@else.org", noDefault);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("failing closed");
  });

  it("scope specs are grammatically identical to BASIN_SCOPE", () => {
    expect(parseDeploymentScope("namespace:finance")).toEqual({
      kind: "namespace",
      namespace: "finance",
    });
    expect(() => parseDeploymentScope("finance")).toThrow();
  });
});
