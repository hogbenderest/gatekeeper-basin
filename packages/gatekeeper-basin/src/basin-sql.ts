// The only module that talks HTTP to Basin SQL (POST
// /api/v1/accounts/{accountId}/basin-sql/query/{bucket}). Every response is validated
// before use: no blind casts. Provider error codes are mapped to actionable messages so
// an agent can correct its query without trial and error.
//
// The token arrives here only through a BasinCredentials value held by the gatekeeper.
// It is never logged and never included in an error message.

export interface BasinCredentials {
  accountId: string;
  bucket: string;
  token: string;
}

/** Engine response shape, validated subset. */
export interface BasinQueryResponse {
  requestId: string;
  schema: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  metrics: { bytesScanned: number; filesScanned: number };
  /** The full untruncated row count the engine returned, if more than we keep. */
  totalRows: number;
}

/** A provider failure with the mapped, agent-facing message. */
export class BasinSqlError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "BasinSqlError";
  }

  /** True when the credential was rejected (bad or revoked token). */
  get authFailure(): boolean {
    return this.code === 401 || this.code === 403 || this.code === 9500;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface RawColumn {
  name?: unknown;
  type?: unknown;
  descriptor?: { type?: { name?: unknown; nullable?: unknown } };
}
interface RawMetrics {
  bytes_scanned?: unknown;
  files_scanned?: unknown;
}
interface RawEnvelope {
  success?: unknown;
  result?: {
    request_id?: unknown;
    schema?: RawColumn[];
    rows?: unknown;
    metrics?: RawMetrics;
  };
  errors?: { code?: unknown; message?: unknown }[];
}

function asString(v: unknown, what: string): string {
  return typeof v === "string" ? v : throwMalformed(what);
}

function asFiniteNumber(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : throwMalformed(what);
}

function throwMalformed(what: string): never {
  throw new BasinSqlError(`Unexpected response shape from the SQL endpoint (${what}).`);
}

function columnType(c: RawColumn): string {
  const viaDescriptor = c.descriptor?.type?.name;
  if (typeof viaDescriptor === "string") return viaDescriptor;
  if (typeof c.type === "string") return c.type;
  return "unknown";
}

/**
 * Map provider error codes to guidance an agent can act on. The raw provider
 * message is deliberately NOT embedded in the agent-facing text (audit run 1,
 * finding 4): engine error text can carry warehouse-derived content, and it
 * crosses to the caller through the error message. The raw message stays on the
 * BasinSqlError's providerMessage property for Worker-side logs, which do not
 * cross the RPC boundary (capnweb serializes only name/message/stack).
 */
export function mapProviderError(code: number | undefined, _message: string): string {
  switch (code) {
    case 40020:
      return (
        "This query spans too many Iceberg manifests. " +
        "Split multi-table queries into one table per statement, or query each table separately."
      );
    case 40001:
      return "The SQL engine rejected the query: check syntax, and check table and column names against the catalog.";
    case 401:
    case 403:
      return "The R2 API token was rejected; it may be missing the required permissions or revoked.";
    case 404:
      return "A named table or namespace does not exist: check the names against the catalog.";
    default:
      return `The SQL endpoint returned an error${code ? ` (code ${code})` : ""}.`;
  }
}

/** Parse and validate a raw JSON body into a typed response, or throw BasinSqlError. */
export function parseQueryResponse(body: unknown): BasinQueryResponse {
  const env = body as RawEnvelope | null;
  if (env === null || typeof env !== "object") throwMalformed("body");
  if (env.success === false) {
    const first = env.errors?.[0];
    const code = typeof first?.code === "number" ? first.code : undefined;
    const raw = typeof first?.message === "string" ? first.message : "";
    throw new BasinSqlError(mapProviderError(code, raw), code, raw);
  }
  const result = env.result;
  if (result === null || typeof result !== "object") throwMalformed("result");
  if (!Array.isArray(result.rows) || !Array.isArray(result.schema)) throwMalformed("rows/schema");
  const rows: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throwMalformed("row");
    rows.push(row as Record<string, unknown>);
  }
  return {
    requestId:
      typeof result.request_id === "string" ? result.request_id : "unknown",
    schema: result.schema.map((c) => ({
      name: asString(c?.name, "column name"),
      type: columnType(c ?? {}),
    })),
    rows,
    metrics: {
      bytesScanned: asFiniteNumber(result.metrics?.bytes_scanned, "bytes_scanned"),
      filesScanned: asFiniteNumber(result.metrics?.files_scanned, "files_scanned"),
    },
    totalRows: rows.length,
  };
}

/** The text of an EXPLAIN response, robust to column naming: all string cell values joined. */
export function explainPlanText(response: BasinQueryResponse): string {
  const parts: string[] = [];
  for (const row of response.rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

export interface BasinSqlClient {
  /** Run one (pre-guardrailed) statement and return the validated response. */
  runQuery(sql: string, opts?: { timeoutMs?: number }): Promise<BasinQueryResponse>;
}

/**
 * A thin client over the Basin SQL REST endpoint. One instance per resolved credential;
 * constructed freely, it holds no state beyond the credential.
 */
export function createBasinSqlClient(creds: BasinCredentials): BasinSqlClient {
  const url =
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(creds.accountId)}` +
    `/basin-sql/query/${encodeURIComponent(creds.bucket)}`;
  return {
    async runQuery(sql, opts): Promise<BasinQueryResponse> {
      const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${creds.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: sql }),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        throw new BasinSqlError(
          "The SQL endpoint was unreachable or the query timed out.",
          undefined,
          e instanceof Error ? e.message : undefined,
        );
      }
      if (resp.status === 401 || resp.status === 403) {
        await resp.body?.cancel().catch(() => {});
        throw new BasinSqlError(
          "The R2 API token was rejected; it may be missing the required permissions or revoked.",
          resp.status,
        );
      }
      const bodyText = await resp.text().catch(() => "");
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new BasinSqlError(
          `The SQL endpoint returned a non-JSON response (HTTP ${resp.status}).`,
        );
      }
      const parsed = parseQueryResponse(body);
      if (resp.status !== 200) {
        // A non-200 that still parsed: treat as a provider failure with its error text.
        const first = (body as RawEnvelope).errors?.[0];
        const code = typeof first?.code === "number" ? first.code : resp.status;
        throw new BasinSqlError(
          mapProviderError(code, typeof first?.message === "string" ? first.message : ""),
          code,
        );
      }
      return parsed;
    },
  };
}
