// gatekeeper-basin: a Cloudflare OS gatekeeper for querying a Cloudflare Basin
// warehouse (Apache Iceberg tables in R2, via Basin SQL) under governed, scope-checked,
// budgeted, audited read-only access.
//
// Modes, selected by deployment configuration:
//  - per-user connect (default): each user pastes their own account ID, bucket and R2
//    API token on the connect form; grants are grouped whole-bucket / namespace / table.
//  - deployment auto-provision (BASIN_SQL_TOKEN secret present): a shared credential
//    minted as an ambient singleton account for every user; scope from BASIN_SCOPE.
//
// Security model: read-only (no actions at all); every data crossing to the caller is an
// observation carrying containsRestrictedData; observer strategy A (private-only), so a
// gadget that reads warehouse data cannot be shared. Narrow bindings enforce their scope
// with a lexical pre-screen plus the engine's own resolved plan (free EXPLAIN preflight).

import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionField,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { boundAgentCatalog, stripTrailingSlashes, workerVersionTag } from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import {
  clearCredentialExpiryLatch,
  notifyCredentialsExpiredOnce,
} from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { BasinCredentials, BasinQueryResponse, BasinSqlClient } from "./basin-sql.js";
import { BasinSqlError, createBasinSqlClient, explainPlanText } from "./basin-sql.js";
import {
  deploymentNotes,
  describeTable,
  discoverNamespaces,
  discoverTables,
  identifier,
  ingestColumnsPresent,
  isIdentifier,
  PLATFORM_NOTES,
  type DiscoveredCatalog,
} from "./catalog.js";
import { Budget, budgetCapMb, kvBudgetStore } from "./budget.js";
import { analysisText, defaultRowLimit, maxRowLimit, sanitizeSql } from "./guardrails.js";
import { parseDeploymentScope } from "./scope-map.js";
import { parseUserScopeMap, resolveUserScope } from "./user-scopes.js";
import {
  checkExplainPlan,
  explainSubject,
  scopeUrl,
  statementKind,
  staticScopeCheck,
  type BasinScope,
} from "./scope.js";
import type {
  BasinBudget,
  BasinCatalog,
  BasinFreshness,
  BasinNamespace,
  BasinNamespaceInfo,
  BasinQueryResult,
  BasinRow,
  BasinRowsCursor,
  BasinSession,
  BasinTable,
  BasinTableInfo,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import BUCKET_CONFIGURATOR_HTML from "./generated/bucket-configurator-ui.txt";
import NAMESPACE_CONFIGURATOR_HTML from "./generated/namespace-configurator-ui.txt";
import TABLE_CONFIGURATOR_HTML from "./generated/table-configurator-ui.txt";
import { obsContext } from "./observability.js";
import { parseBasinResourceUrl } from "./resource-url.js";

export { parseBasinResourceUrl } from "./resource-url.js";

export const VENDOR_ID = "basin";

const logger = obsContext.createLogger({ component: "gatekeeper.basin", vendorId: VENDOR_ID });

const BASIN_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'>" +
        "<path d='M40 96h176v104a16 16 0 0 1-16 16H56a16 16 0 0 1-16-16z'/>" +
        "<path d='M40 96 68 48h120l28 48'/>" +
        "<path d='M128 96v120'/>" +
        "</svg>",
    ),
};

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * One grouped connect card: a whole warehouse bucket, one namespace, or one table.
 * Narrow types are declared before the broad one whose pattern also matches their
 * URLs, so Workshop's grant check lands on the right granularity; namespace and
 * table appear on the bucket type's card via groupedWith.
 */
