// The BASIN_SCOPE grammar, shared by the deployment var and the per-user scope map:
// "bucket" | "namespace:<ns>" | "table:<ns>/<table>". Pure: importable from Node tests.

import type { BasinScope } from "./scope.js";

/** Parse a scope spec string, throwing a descriptive operator error on anything else. */
export function parseDeploymentScope(raw: string | undefined): BasinScope {
  if (!raw || raw === "bucket") return { kind: "bucket" };
  const nsMatch = raw.match(/^namespace:([A-Za-z_]\w*)$/);
  if (nsMatch) return { kind: "namespace", namespace: nsMatch[1] };
  const tableMatch = raw.match(/^table:([A-Za-z_]\w*)\/([A-Za-z_]\w*)$/);
  if (tableMatch) return { kind: "table", namespace: tableMatch[1], table: tableMatch[2] };
  throw new Error(
    'Scope must be "bucket", "namespace:<ns>", or "table:<ns>/<table>".',
  );
}
