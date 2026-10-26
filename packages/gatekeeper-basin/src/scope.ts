// Binding-scope enforcement for Basin SQL. A binding is one of three granularities -
// the whole bucket, one namespace, or one table - and queries submitted through a narrow
// binding must not be able to read (or enumerate) anything outside that grant, even
// though the underlying R2 credential the gatekeeper holds is bucket-wide.
//
// Enforcement is layered, and deliberately does not trust lexical analysis alone
// (SQL has too many shapes: delimited identifiers, table-valued functions, lateral
// subqueries, scalar subqueries in projections). The authoritative check for narrow
// scopes is the engine's own resolved plan: every query is prefaced by a free
// `EXPLAIN` and the plan's `TableScan` nodes are the set of tables the query actually
// reads. Lexical rules handle what the plan cannot: metadata statements (SHOW /
// DESCRIBE) and information_schema, plus a conservative rejection of delimited
// identifiers that no analyzer here promises to understand.
//
// The residual risk is documented: error text from a failed preflight can confirm the
// existence of a named object (one bit per guess), which upstream's own observer
// guidance treats as acceptable for existence probing.

export type BasinScope =
  | { kind: "bucket" }
  | { kind: "namespace"; namespace: string }
  | { kind: "table"; namespace: string; table: string };

export type ScopeCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** Statement head kinds, after guardrail allowlisting. */
export type StatementKind = "data" | "show" | "describe" | "explain";

/** Classify the guardrail-passed statement by its leading keyword. */
export function statementKind(analysis: string): StatementKind {
  const head = analysis.replace(/^\(+\s*/, "");
  if (/^explain\b/i.test(head)) return "explain";
  if (/^show\b/i.test(head)) return "show";
  if (/^describe\b/i.test(head)) return "describe";
  return "data"; // select / with
}

/** The text a scope check analyzes for an EXPLAIN statement: its subject. */
export function explainSubject(analysis: string): string {
  // Leading parens are optional (\(+ is one-or-more literal parens, so it is wrapped
  // in an optional group rather than assumed away).
  return analysis.replace(/^(?:\(+\s*)?explain\s+/i, "").trim();
}

// CTE names: `WITH name AS (` / `, name AS (`. Only unquoted names are recognized;
// a query that defines a quoted CTE is rejected by the delimited-identifier rule before
// this matters.
export function extractCteNames(analysis: string): Set<string> {
  const names = new Set<string>();
  const RE = /(?:\bwith\s+|,\s*)([A-Za-z_]\w*)\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(analysis)) !== null) names.add(m[1]);
  return names;
}

/** Reject delimited identifiers ("x", `x`) anywhere in the query for narrow bindings. */
const DELIMITED_RE = /["`]/;

/** `ns.name` references, from neutralized text. Includes CTE-free dotted pairs only. */
export function extractDottedRefs(analysis: string): { first: string; second: string }[] {
  const refs: { first: string; second: string }[] = [];
  const RE = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(analysis)) !== null) refs.push({ first: m[1], second: m[2] });
  return refs;
}

function rejectUnanalyzable(analysis: string): ScopeCheck | null {
  if (DELIMITED_RE.test(analysis))
    return {
      ok: false,
      reason:
        'Quoted identifiers ("name" or `name`) are not supported inside this binding\'s scope; use plain, fully qualified names.',
    };
  if (/\binformation_schema\b/i.test(analysis))
    return {
      ok: false,
      reason:
        "information_schema is not available inside this binding; it can enumerate beyond the granted scope.",
    };
  return null;
}

/**
 * Lexical pre-screen, run on the neutralized analysis text of the guardrail-passed
 * query (for EXPLAIN statements, of the subject query).
 *
 * The lexical layer enforces only what the engine plan cannot, and refuses what no
 * analyzer here promises to understand:
 *
 *  - Quoted identifiers are refused outright for narrow bindings: they defeat token
 *    analysis, and the plan check cannot promise to recognize every quoted form.
 *  - information_schema is refused: it can enumerate beyond the grant.
 *  - Metadata statements are enforced lexically because they never reach a plan:
 *    SHOW DATABASES is refused; SHOW TABLES must target the bound namespace (and is
 *    refused entirely for table bindings, which must not see their siblings);
 *    DESCRIBE must name a table inside the grant.
 *
 * Data statements are NOT checked for table references here: alias-qualified columns
 * (d.name), struct paths and CTE references make any lexical table-reference rule
 * either unsound or riddled with false positives. Table references are enforced by
 * the authoritative engine plan check (checkExplainPlan) on every narrow-binding
 * query, before anything is billed or returned.
 */