export const TABLE_RESOURCE: SupportedResource = {
  urlPattern: "basin://:accountId/:bucket/:namespace/:table",
  title: "Basin table",
  description: "One table of a Cloudflare Basin warehouse (Iceberg on R2).",
  grantable: true,
  groupedWith: "basin://:accountId/:bucket",
};
export const NAMESPACE_RESOURCE: SupportedResource = {
  urlPattern: "basin://:accountId/:bucket/:namespace",
  title: "Basin namespace",
  description: "Every table in one namespace of a Cloudflare Basin warehouse.",
  grantable: true,
  groupedWith: "basin://:accountId/:bucket",
};
export const BUCKET_RESOURCE: SupportedResource = {
  urlPattern: "basin://:accountId/:bucket",
  title: "Basin warehouse",
  description: "A whole Cloudflare Basin warehouse: every table in the bucket.",
  grantable: true,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [
  TABLE_RESOURCE,
  NAMESPACE_RESOURCE,
  BUCKET_RESOURCE,
];

function basinResourceUrl(creds: BasinCredentials, scope: BasinScope): string {
  return scopeUrl(scope, creds.accountId, creds.bucket);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;
const DEFAULT_DESCRIBE_CAP = 100;

interface GatekeeperConfig {
  maxRows: number;
  timeoutMs: number;
  catalogTtlMs: number;
  describeCap: number;
  scanCapBytes: number;
  /** Bytes reserved per billed query before execution (the reserve-then-settle bound). */
  reserveBytes: number;
  notes: string[];
}

function positiveIntVar(env: Cloudflare.Env, name: keyof Cloudflare.Env, fallback: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readConfig(env: Cloudflare.Env): GatekeeperConfig {
  return {
    maxRows: positiveIntVar(env, "BASIN_MAX_ROWS", DEFAULT_MAX_ROWS),
    timeoutMs: positiveIntVar(env, "BASIN_QUERY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    catalogTtlMs: positiveIntVar(env, "BASIN_CATALOG_TTL_MS", DEFAULT_CATALOG_TTL_MS),
    describeCap: positiveIntVar(env, "BASIN_DESCRIBE_CAP", DEFAULT_DESCRIBE_CAP),
    scanCapBytes: budgetCapMb(env.BASIN_DAILY_SCAN_MB) * 1024 * 1024,
    reserveBytes: positiveIntVar(env, "BASIN_RESERVE_MB", 10) * 1024 * 1024,
    notes: deploymentNotes(env.BASIN_NOTES),
  };
}

/** Deployment BASIN_SCOPE var: "bucket" (default), "namespace:<ns>", "table:<ns>/<table>". */
export { parseDeploymentScope } from "./scope-map.js";

function scopeLabel(scope: BasinScope): string {
  if (scope.kind === "bucket") return "the whole warehouse";
  if (scope.kind === "namespace") return `namespace ${scope.namespace}`;
  return `table ${scope.namespace}.${scope.table}`;
}

// ---------------------------------------------------------------------------
// Catalog cache (Durable Object storage)
// ---------------------------------------------------------------------------

interface KvLike {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** TTL cache over the binding's DO storage: schema list plus per-table columns. */
class CatalogCache {
  readonly #kv: KvLike;
  readonly #ttlMs: number;

  constructor(kv: KvLike, ttlMs: number) {
    this.#kv = kv;
    this.#ttlMs = ttlMs;
  }

  #fresh(fetchedAt: string): boolean {
    return Date.now() - Date.parse(fetchedAt) < this.#ttlMs;
  }

  // The cache key is derived from the discovery scope (audit run 1, finding 8):
  // a single fixed key let whichever scope discovered first after expiry fix
  // the served catalog for the whole TTL, so a namespace-narrowed enumeration
  // masqueraded as the bucket-wide view. Components are identifier-validated by
  // the time discovery runs, so they cannot collide across scopes.
  readCatalog(scope: BasinScope): DiscoveredCatalog | null {
    const v = this.#kv.get<DiscoveredCatalog>(catalogCacheKey(scope));
    if (!v || typeof v.fetchedAt !== "string" || !this.#fresh(v.fetchedAt)) return null;
    return v;
  }

  writeCatalog(scope: BasinScope, catalog: DiscoveredCatalog): void {
    this.#kv.put(catalogCacheKey(scope), catalog);
  }

  readColumns(namespace: string, table: string): { name: string; type: string }[] | null {
    const v = this.#kv.get<{ fetchedAt: string; columns: { name: string; type: string }[] }>(
      `cols:${namespace}:${table}`,
    );
    if (!v || !this.#fresh(v.fetchedAt)) return null;
    return v.columns;
  }

  writeColumns(namespace: string, table: string, columns: { name: string; type: string }[]): void {
    this.#kv.put(`cols:${namespace}:${table}`, { fetchedAt: new Date().toISOString(), columns });
  }
}

function catalogCacheKey(scope: BasinScope): string {
  if (scope.kind === "bucket") return "catalog:bucket";
  if (scope.kind === "namespace") return `catalog:namespace:${scope.namespace}`;
  return `catalog:table:${scope.namespace}:${scope.table}`;
}

/**
 * Discover the part of the warehouse this binding may enumerate. Narrow bindings never
 * enumerate beyond their grant: a namespace binding lists only its own namespace, a
 * table binding lists only its own table. Discovery is metadata-only and free.
 *
 * Names outside the identifier grammar are skipped, not fatal (audit run 1,
 * finding 7): one hyphenated table name used to reject getCatalog for the whole
 * binding and re-poison the cache every TTL. Skipped names are documented in the
 * catalog's platform notes.
 */
async function discoverForScope(
  client: BasinSqlClient,
  scope: BasinScope,
  cache: CatalogCache,
): Promise<DiscoveredCatalog> {
  const cached = cache.readCatalog(scope);
  if (cached) return cached;
  let namespaces: DiscoveredCatalog["namespaces"];
  if (scope.kind === "bucket") {
    namespaces = [];
    for (const ns of (await discoverNamespaces(client)).filter(isIdentifier)) {
      namespaces.push({ namespace: ns, tables: (await discoverTables(client, ns)).filter(isIdentifier) });
    }
  } else if (scope.kind === "namespace") {
    namespaces = [{
      namespace: scope.namespace,
      tables: (await discoverTables(client, scope.namespace)).filter(isIdentifier),
    }];
  } else {
    namespaces = [{ namespace: scope.namespace, tables: [scope.table] }];
  }
  const fresh: DiscoveredCatalog = { fetchedAt: new Date().toISOString(), namespaces };
  cache.writeCatalog(scope, fresh);
  return fresh;
}

async function describeTableCached(
  client: BasinSqlClient,
  cache: CatalogCache,
  namespace: string,
  table: string,
): Promise<{ name: string; type: string }[]> {
  const cached = cache.readColumns(namespace, table);
  if (cached) return cached;
  const columns = await describeTable(client, namespace, table);
  cache.writeColumns(namespace, table, columns);
  return columns;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

interface SessionDeps {
  scope: BasinScope;
  bucket: string;
  client: BasinSqlClient;
  budget: Budget;
  config: GatekeeperConfig;
  cache: CatalogCache;
  approvalQueue: NativeRpcStub<ApprovalQueue>;
}

/** A page of rows still to be delivered, one observation per page. */
@validateRpc()
class BasinRowsCursorImpl extends RpcTarget implements BasinRowsCursor {
  readonly #queue: ObservationQueue;
  readonly #bucket: string;
  readonly #requestId: string;
  readonly #pageSize: number;
  #remaining: BasinRow[];

  constructor(
    deps: { approvalQueue: NativeRpcStub<ApprovalQueue>; bucket: string; requestId: string; pageSize: number },
    remaining: BasinRow[],
  ) {
    super();
    this.#queue = deps.approvalQueue.dup();
    this.#bucket = deps.bucket;
    this.#requestId = deps.requestId;
    this.#pageSize = deps.pageSize;
    this.#remaining = remaining;
  }

  async next(): Promise<BasinRow[] | null> {
    if (this.#remaining.length === 0) return null;
    const page = this.#remaining.slice(0, this.#pageSize);
    this.#remaining = this.#remaining.slice(this.#pageSize);
    await this.#queue.authorizeObservation({
      title: "Page Basin query results",
      description:
        `Received the next page of a Basin query result over ${this.#bucket} ` +
        `(${page.length} rows; request ${this.#requestId}).`,
      containsRestrictedData: true,
    });
    return page;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

function sqlField(sql: string): ActionField | undefined {
  const BYTES = 4000;
  const encoder = new TextEncoder();
  const total = encoder.encode(sql).byteLength;
  if (total <= BYTES) return { label: "SQL", kind: "text", value: sql, syntax: "sql" };
  // Byte-boundary-safe prefix by re-encoding a growing slice.
  let chars = Math.floor((sql.length * BYTES) / total);
  while (encoder.encode(sql.slice(0, chars)).byteLength > BYTES) chars--;
  return {
    label: "SQL",
    kind: "text",
    value: `${sql.slice(0, chars)}\n... (truncated)`,
    syntax: "sql",
    truncated: { shownBytes: encoder.encode(sql.slice(0, chars)).byteLength, totalBytes: total },
  };
}

/**
 * The governed query pipeline shared by every binding granularity: guardrails,
 * lexical scope, free engine plan verification (narrow scopes), budget, execution,
 * budget accounting, observation.
 */
async function runGoverned(deps: SessionDeps, rawSql: string): Promise<BasinQueryResult> {
  const check = sanitizeSql(rawSql);
  if (!check.ok) throw new Error(check.error);
  const analysis = analysisText(check.query);
  const kind = statementKind(analysis);
  const subject = kind === "explain" ? explainSubject(analysis) : analysis;
  const subjectKind = statementKind(subject);

  const scoped = staticScopeCheck(subject, deps.scope);
  if (!scoped.ok) throw new Error(scoped.reason);

  // Metadata statements never reach a plan; data statements on narrow bindings do.
  const metadataStatement = subjectKind === "show" || subjectKind === "describe";
  const planCheckNeeded = deps.scope.kind !== "bucket" && !metadataStatement;
  // Only executed data statements bill a scan; EXPLAIN/SHOW/DESCRIBE are
  // metadata-only and free, so they reserve nothing.
  const billed = kind !== "explain" && subjectKind === "data";

  if (planCheckNeeded && kind !== "explain" && subjectKind === "data") {
    // Free, engine-resolved scope verification before any billed scan.
    const pre = await deps.client.runQuery(`EXPLAIN ${check.query}`, { timeoutMs: 15_000 });
    const plan = checkExplainPlan(explainPlanText(pre), deps.scope);
    if (!plan.ok) throw new Error(plan.reason);
  }

  await deps.budget.assertAndReserve(billed ? deps.config.reserveBytes : 0);

  let result: BasinQueryResponse;
  try {
    if (kind === "explain") {
      result = await deps.client.runQuery(check.query, { timeoutMs: 15_000 });
    } else {
      result = await deps.client.runQuery(check.query, { timeoutMs: deps.config.timeoutMs });
    }
  } catch (e) {
    // A failed billed query still crossed the engine boundary, and engine error
    // text can carry warehouse-derived content. Observe the failure (arming the
    // workspace's restricted mode) before releasing the error to the caller;
    // a blocked observation propagates and the error does not cross (audit
    // run 1, finding 4).
    if (e instanceof BasinSqlError && billed) {
      await deps.approvalQueue.authorizeObservation({
        title: "Basin query failed",
        description:
          `A governed query over ${scopeLabel(deps.scope)} failed at the engine ` +
          `(error code ${e.code ?? "unknown"}); engine error text may contain warehouse-derived content.`,
        containsRestrictedData: true,
      });
    }
    throw e;
  }
  if (kind === "explain" && planCheckNeeded) {
    const plan = checkExplainPlan(explainPlanText(result), deps.scope, { metadataStatement });
    if (!plan.ok) throw new Error(plan.reason);
  }

  // Settle the reservation: record the difference between actual and reserved
  // bytes. record ignores non-positive deltas, so a query that scanned less
  // than its reservation keeps the reservation (the gatekeeper-x bound).
  await deps.budget.record(
    result.metrics.bytesScanned - (billed ? deps.config.reserveBytes : 0),
  );

  const pageSize = deps.config.maxRows;
  const serverCapped = result.totalRows >= maxRowLimit;
  const truncated = result.totalRows > pageSize || serverCapped;
  const page = result.rows.slice(0, pageSize);
  const rest = result.rows.slice(pageSize);
  const more =
    rest.length > 0
      ? new BasinRowsCursorImpl(
          {
            approvalQueue: deps.approvalQueue,
            bucket: deps.bucket,
            requestId: result.requestId,
            pageSize,
          },
          rest,
        )
      : null;

  await deps.approvalQueue.authorizeObservation({
    title: "Query the Basin warehouse",
    description:
      `Read-only SQL query over ${scopeLabel(deps.scope)} in Basin bucket ${deps.bucket}. ` +
      `${result.rows.length} rows returned; ` +
      `${(result.metrics.bytesScanned / (1024 * 1024)).toFixed(1)} MB scanned.`,
    fields: [sqlField(rawSql)].filter((f): f is NonNullable<typeof f> => f !== undefined),
    containsRestrictedData: true,
  });

  return {
    schema: result.schema,
    rows: page,
    metrics: result.metrics,
    truncated,
    more,
    requestId: result.requestId,
  };
}

/** Narrow a binding scope to a namespace or table inside it; refuse anything else. */
function narrowToNamespace(scope: BasinScope, namespace: string): BasinScope {
  if (scope.kind === "bucket") return { kind: "namespace", namespace };
  if (scope.kind === "namespace") {
    if (scope.namespace !== namespace)
      throw new Error(`This binding is scoped to namespace ${scope.namespace}.`);
    return scope;
  }
  throw new Error("A table binding cannot be narrowed to a namespace.");
}

function narrowToTable(scope: BasinScope, namespace: string, table: string): BasinScope {
  if (scope.kind === "bucket") return { kind: "table", namespace, table };
  if (scope.kind === "namespace") {
    if (scope.namespace !== namespace)
      throw new Error(`This binding is scoped to namespace ${scope.namespace}.`);
    return { kind: "table", namespace, table };
  }
  if (scope.namespace !== namespace || scope.table !== table)
    throw new Error(`This binding is scoped to table ${scope.namespace}.${scope.table}.`);
  return scope;
}

async function buildCatalog(deps: SessionDeps): Promise<BasinCatalog> {
  const discovered = await discoverForScope(deps.client, deps.scope, deps.cache);
  const namespaces: BasinNamespaceInfo[] = [];
  const tables: BasinTableInfo[] = [];
  let described = 0;
  for (const ns of discovered.namespaces) {
    namespaces.push({ namespace: ns.namespace, tables: ns.tables });
    for (const table of ns.tables) {
      // Defense in depth: discovery already filters out-of-grammar names, but
      // the describe loop must never reject the whole catalog over one name.
      if (!isIdentifier(ns.namespace) || !isIdentifier(table)) continue;
      if (described >= deps.config.describeCap) continue;
      described++;
      const columns = await describeTableCached(deps.client, deps.cache, ns.namespace, table);
      tables.push({
        namespace: ns.namespace,
        table,
        columns,
        ingestColumns: ingestColumnsPresent(columns),
        notes: [],
      });
    }
  }
  return {
    bucket: deps.bucket,
    namespaces,
    tables,
    describeLimit: deps.config.describeCap,
    totalTables: namespaces.reduce((sum, ns) => sum + ns.tables.length, 0),
    platformNotes: PLATFORM_NOTES,
    deploymentNotes: deps.config.notes,
  };
}

async function observeCatalog(deps: SessionDeps, catalog: BasinCatalog): Promise<void> {
  await deps.approvalQueue.authorizeObservation({
    title: "Read the warehouse catalog",
    description:
      `Read the schema of ${scopeLabel(deps.scope)} in Basin bucket ${deps.bucket}: ` +
      `${catalog.namespaces.length} namespace(s), ${catalog.totalTables} table(s).`,
    containsRestrictedData: true,
  });
}

@validateRpc()
class BasinTableImpl extends RpcTarget implements BasinTable {
  readonly #deps: SessionDeps;
  readonly #namespace: string;
  readonly #table: string;
  #queue: ObservationQueue;

  constructor(deps: SessionDeps, namespace: string, table: string) {
    super();
    this.#deps = deps;
    this.#namespace = namespace;
    this.#table = table;
    this.#queue = deps.approvalQueue;
  }

  async describe(): Promise<BasinTableInfo> {
    const columns = await describeTableCached(
      this.#deps.client,
      this.#deps.cache,
      this.#namespace,
      this.#table,
    );
    await this.#queue.authorizeObservation({
      title: "Read a Basin table's schema",
      description:
        `Read the column schema of Basin table ${this.#namespace}.${this.#table} ` +
        `in bucket ${this.#deps.bucket} (${columns.length} columns).`,
      containsRestrictedData: true,
    });
    return {
      namespace: this.#namespace,
      table: this.#table,
      columns,
      ingestColumns: ingestColumnsPresent(columns),
      notes: [],
    };
  }

  query(sql: string): Promise<BasinQueryResult> {
    const scope = narrowToTable(this.#deps.scope, this.#namespace, this.#table);
    return runGoverned({ ...this.#deps, scope }, sql);
  }

  async getFreshness(): Promise<BasinFreshness> {
    const columns = await describeTableCached(
      this.#deps.client,
      this.#deps.cache,
      this.#namespace,
      this.#table,
    );
    const hasIngest = ingestColumnsPresent(columns).includes("__ingest_ts");
    if (!hasIngest) {
      await this.#queue.authorizeObservation({
        title: "Probe a Basin table's ingest freshness",
        description:
          `Probed ingest freshness of ${this.#namespace}.${this.#table}: the table carries no ` +
          `__ingest_ts column, so freshness is unknown.`,
        containsRestrictedData: true,
      });
      return { latestIngestTs: null, rowsInLastDay: 0, completeness: "unknown" };
    }
    const result = await runGoverned(
      { ...this.#deps, scope: narrowToTable(this.#deps.scope, this.#namespace, this.#table) },
      `SELECT MAX(__ingest_ts) AS m, COUNT(*) AS c FROM ${this.#namespace}.${this.#table} ` +
        `WHERE __ingest_ts >= now() - INTERVAL '1 day' LIMIT 1`,
    );
    const row = result.rows[0] ?? {};
    const latest = row["m"];
    return {
      latestIngestTs: typeof latest === "string" ? latest : null,
      rowsInLastDay: result.rows.length > 0 ? Number(row["c"] ?? 0) : 0,
      completeness: "verified",
    };
  }

  [Symbol.dispose](): void {
    // The session that created this stub owns the queue's disposal.
  }
}

@validateRpc()
class BasinNamespaceImpl extends RpcTarget implements BasinNamespace {
  readonly #deps: SessionDeps;
  readonly #namespace: string;
  #queue: ObservationQueue;

  constructor(deps: SessionDeps, namespace: string) {
    super();
    this.#deps = deps;
    this.#namespace = namespace;
    this.#queue = deps.approvalQueue;
  }

  async describe(): Promise<BasinNamespaceInfo> {
    const discovered = await discoverForScope(
      this.#deps.client,
      narrowToNamespace(this.#deps.scope, this.#namespace),
      this.#deps.cache,
    );
    const own = discovered.namespaces.find((ns) => ns.namespace === this.#namespace);
    await this.#queue.authorizeObservation({
      title: "Read a Basin namespace's table list",
      description:
        `Read the table list of Basin namespace ${this.#namespace} in bucket ` +
        `${this.#deps.bucket} (${own?.tables.length ?? 0} tables).`,
      containsRestrictedData: true,
    });
    return { namespace: this.#namespace, tables: own?.tables ?? [] };
  }

  getTable(table: string): Promise<BasinTable> {
    return Promise.resolve(
      new BasinTableImpl(this.#deps, this.#namespace, identifier(table)),
    );
  }

  query(sql: string): Promise<BasinQueryResult> {
    const scope = narrowToNamespace(this.#deps.scope, this.#namespace);
    return runGoverned({ ...this.#deps, scope }, sql);
  }

  [Symbol.dispose](): void {
    // The session that created this stub owns the queue's disposal.
  }
}

@validateRpc()
class BasinSessionImpl extends RpcTarget implements BasinSession {
  readonly #deps: SessionDeps;

  constructor(deps: SessionDeps) {
    super();
    this.#deps = deps;
  }

  async getCatalog(): Promise<BasinCatalog> {
    const catalog = await buildCatalog(this.#deps);
    await observeCatalog(this.#deps, catalog);
    return catalog;
  }

  async getNamespace(namespace: string): Promise<BasinNamespace> {
    const ns = identifier(namespace);
    narrowToNamespace(this.#deps.scope, ns);
    return new BasinNamespaceImpl(this.#deps, ns);
  }

  async getTable(namespace: string, table: string): Promise<BasinTable> {
    const ns = identifier(namespace);
    const t = identifier(table);
    narrowToTable(this.#deps.scope, ns, t);
    return new BasinTableImpl(this.#deps, ns, t);
  }

  query(sql: string): Promise<BasinQueryResult> {
    return runGoverned(this.#deps, sql);
  }

  async getBudget(): Promise<BasinBudget> {
    const snapshot = await this.#deps.budget.snapshot();
    await this.#deps.approvalQueue.authorizeObservation({
      title: "Read the Basin scan budget",
      description:
        `Read this binding's remaining daily Basin scan budget: ` +
        `${(snapshot.capBytes / (1024 * 1024)).toFixed(0)} MB cap, ` +
        `${(snapshot.usedBytes / (1024 * 1024)).toFixed(1)} MB used.`,
    });
    return snapshot;
  }

  [Symbol.dispose](): void {
    this.#deps.approvalQueue[Symbol.dispose]?.();
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper DO (one facet per binding)
// ---------------------------------------------------------------------------

export interface BasinGatekeeperProps {
  /** "deployment" for the auto-provisioned ambient singleton; "user" for a connected account. */
  mode: "user" | "deployment";
  /** UserAccount DO id, user mode only. */
  userObjectId?: string;
  scope: BasinScope;
  /**
   * The provisioning user's verified email, deployment mode with per-user scopes: the
   * identity BASIN_USER_SCOPES was resolved against. Carried for audit and session
   * context, never re-resolved (the resolved scope is authoritative).
   */
  ownerEmail?: string;
}

@validateRpc()
export class BasinGatekeeper
  extends DurableObject<Cloudflare.Env, BasinGatekeeperProps>
  implements Gatekeeper<BasinSession>
{
  async #credentials(): Promise<BasinCredentials> {
    if (this.ctx.props.mode === "deployment") {
      const token = this.env.BASIN_SQL_TOKEN;
      const accountId = this.env.BASIN_ACCOUNT_ID;
      const bucket = this.env.BASIN_BUCKET;
      if (!token || !accountId || !bucket) {
        throw new Error(
          "The Basin gatekeeper is not configured: BASIN_SQL_TOKEN, BASIN_ACCOUNT_ID and " +
            "BASIN_BUCKET must be set on its Worker.",
        );
      }
      return { accountId, bucket, token };
    }
    const userObjectId = this.ctx.props.userObjectId;
    if (!userObjectId) throw new Error("Basin binding is missing its account reference.");
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(userObjectId),
    );
    return await account.getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    const creds = await this.#credentials();
    const { scope } = this.ctx.props;
    if (scope.kind === "bucket") {
      return {
        url: basinResourceUrl(creds, scope),
        title: `Basin warehouse ${creds.bucket}`,
        snippet: "Query every table in this Cloudflare Basin warehouse.",
        suggestedBindingName: "BASIN",
        tsType: "BasinSession",
      };
    }
    if (scope.kind === "namespace") {
      return {
        url: basinResourceUrl(creds, scope),
        title: `Basin namespace ${scope.namespace}`,
        snippet: `Query the tables of namespace ${scope.namespace} in ${creds.bucket}.`,
        suggestedBindingName: "BASIN_NAMESPACE",
        tsType: "BasinNamespace",
      };
    }
    return {
      url: basinResourceUrl(creds, scope),
      title: `Basin table ${scope.namespace}.${scope.table}`,
      snippet: `Query table ${scope.namespace}.${scope.table} in ${creds.bucket}.`,
      suggestedBindingName: "BASIN_TABLE",
      tsType: "BasinTable",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<BasinSession> {
    const creds = await this.#credentials();
    const config = readConfig(this.env);
    return new BasinSessionImpl({
      scope: this.ctx.props.scope,
      bucket: creds.bucket,
      client: createBasinSqlClient(creds),
      budget: new Budget(kvBudgetStore(this.ctx.storage.kv), config.scanCapBytes),
      config,
      cache: new CatalogCache(this.ctx.storage.kv, config.catalogTtlMs),
      approvalQueue: approvalQueue.dup(),
    });
  }

  /** Discovery index served into every chat's system prompt: no observation, no secrets. */
  async getAgentCatalog(): Promise<AgentCatalog> {
    const { scope } = this.ctx.props;
    let entries: { id: string; title: string; description: string }[];
    if (scope.kind === "table") {
      entries = [
        {
          id: `${scope.namespace}.${scope.table}`,
          title: `${scope.namespace}.${scope.table}`,
          description: "One Basin table; call describe() for its columns.",
        },
      ];
      return boundAgentCatalog(entries);
    }
    try {
      const creds = await this.#credentials();
      const cache = new CatalogCache(this.ctx.storage.kv, readConfig(this.env).catalogTtlMs);
      const discovered = await discoverForScope(createBasinSqlClient(creds), scope, cache);
      entries = discovered.namespaces.map((ns) => ({
        id: ns.namespace,
        title: ns.namespace,
        description: `Basin namespace with ${ns.tables.length} table(s); getCatalog() lists them.`,
      }));
    } catch (e) {
      logger.warn("agent catalog discovery failed", { event: "basin.catalog.discovery.failed", error: e });
      return { entries: [] };
    }
    return boundAgentCatalog(entries);
  }

  /** Observer strategy A (private-only): warehouse data must never be shared. */
  addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "Basin warehouse data is private to its owner; gadgets that read it cannot be shared.",
    );
  }

  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("The Basin gatekeeper is read-only and implements no actions.");
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error("The Basin gatekeeper is read-only and implements no actions.");
  }

  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The Basin gatekeeper is read-only and implements no actions.");
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO: the per-user connect flow and credential storage
// ---------------------------------------------------------------------------

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;

function generateNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(NONCE_BYTES))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

interface StoredCredentials extends BasinCredentials {}

interface StoredNonce {
  value: string;
  expiresAt: number;
  reconnect?: true;
  connecting?: true;
}

type CompleteConnectionResult =
  | { kind: "ok"; handoff: { targetOrigin: string; ticket: string } }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

function validateAccountShape(accountId: string): string | null {
  if (!/^[\w-]{6,64}$/.test(accountId)) return "The account ID is not a Cloudflare account ID.";
  return null;
}

function validateBucketShape(bucket: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket) || bucket.endsWith("-"))
    return "The bucket name is not a valid R2 bucket name (lowercase letters, digits, hyphens).";
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function connectFormHtml(opts: { actionUrl: string; error?: string }): string {
  const error = opts.error
    ? `<p style="color:#b91c1c;">${escapeHtml(opts.error)}</p>`
    : `<p>Enter the Cloudflare account ID, the Basin bucket, and an R2 API token
       (R2 Storage Admin Read &amp; Write is what Basin SQL requires today).</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Connect Cloudflare Basin</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 32rem;">
  <h2>Connect a Basin warehouse</h2>
  ${error}
  <form method="post" action="${escapeHtml(opts.actionUrl)}">
    <p><label>Account ID<br>
      <input type="text" name="accountId" required placeholder="your 32-hex account ID, e.g. 023e105f4ecef8ad9ca31a8372d0c353"
        style="width:100%; padding:.4rem;"></label></p>
    <p><label>Bucket (Basin catalog)<br>
      <input type="text" name="bucket" required placeholder="e.g. basin-demo"
        style="width:100%; padding:.4rem;"></label></p>
    <p><label>R2 API token<br>
      <input type="password" name="token" required autocomplete="off"
        style="width:100%; padding:.4rem;"></label></p>
    <p><button type="submit">Connect</button></p>
  </form>
</body>
</html>`;
}

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Authorization Link Expired</h2>
  <p>This connection link is invalid or has expired. Please return to Cloudflare OS and start over.</p>
</body>
</html>`;

const MAX_CONNECT_FORM_BYTES = 16 * 1024;

@validateRpc()
export class UserAccount extends DurableObject<Cloudflare.Env> {
  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>,
    nonce: string,
  ): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    clearCredentialExpiryLatch(this.ctx.storage.kv);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
      reconnect: true,
    });
  }

  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt) return false;
    return constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(
    nonce: string,
    accountId: string,
    bucket: string,
    token: string,
  ): Promise<CompleteConnectionResult> {
    const shapeError =
      validateAccountShape(accountId) ?? validateBucketShape(bucket) ?? (token ? null : "The token is required.");
    if (shapeError) return { kind: "error", message: shapeError };

    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (
      !stored ||
      stored.connecting ||
      Date.now() >= stored.expiresAt ||
      !constantTimeEqual(stored.value, nonce)
    ) {
      return { kind: "invalid_nonce" };
    }
    // Claim the nonce before the first await: the DO's input gate does not cover the
    // outbound validation probe, so a concurrent submission must not pass twice.
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: true });

    // Validate that account + bucket + token can actually query the warehouse.
    const creds: BasinCredentials = { accountId, bucket, token };
    try {
      await createBasinSqlClient(creds).runQuery("SHOW DATABASES", { timeoutMs: 15_000 });
    } catch (e) {
      this.#releaseNonceClaim(nonce);
      const msg = e instanceof BasinSqlError ? e.message : `Unable to reach Basin SQL: ${String(e)}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that validation passed.
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      return { kind: "error", message: "Connection callback expired. Please restart." };
    }

    let handoff: { targetOrigin: string; ticket: string };
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability: new credentials stay staged until the
      // Workshop confirms the completing browser is the owner's (commitReconnect).
      const stageId = stageCredentials<StoredCredentials>(this.ctx.storage.kv, creds, Date.now());
      try {
        handoff = await callback.reconnectComplete(stageId);
      } catch (e) {
        return { kind: "error", message: `Failed to notify the Workshop: ${String(e)}` };
      }
    } else {
      this.ctx.storage.kv.put<StoredCredentials>("credentials", creds);
      clearCredentialExpiryLatch(this.ctx.storage.kv);
      try {
        const props: BasinUserProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.BasinAccount({ props }));
      } catch (e) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify the Workshop: ${String(e)}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok", handoff };
  }

  #releaseNonceClaim(nonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || !stored.connecting || !constantTimeEqual(stored.value, nonce)) return;
    const { connecting: _, ...released } = stored;
    this.ctx.storage.kv.put<StoredNonce>("nonce", released);
  }

  async commitReconnect(stageId: string): Promise<void> {
    const creds = commitStagedCredentials<StoredCredentials>(this.ctx.storage.kv, Date.now(), stageId);
    if (!creds) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.ctx.storage.kv.put<StoredCredentials>("credentials", creds);
    clearCredentialExpiryLatch(this.ctx.storage.kv);
  }

  getCredentials(): StoredCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) {
      throw new Error("Basin credentials are not configured for this account.");
    }
    return creds;
  }

  async noteCredentialsExpired(): Promise<void> {
    await notifyCredentialsExpiredOnce(
      this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"),
      VENDOR_ID,
    );
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// Per-user account (GatekeeperUser)
// ---------------------------------------------------------------------------

type BasinUserProps = { userObjectId: string };

@validateRpc()
export class BasinAccount
  extends WorkerEntrypoint<Cloudflare.Env, BasinUserProps>
  implements GatekeeperUser
{
  #userAccount() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
  }

  async #creds(): Promise<BasinCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    const creds = await this.#creds();
    return {
      displayName: `Basin ${creds.bucket}`,
      uniqueName: `basin:${creds.bucket}`,
      avatar: BASIN_ICON,
      grantedResourceUrlPatterns: SUPPORTED_RESOURCES.map((r) => r.urlPattern),
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const { scope, accountId, bucket } = parseBasinResourceUrl(url);
    const creds = await this.#creds();
    if (creds.accountId !== accountId || creds.bucket !== bucket) {
      throw new Error(
        `That basin:// URL names a different warehouse than this account's (${creds.bucket}).`,
      );
    }
    const props: BasinGatekeeperProps = {
      mode: "user",
      userObjectId: this.ctx.props.userObjectId,
      scope,
    };
    const klass = this.ctx.exports.BasinGatekeeper({ props });
    return {
      class: klass,
      resource:
        scope.kind === "table"
          ? TABLE_RESOURCE
          : scope.kind === "namespace"
            ? NAMESPACE_RESOURCE
            : BUCKET_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const creds = await this.#creds();
    const ui = new NativeRpcStub(new BasinConfiguratorRpcImpl(creds));
    switch (resourceUrlPattern) {
      case TABLE_RESOURCE.urlPattern:
        return { iframeHtml: TABLE_CONFIGURATOR_HTML, ui };
      case NAMESPACE_RESOURCE.urlPattern:
        return { iframeHtml: NAMESPACE_CONFIGURATOR_HTML, ui };
      case BUCKET_RESOURCE.urlPattern:
        return { iframeHtml: BUCKET_CONFIGURATOR_HTML, ui };
      default:
        throw new Error(`Unknown Basin resource type: ${resourceUrlPattern}`);
    }
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    assertBaseUrlConfigured(this.env);
    const nonce = generateNonce();
    await this.#userAccount().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // A static R2 token cannot be scoped further; every grantable type already works.
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.BasinVerifier({});
  }
}

/** The iframe-facing capability for the three resource configurators. */
@validateRpc()
class BasinConfiguratorRpcImpl extends RpcTarget {
  readonly #creds: BasinCredentials;

  constructor(creds: BasinCredentials) {
    super();
    this.#creds = creds;
  }

  async resourceUrl(namespace?: string, table?: string): Promise<string> {
    const scope: BasinScope =
      namespace === undefined || table === undefined
        ? namespace === undefined
          ? { kind: "bucket" }
          : { kind: "namespace", namespace: identifier(namespace) }
        : { kind: "table", namespace: identifier(namespace), table: identifier(table) };
    return basinResourceUrl(this.#creds, scope);
  }

  async listNamespaces(query: string): Promise<{ value: string; title: string; subtitle?: string }[]> {
    const client = createBasinSqlClient(this.#creds);
    const namespaces = await discoverNamespaces(client);
    const lower = query.toLowerCase();
    return namespaces
      .filter((ns) => ns.toLowerCase().includes(lower))
      .slice(0, 50)
      .map((ns) => ({ value: ns, title: ns }));
  }

  async listTables(
    namespace: string,
    query: string,
  ): Promise<{ value: string; title: string; subtitle?: string }[]> {
    const client = createBasinSqlClient(this.#creds);
    const tables = await discoverTables(client, identifier(namespace));
    const lower = query.toLowerCase();
    return tables
      .filter((t) => t.toLowerCase().includes(lower))
      .slice(0, 50)
      .map((t) => ({ value: t, title: t }));
  }
}

// ---------------------------------------------------------------------------
// Owner record (per-user identity for auto-provisioned accounts)
// ---------------------------------------------------------------------------

/**
 * Stores the provisioning user's verified email for one auto-provisioned account, so
 * the account can resolve per-user scopes even though WorkerEntrypoints carry no
 * durable state of their own. Keyed deterministically from the account's id; the
 * record is write-once (an attempt to change a recorded owner is refused), because
 * whoever could rewrite the owner could rewrite the scope it resolves to.
 */
@validateRpc()
export class BasinOwnerRecord extends DurableObject<Cloudflare.Env> {
  async put(email: string): Promise<void> {
    const existing = this.ctx.storage.kv.get<string>("ownerEmail");
    if (existing !== undefined && existing !== email) {
      throw new Error("This account's provisioning owner is already recorded and cannot be changed.");
    }
    this.ctx.storage.kv.put("ownerEmail", email);
  }

  async get(): Promise<string | null> {
    return this.ctx.storage.kv.get<string>("ownerEmail") ?? null;
  }
}

/** Deterministic DO id for one account's owner record: sha256("basin-owner:<accountId>"). */
async function ownerRecordId(namespace: DurableObjectNamespace, accountId: string): Promise<DurableObjectId> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`basin-owner:${accountId}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return namespace.idFromString(hex);
}

// ---------------------------------------------------------------------------
// Auto-provision account (deployment mode)
// ---------------------------------------------------------------------------

/** Marks this vendor as one whose accounts accept the provisioning owner's identity. */
export type OwnerReceivingAccountDescription = AccountDescription & {
  receivesProvisionedOwner: true;
};

@validateRpc()
export class BasinAutoAccount
  extends WorkerEntrypoint<Cloudflare.Env, { accountId: string }>
  implements GatekeeperUser
{
  async describe(): Promise<OwnerReceivingAccountDescription> {
    return {
      displayName: "Cloudflare Basin",
      avatar: BASIN_ICON,
      singleton: { tsType: "BasinSession" },
      // Consumed by a Workshop that supports per-user provisioning identity (see
      // patches/workshop-note-provisioned-owner.patch and the upstream proposal in
      // docs/upstream-issue-per-user-scoping.md); ignored by an unpatched Workshop.
      receivesProvisionedOwner: true,
    };
  }

  #ownerRecord(): Promise<DurableObjectStub<BasinOwnerRecord>> {
    return ownerRecordId(this.ctx.exports.BasinOwnerRecord, this.ctx.props.accountId)
      .then((id) => this.ctx.exports.BasinOwnerRecord.get(id));
  }

  /**
   * Records the provisioning user's verified email. Called by the Workshop at
   * auto-provisioning time (the gatekeeper cannot learn it otherwise: the platform
   * passes no user identity to auto-provisioned accounts). Write-once: a recorded
   * owner can only be re-noted with the same email.
   */
  async noteProvisionedOwner(owner: { email: string }): Promise<void> {
    const email = owner.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new Error("The provisioning owner must be an email address.");
    }
    await (await this.#ownerRecord()).put(email);
  }

  /**
   * Resolve this user's ambient scope. With BASIN_USER_SCOPES set, the per-user map
   * decides (fail-closed for unmapped users without a default); without it, the
   * deployment-wide BASIN_SCOPE applies to everyone, as before.
   */
  async #resolveScope(): Promise<{ scope: BasinScope; ownerEmail: string | null }> {
    if (!this.env.BASIN_USER_SCOPES) {
      return { scope: parseDeploymentScope(this.env.BASIN_SCOPE), ownerEmail: null };
    }
    const parsed = parseUserScopeMap(this.env.BASIN_USER_SCOPES);
    if (!parsed.ok) throw new Error(parsed.error);
    const ownerEmail = await (await this.#ownerRecord()).get();
    if (!ownerEmail) {
      throw new Error(
        "BASIN_USER_SCOPES is set but this account's provisioning owner is unknown " +
          "(the account predates the owner-identity patch, or the Workshop does not " +
          "support it). Re-provision the account: disable and re-enable the Basin " +
          "connector, or revoke the account, so the Workshop records the owner. " +
          "Failing closed rather than granting the deployment-wide scope.",
      );
    }
    const resolved = resolveUserScope(ownerEmail, parsed.map);
    if (!resolved.ok) throw new Error(resolved.error);
    logger.info("resolved per-user Basin scope", {
      event: "basin.scope.user.resolved",
      matched: resolved.matched,
    });
    return { scope: resolved.scope, ownerEmail };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<any>>> {
    if (!this.env.BASIN_SQL_TOKEN) {
      throw new Error("The Basin gatekeeper is not configured for auto-provisioning.");
    }
    const { scope, ownerEmail } = await this.#resolveScope();
    return this.ctx.exports.BasinGatekeeper({
      props: { mode: "deployment", scope, ...(ownerEmail ? { ownerEmail } : {}) },
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The deployment's Basin account is ambient; it has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The deployment's Basin account is ambient; it has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {
    // Nothing to revoke: the credential belongs to the deployment's env, not this account.
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("The deployment's Basin account has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("The deployment's Basin account has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.BasinVerifier({});
  }
}

@validateRpc()
export class BasinVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------

function getBaseUrl(env: Cloudflare.Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/basin");
}

/**
 * Refuse to mint bearer connect URLs against the localhost default (audit run 1,
 * finding 10): the release manifest and the platform's dev-server both set
 * BASE_URL, so an unset value means an out-of-pipeline deploy whose connect
 * links would silently point at the user's own loopback. A clear operator error
 * beats silent breakage.
 */
function assertBaseUrlConfigured(env: Cloudflare.Env): void {
  if (!env.BASE_URL) {
    throw new Error(
      "BASE_URL is not configured on this gatekeeper: connect URLs would be minted " +
        "against localhost. Set BASE_URL to the deployment's public gatekeeper path " +
        "(e.g. https://<host>/gatekeeper/basin).",
    );
  }
}

function getBasePath(env: Cloudflare.Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare Basin",
      url: "https://developers.cloudflare.com/basin/",
      logo: BASIN_ICON,
      color: "#e8f2ff",
      tagline: "Query your Basin data lake with governed, scope-checked SQL",
      description:
        "Connect a Cloudflare Basin warehouse (Apache Iceberg tables on R2) so Cloudflare OS can " +
        "run read-only, budgeted SQL over your logs and event archives, discover its schema, and " +
        "narrow grants to one namespace or table. Every query is audited and scope-checked.",
      autoProvisionsAccount: this.env.BASIN_SQL_TOKEN !== undefined,
      providesAuth: false,
    };
  }

  async versionTag(): Promise<string | undefined> {
    return workerVersionTag(this.env);
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    if (!this.env.BASIN_SQL_TOKEN) {
      throw new Error("This deployment has no shared Basin credential; connect your own account instead.");
    }
    return this.ctx.exports.BasinAutoAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    if (this.env.BASIN_SQL_TOKEN !== undefined) {
      throw new Error(
        "This deployment auto-provisions a shared Basin account; individual connections are disabled.",
      );
    }
    assertBaseUrlConfigured(this.env);
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    if (this.env.BASIN_SQL_TOKEN !== undefined) {
      // Ambient-only: the singleton carries the deployment's configured scope.
      return [];
    }
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// HTTP handler: the per-user connect form (auto-provision mode serves 404s)
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(connectFormHtml({ actionUrl: req.url }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        let formData: URLSearchParams;
        try {
          formData = new URLSearchParams(await readTextCapped(req, MAX_CONNECT_FORM_BYTES));
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const accountId = String(formData.get("accountId") ?? "").trim();
        const bucket = String(formData.get("bucket") ?? "").trim().toLowerCase();
        const token = String(formData.get("token") ?? "").trim();
        if (!accountId || !bucket || !token) {
          return new Response(
            connectFormHtml({
              actionUrl: req.url,
              error: "Account ID, bucket, and token are all required.",
            }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        const result = await stub.completeConnection(nonce, accountId, bucket, token);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (result.kind === "error") {
          return new Response(connectFormHtml({ actionUrl: req.url, error: result.message }), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
            status: 400,
          });
        }
        return htmlResponse(connectHandoffPageHtml(result.handoff));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
