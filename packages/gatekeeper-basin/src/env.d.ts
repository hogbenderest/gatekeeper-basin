// Bindings and vars for the gatekeeper-basin Worker. Secrets (BASIN_SQL_TOKEN) are installed via
// `wrangler secret put` and appear on env the same way, but are deliberately not declared with a
// default here beyond `string | undefined`: nothing in this package may read them outside the
// credential paths, and they are never logged.

declare namespace Cloudflare {
  interface Env {
    /** Public base path of this gatekeeper, e.g. https://os.example.com/gatekeeper/basin. */
    BASE_URL?: string;

    // ---- Deployment auto-provision mode ----
    /**
     * R2 API token (R2 Storage Admin Read & Write, the credential Basin SQL requires today).
     * Presence of this secret switches the vendor to auto-provision mode: accounts are minted
     * from the deployment's shared credential and manual connects are refused.
     */
    BASIN_SQL_TOKEN?: string;
    /** Cloudflare account ID that owns the warehouse bucket. Auto-provision mode only. */
    BASIN_ACCOUNT_ID?: string;
    /** Bucket name (the Basin catalog / warehouse). Auto-provision mode only. */
    BASIN_BUCKET?: string;
    /**
     * Scope of the ambient singleton grant: "bucket" (default), "namespace:<ns>", or
     * "table:<ns>/<table>". Auto-provision mode only.
     */
    BASIN_SCOPE?: string;

    /**
     * Optional BASIN_USER_SCOPES (JSON object): maps the provisioning user's verified
     * email to their ambient singleton's scope, for per-user governance on the shared
     * deployment credential. Keys: "exact" (email -> scope), "patterns" (array of
     * {pattern, scope}, single leading "*" suffix match), "default" (scope for
     * unmatched users). Scope grammar is the BASIN_SCOPE one: "bucket",
     * "namespace:<ns>", "table:<ns>/<table>". When set, unmapped users fail closed.
     */
    BASIN_USER_SCOPES?: string;

    // ---- Tunables (both modes) ----
    /** Daily scan budget per binding, in MB of compressed bytes scanned. Default 2048. */
    BASIN_DAILY_SCAN_MB?: string;
    /**
     * Bytes reserved against the daily budget per billed query before it executes
     * (reserve-then-settle, bounding concurrent overshoot). Default 10, the
     * documented per-query minimum scan. A query that scans less than its
     * reservation keeps the reservation.
     */
    BASIN_RESERVE_MB?: string;
    /**
     * Hard cap on one provider response body read, in MB. Default 64. A larger body
     * is refused before it lands in Worker memory (audit run 1, finding 6).
     */
    BASIN_MAX_RESPONSE_MB?: string;
    /** Maximum rows returned per query page. Default 500 (the engine caps at its own limit). */
    BASIN_MAX_ROWS?: string;
    /** Query abort timeout in milliseconds. Default 30000. */
    BASIN_QUERY_TIMEOUT_MS?: string;
    /** Catalog discovery cache TTL in milliseconds. Default 3600000 (one hour). */
    BASIN_CATALOG_TTL_MS?: string;
    /** Maximum tables with inline column detail in getCatalog(). Default 100. */
    BASIN_DESCRIBE_CAP?: string;
    /**
     * Optional deployment-supplied notes served with the catalog, as a JSON array of strings
     * (e.g. house conventions for this warehouse). Never put secrets here; this is plain text
     * shown to agents.
     */
    BASIN_NOTES?: string;
  }
}
