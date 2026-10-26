// Per-user scope resolution for deployment (auto-provision) mode.
//
// BASIN_SCOPE alone gives every user of the deployment the same grant. An enterprise
// that needs per-user (or per-group) table access instead sets BASIN_USER_SCOPES: a
// gatekeeper-side mapping from the provisioning user's verified email to the scope of
// their ambient singleton. The plan verifier then enforces that scope authoritatively,
// per user, per query, with the same audit trail.
//
// The map is deliberately simple and fail-closed:
//  - `exact` matches the full email, case-insensitively.
//  - `patterns` are single-leading-`*` suffix matches (e.g. "*@finance.example.com"),
//    checked after exact matches, in declaration order.
//  - `default` applies to unmatched users. Without it, an unmatched user gets NO
//    warehouse at all: a clear error at provisioning beats a silent over-grant.
//  - When BASIN_USER_SCOPES is unset, deployments keep today's behaviour: BASIN_SCOPE
//    for everyone.
//
// Scope specs reuse the BASIN_SCOPE grammar: "bucket", "namespace:<ns>",
// "table:<ns>/<table>".

import type { BasinScope } from "./scope.js";
import { parseDeploymentScope } from "./scope-map.js";

export interface UserScopeMap {
  exact: Record<string, string>;
  patterns: { pattern: string; scope: string }[];
  default?: string;
}

export type UserScopeMapResult =
  | { ok: true; map: UserScopeMap }
  | { ok: false; error: string };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Parse the BASIN_USER_SCOPES JSON. Invalid configuration is an operator error, never a silent fallthrough. */
export function parseUserScopeMap(raw: string | undefined): UserScopeMapResult {
  if (!raw) return { ok: true, map: { exact: {}, patterns: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "BASIN_USER_SCOPES is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, error: "BASIN_USER_SCOPES must be a JSON object." };
  const source = parsed as Record<string, unknown>;
  const result: UserScopeMap = { exact: {}, patterns: [] };

  const exact = source["exact"];
  if (exact !== undefined) {
    if (exact === null || typeof exact !== "object" || Array.isArray(exact))
      return { ok: false, error: "BASIN_USER_SCOPES.exact must be an object of email -> scope." };
    for (const [email, scope] of Object.entries(exact as Record<string, unknown>)) {
      if (typeof scope !== "string")
        return { ok: false, error: `BASIN_USER_SCOPES.exact["${email}"] must be a scope string.` };
      try {
        parseDeploymentScope(scope);
      } catch {
        return {
          ok: false,
          error: `BASIN_USER_SCOPES.exact["${email}"] is not a valid scope: ${JSON.stringify(scope)}.`,
        };
      }
      result.exact[normalizeEmail(email)] = scope;
    }
  }

  const patterns = source["patterns"];
  if (patterns !== undefined) {
    if (!Array.isArray(patterns))
      return { ok: false, error: "BASIN_USER_SCOPES.patterns must be an array of {pattern, scope}." };
    for (const entry of patterns) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return { ok: false, error: "BASIN_USER_SCOPES.patterns entries must be objects." };
      const { pattern, scope } = entry as Record<string, unknown>;
      if (typeof pattern !== "string" || typeof scope !== "string")
        return { ok: false, error: "BASIN_USER_SCOPES.patterns entries need string pattern and scope." };
      try {
        parseDeploymentScope(scope);
      } catch {
        return {
          ok: false,
          error: `BASIN_USER_SCOPES.patterns scope ${JSON.stringify(scope)} is not valid.`,
        };
      }
      if (!pattern.startsWith("*"))
        return {
          ok: false,
          error: `BASIN_USER_SCOPES pattern ${JSON.stringify(pattern)} must start with "*" (suffix match).`,
        };
      result.patterns.push({ pattern: pattern.toLowerCase(), scope });
    }
  }

  if ("default" in source) {
    const def = source["default"];
    if (typeof def !== "string")
      return { ok: false, error: "BASIN_USER_SCOPES.default must be a scope string." };
    try {
      parseDeploymentScope(def);
    } catch {
      return { ok: false, error: `BASIN_USER_SCOPES.default is not a valid scope: ${JSON.stringify(def)}.` };
    }
    result.default = def;
  }

  return { ok: true, map: result };
}

export type UserScopeResolution =
  | { ok: true; scope: BasinScope; matched: "exact" | "patterns" | "default" }
  | { ok: false; error: string };

/**
 * Resolve a user's scope. `mapEnabled` is whether BASIN_USER_SCOPES is set at all; when
 * it is not, callers keep the deployment-wide BASIN_SCOPE and this is never invoked.
 */
export function resolveUserScope(email: string, map: UserScopeMap): UserScopeResolution {
  const normalized = normalizeEmail(email);
  const exact = map.exact[normalized];
  if (exact !== undefined)
    return { ok: true, scope: parseDeploymentScope(exact), matched: "exact" };
  for (const { pattern, scope } of map.patterns) {
    if (normalized.endsWith(pattern.slice(1)))
      return { ok: true, scope: parseDeploymentScope(scope), matched: "patterns" };
  }
  if (map.default !== undefined)
    return { ok: true, scope: parseDeploymentScope(map.default), matched: "default" };
  return {
    ok: false,
    error:
      `No Basin scope is mapped for ${email} and BASIN_USER_SCOPES has no default. ` +
      "Map the user (or their domain), or set a default scope; failing closed.",
  };
}