export function staticScopeCheck(analysis: string, scope: BasinScope): ScopeCheck {
  if (scope.kind === "bucket") return { ok: true };
  const unanalyzable = rejectUnanalyzable(analysis);
  if (unanalyzable) return unanalyzable;
  const head = analysis.replace(/^\(+\s*/, "");

  if (/^show\s+tables\b/i.test(head)) {
    const m = head.match(/^show\s+tables\s+in\s+([A-Za-z_]\w*)\s*$/i);
    if (!m)
      return {
        ok: false,
        reason: "Use SHOW TABLES IN <namespace>, naming this binding's namespace.",
      };
    if (scope.kind === "table")
      return { ok: false, reason: "SHOW TABLES is not available inside a table binding." };
    if (m[1] !== scope.namespace)
      return {
        ok: false,
        reason: `SHOW TABLES must target this binding's namespace (${scope.namespace}).`,
      };
    return { ok: true };
  }

  if (/^show\b/i.test(head))
    return {
      ok: false,
      reason: "SHOW statements other than SHOW TABLES IN <bound namespace> are not available inside this binding.",
    };

  if (/^describe\b/i.test(head)) {
    const m = head.match(/^describe\s+(?:table\s+)?([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*$/i);
    if (!m)
      return {
        ok: false,
        reason: "DESCRIBE a fully qualified <namespace>.<table> inside this binding.",
      };
    const [, first, maybeSecond] = m;
    // DESCRIBE x or DESCRIBE ns.x; the two-identifier form names [ns].[table].
    const ns = maybeSecond !== undefined ? first : undefined;
    const table = maybeSecond ?? first;
    if (scope.kind === "table") {
      if (ns !== scope.namespace || table !== scope.table)
        return {
          ok: false,
          reason: `DESCRIBE must name this binding's table (${scope.namespace}.${scope.table}).`,
        };
      return { ok: true };
    }
    if (ns === undefined)
      return {
        ok: false,
        reason: `Qualify the table as ${scope.namespace}.<table> inside this binding.`,
      };
    if (ns !== scope.namespace)
      return {
        ok: false,
        reason: `DESCRIBE must target this binding's namespace (${scope.namespace}).`,
      };
    return { ok: true };
  }

  // Data statement (SELECT / WITH / EXPLAIN subject): table references are enforced
  // by the engine plan check in runGoverned, not here.
  return { ok: true };
}

// DataFusion plan text names every real table read as a TableScan node, in both the
// logical and physical plan: e.g. "TableScan: homelab.dns_queries projection=[...]".
// Information-schema scans carry the information_schema prefix and are treated as
// out-of-scope reads for narrow bindings.
const TABLE_SCAN_RE =
  /\bTableScan:?\s*(?:of\s+)?["`]?([A-Za-z_]\w*)["`]?\s*\.\s*["`]?([A-Za-z_]\w*)["`]?/gi;

/**
 * Verify the engine-resolved plan of a query against a narrow binding. The plan text is
 * the concatenated EXPLAIN output (all rows, all string columns). Every TableScan must
 * be inside the grant; any information_schema scan is refused; a data-statement plan
 * with no recognized scan at all is refused rather than guessed about.
 */
export function checkExplainPlan(
  planText: string,
  scope: BasinScope,
  opts: { metadataStatement?: boolean } = {},
): ScopeCheck {
  if (scope.kind === "bucket") return { ok: true };
  const bound =
    scope.kind === "table"
      ? `${scope.namespace}.${scope.table}`
      : `namespace ${scope.namespace}`;
  const scans: { ns: string; table: string }[] = [];
  let m: RegExpExecArray | null;
  TABLE_SCAN_RE.lastIndex = 0;
  while ((m = TABLE_SCAN_RE.exec(planText)) !== null) {
    scans.push({ ns: m[1], table: m[2] });
  }
  for (const scan of scans) {
    if (scan.ns === "information_schema")
      return {
        ok: false,
        reason: "The query reads information_schema, which is outside this binding.",
      };
    const ok =
      scope.kind === "table"
        ? scan.ns === scope.namespace && scan.table === scope.table
        : scan.ns === scope.namespace;
    if (!ok)
      return {
        ok: false,
        reason: `The query reads ${scan.ns}.${scan.table}, which is outside this binding (${bound}).`,
      };
  }
  if (scans.length === 0 && !opts.metadataStatement) {
    return {
      ok: false,
      reason:
        "The query plan could not be verified against this binding's scope; rewrite it with fully qualified table names.",
    };
  }
  return { ok: true };
}

/** Whether the binding permits the catalog views the session exposes. */
export function scopeAllowsCatalog(scope: BasinScope): boolean {
  return scope.kind === "bucket";
}

/** The resource URL for a scope, as minted into bindings. */
export function scopeUrl(scope: BasinScope, accountId: string, bucket: string): string {
  const base = `basin://${accountId}/${bucket}`;
  if (scope.kind === "bucket") return base;
  if (scope.kind === "namespace") return `${base}/${scope.namespace}`;
  return `${base}/${scope.namespace}/${scope.table}`;
}
