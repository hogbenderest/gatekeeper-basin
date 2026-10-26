// Warehouse discovery and the platform knowledge the gatekeeper serves to agents.
// SHOW DATABASES / SHOW TABLES / DESCRIBE are metadata-only and free, so discovery costs
// nothing but round trips; results are cached in the Gatekeeper DO with a TTL.
//
// The platform notes are the distilled, live-verified behaviours of Basin SQL that make
// the difference between an agent that queries the warehouse correctly and one that
// flails: they encode facts about the engine, not about any particular warehouse.
// Deployment-supplied notes (BASIN_NOTES) are appended after them.

import type { BasinSqlClient } from "./basin-sql.js";

export interface BasinTableDetail {
  namespace: string;
  table: string;
  columns: { name: string; type: string }[];
}

export interface DiscoveredCatalog {
  fetchedAt: string;
  namespaces: { namespace: string; tables: string[] }[];
}

export const INGEST_COLUMNS = ["__ingest_ts", "event_id"] as const;

/** Engine-level notes served with every catalog. Verified against live Basin SQL. */
export const PLATFORM_NOTES: string[] = [
  "JSON-typed columns store double-encoded JSON: the cell is a JSON string containing the JSON. Unwrap with a single-argument json_get_str(fields), then look up keys with json_get_str(json_get_str(fields), '<key>').",
  "JSON function inputs are capped at 2000 bytes. Wide JSON columns (large metric payloads) can exceed the cap: extract with regexp_replace on the raw text followed by TRY_CAST instead of JSON functions.",
  "The JSON string function is json_get_str (there is no json_get_string); json_get_bool exists.",
  "EXPLAIN, SHOW and DESCRIBE are metadata-only and free. Data-bearing queries bill compressed bytes scanned with a 10 MB per-query minimum.",
  "Ingestion is at-least-once; event_id is required but end-to-end dedup is not documented. Use approx_distinct(event_id) where exact counts matter.",
  "Basin Pipelines sinks add __ingest_ts (ingest time) to every row. Time-bound queries on router/syslog-like sources should use __ingest_ts, not the event's own timestamp column, which can drift from real time.",
  "A single query is capped at 5000 Iceberg manifests (error 40020). Multi-table UNIONs can exceed the cap: batch small, or query per table.",
  "date_trunc, QUALIFY ROW_NUMBER() OVER (PARTITION BY ...), approx_distinct, ILIKE, TRY_CAST and regexp_replace are supported.",
  "Every SELECT must reference at least one table (no bare SELECT of literals).",
  "The engine's default LIMIT applies when a statement carries none; this gatekeeper appends its own LIMIT when one is missing.",
];

function firstStringValue(row: Record<string, unknown>): string | null {
  for (const key of ["database_name", "namespace", "namespace_name", "name", "table_name"]) {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const v of Object.values(row)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function firstStringValues(rows: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const v = firstStringValue(row);
    if (v !== null) out.push(v);
  }
  return out;
}

/** SHOW DATABASES: the warehouse's namespaces. */
export async function discoverNamespaces(client: BasinSqlClient): Promise<string[]> {
  const resp = await client.runQuery("SHOW DATABASES", { timeoutMs: 15_000 });
  return firstStringValues(resp.rows).filter((n) => n !== "information_schema");
}

/** SHOW TABLES IN <ns>: table names in one namespace. */
export async function discoverTables(
  client: BasinSqlClient,
  namespace: string,
): Promise<string[]> {
  const resp = await client.runQuery(`SHOW TABLES IN ${identifier(namespace)}`, {
    timeoutMs: 15_000,
  });
  return firstStringValues(resp.rows);
}

/** DESCRIBE <ns>.<table>: column names and types. */
export async function describeTable(
  client: BasinSqlClient,
  namespace: string,
  table: string,
): Promise<{ name: string; type: string }[]> {
  const resp = await client.runQuery(`DESCRIBE ${identifier(namespace)}.${identifier(table)}`, {
    timeoutMs: 15_000,
  });
  const columns: { name: string; type: string }[] = [];
  for (const row of resp.rows) {
    const name = firstStringValue(row);
    const type =
      typeof row["data_type"] === "string"
        ? (row["data_type"] as string)
        : typeof row["type"] === "string"
          ? (row["type"] as string)
          : "unknown";
    if (name === null || name === "type" || name === "column_name") continue;
    columns.push({ name, type });
  }
  return columns;
}

/** A conservative SQL identifier: plain [A-Za-z_][A-Za-z0-9_]* only, never quoted. */
export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Unsupported identifier: ${JSON.stringify(name)}`);
  return name;
}

/** One full catalog pass: namespaces, their tables, and columns up to a cap. */
export async function discoverCatalog(
  client: BasinSqlClient,
  describeCap: number,
): Promise<DiscoveredCatalog> {
  const namespaces: DiscoveredCatalog["namespaces"] = [];
  let described = 0;
  for (const ns of await discoverNamespaces(client)) {
    const tables = await discoverTables(client, ns);
    namespaces.push({ namespace: ns, tables });
    described += tables.length;
    if (described > describeCap) break;
  }
  return { fetchedAt: new Date().toISOString(), namespaces };
}

/** Parse BASIN_NOTES (JSON array of strings), tolerating absence and bad JSON. */
export function deploymentNotes(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/** Columns the pipelines layer adds, when present on a table. */
export function ingestColumnsPresent(columns: { name: string }[]): string[] {
  const names = new Set(columns.map((c) => c.name));
  return INGEST_COLUMNS.filter((c) => names.has(c));
}
