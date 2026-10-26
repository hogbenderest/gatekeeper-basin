// TypeScript interface for the Basin gatekeeper. These types are exposed to agents and
// gadgets as their sole API documentation for querying a Cloudflare Basin warehouse:
// Apache Iceberg tables in an R2 bucket, queried through Basin SQL.

/**
 * Query result rows, one object per row, keyed by column name. Cell values are JSON
 * scalars, objects, or arrays as the column type dictates: JSON-typed columns carry a
 * double-encoded JSON *string* (see the notes on BasinCatalog for how to unwrap them).
 */
export type BasinRow = Record<string, unknown>;

/** One column of a result or table. */
export interface BasinColumn {
  name: string;
  type: string;
}

/**
 * Pages through the rows of a large query result. Call next() repeatedly on the same
 * cursor: each call returns the next batch of rows, or null when the result is
 * exhausted. Dispose the cursor when done. A cursor belongs to the session that created
 * it; page a result before starting another query on the same session.
 */
export interface BasinRowsCursor {
  next(): Promise<BasinRow[] | null>;
  [Symbol.dispose](): void;
}

/** The outcome of one governed query. */
export interface BasinQueryResult {
  /** Columns of the result, in order. */
  schema: BasinColumn[];
  /** The first page of rows. Empty when the query matched nothing. */
  rows: BasinRow[];
  /** What the query cost the engine to run. */
  metrics: {
    /** Compressed bytes scanned, the unit Basin SQL bills. */
    bytesScanned: number;
    filesScanned: number;
  };
  /** True when more rows exist beyond the first page; page them with `more`. */
  truncated: boolean;
  /** Pages remaining rows, or null when everything was returned in `rows`. */
  more: BasinRowsCursor | null;
  /** The engine's request id, for quoting when reporting a problem. */
  requestId: string;
}

/** A table inside the warehouse. */
export interface BasinTableInfo {
  namespace: string;
  table: string;
  columns: BasinColumn[];
  /**
   * Columns the ingest layer adds to every row, when the table has them:
   * "__ingest_ts" (when the row arrived at Cloudflare, UTC) and "event_id" (the
   * pipeline's row key; ingestion is at-least-once, so count distinct event_id when
   * exact counts matter). Prefer __ingest_ts over a source timestamp for time windows
   * unless the question is specifically about source time.
   */
  ingestColumns: string[];
  /** Notes that matter when querying this table, if any are known. */
  notes: string[];
}

/** One namespace (schema) of the warehouse. */
export interface BasinNamespaceInfo {
  namespace: string;
  tables: string[];
}

/** The warehouse as this binding sees it. */
export interface BasinCatalog {
  /** The bucket (warehouse) name. */
  bucket: string;
  /** Namespaces this binding can read, with their table names. */
  namespaces: BasinNamespaceInfo[];
  /**
   * Full column detail (BasinTableInfo) for up to `describeLimit` tables. For any other
   * table, call getTable(...).describe(). Narrow bindings list only what they can read.
   */
  tables: BasinTableInfo[];
  describeLimit: number;
  /** Total number of tables this binding can read. */
  totalTables: number;
  /**
   * How to query Basin correctly: engine behaviours and limits that apply to every
   * table. Read these before writing non-trivial SQL; they prevent common dead ends
   * (double-encoded JSON, the JSON function size cap, the manifest cap).
   */
  platformNotes: string[];
  /** Deployment-specific notes for this warehouse, if the operator supplied any. */
  deploymentNotes: string[];
}

/** Ingest freshness of a table, from a bounded probe over the last day. */
export interface BasinFreshness {
  /** The newest __ingest_ts seen in the last day, ISO 8601 UTC, or null when none. */
  latestIngestTs: string | null;
  /** Rows ingested in the last day. */
  rowsInLastDay: number;
  /** "verified" when the probe ran against a table that carries __ingest_ts. */
  completeness: "verified" | "unknown";
}

/** This binding's daily scan budget. */
export interface BasinBudget {
  capBytes: number;
  usedBytes: number;
  /** When the counter resets, ISO 8601 UTC (midnight). */
  resetsAtUtc: string;
}

/**
 * One namespace of the warehouse, as a narrower binding. Every method enforces the
 * namespace scope: queries may read only this namespace's tables.
 */
export interface BasinNamespace {
  /** The namespace's tables. */
  describe(): Promise<BasinNamespaceInfo>;
  /** A table of this namespace, as its own narrowed binding. */
  getTable(table: string): Promise<BasinTable>;
  /** A governed query over this namespace's tables. */
  query(sql: string): Promise<BasinQueryResult>;
}

/**
 * One table of the warehouse, as the narrowest binding. Every method enforces the
 * single-table scope.
 */
export interface BasinTable {
  /** The table's columns and ingest columns. */
  describe(): Promise<BasinTableInfo>;
  /** A governed query that may reference only this table. */
  query(sql: string): Promise<BasinQueryResult>;
  /**
   * Ingest freshness (see BasinFreshness). This is a data-bearing probe: it bills
   * against the scan budget. Call it deliberately, not in every turn.
   */
  getFreshness(): Promise<BasinFreshness>;
}

/**
 * The Basin warehouse as this binding grants it. A bucket binding can query anything in
 * the warehouse; a namespace or table binding has the same surface with its scope
 * enforced on every query, including metadata.
 *
 * Queries are read-only and governed: a lexical pre-flight, scope enforcement, a free
 * engine plan check, and the daily scan budget all apply before a query runs. Write
 * keywords are refused.
 */
export interface BasinSession {
  /**
   * The warehouse schema as this binding sees it: namespaces, table names, column
   * detail up to a cap, and the platform notes. Free of scan cost.
   */
  getCatalog(): Promise<BasinCatalog>;
  /**
   * A namespace of this warehouse as a narrowed binding. A bucket binding can narrow
   * to any namespace; a namespace binding can only narrow to its own.
   */
  getNamespace(namespace: string): Promise<BasinNamespace>;
  /**
   * A table as a narrowed binding. A bucket binding can narrow to any table; narrower
   * bindings only to tables inside their scope.
   */
  getTable(namespace: string, table: string): Promise<BasinTable>;
  /**
   * Run one governed SQL statement over the binding's scope. SELECT, WITH, EXPLAIN,
   * SHOW and DESCRIBE are allowed; one statement at a time. Table references outside
   * this binding's scope are refused. Results page through `BasinQueryResult.more`.
   */
  query(sql: string): Promise<BasinQueryResult>;
  /** The binding's remaining daily scan budget. */
  getBudget(): Promise<BasinBudget>;
}
