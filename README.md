# Cloudflare Basin Gatekeeper

A [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) gatekeeper for querying a
[Cloudflare Basin](https://developers.cloudflare.com/basin/) warehouse: Apache Iceberg
tables in R2, read through [Basin SQL](https://developers.cloudflare.com/basin-sql/)
with governed, scope-checked, budgeted, audited, read-only access.

Cloudflare OS agents get a typed session API over the warehouse: schema discovery with
the platform knowledge needed to query it correctly, arbitrary read-only SQL narrowed to
whatever the user granted (whole bucket, one namespace, or one table), paged results,
error messages that teach the agent how to fix its query, and a daily scan budget so a
runaway agent cannot quietly bill the account.

## Why this exists

Basin is the storage layer of the Cloudflare data platform, and nothing shipped with
Cloudflare OS can query it: the Cloudflare API covers Basin Catalog *administration*
(namespaces, tables, maintenance) but the query engine is a separate service that no
shipped gatekeeper talks to. This gatekeeper fills that gap, and demonstrates the
governance pattern a data lake behind an agent needs: the credential never leaves the
gatekeeper, every grant is enforced in front of the engine, and every read is audited.

## What agents get

```ts
const catalog = await BASIN.getCatalog();          // namespaces, tables, columns, notes
const result = await BASIN.query(sql);             // governed SQL over the grant
const next = await result.more?.next();            // page large results
const table = await BASIN.getTable("homelab", "dns_queries");
await table.describe();                            // columns + ingest columns
await table.getFreshness();                        // ingest lag (a billed probe)
await BASIN.getBudget();                           // remaining daily scan budget
```

Grants are grouped on one connect card: the whole warehouse, a namespace, or a single
table. A table grant cannot be talked into reading a sibling table: every query through
a narrow binding is verified against the engine's own resolved query plan before it
runs, and metadata statements (SHOW, DESCRIBE) are scope-checked the same way.

The catalog ships the live-verified platform notes that make the difference between an
agent that queries Basin correctly and one that flails: how JSON columns are
double-encoded, the JSON function size cap and its regexp_replace fallback, the
per-query manifest limit, sink-added columns such as `__ingest_ts`, and at-least-once
ingest semantics.

## Security model

- **Read-only.** The gatekeeper implements no actions at all; there is nothing to
  approve, and write keywords never reach the engine. Basin SQL's own server-side
  read-only enforcement is the backstop (verify it at install; see below).
- **Lexical guardrails** (vendored from the audited basin-flowviz console path, MIT):
  single statement, `SELECT` / `SHOW` / `EXPLAIN` / `DESCRIBE` / `WITH` allowlist,
  write-keyword blocklist, strict `LIMIT` parsing, size and timeout caps.
  `EXPLAIN ANALYZE` is refused: it executes the query.
- **Binding scope, enforced by the engine.** Narrow bindings run a free `EXPLAIN`
  preflight and verify every table the resolved plan actually reads sits inside the
  grant. Delimited identifiers and `information_schema` are refused outright for
  narrow bindings; `SHOW` / `DESCRIBE` obey the same boundary.
- **Budget.** Each binding has a daily compressed-bytes-scanned cap (default 2048 MB,
  `BASIN_DAILY_SCAN_MB`), counted per binding per workspace in Durable Object storage.
  Billed queries **reserve** against the cap before they execute
  (`BASIN_RESERVE_MB`, default 10, the documented per-query minimum) and settle with
  the engine-reported actual afterwards; the reservation stands if the scan was
  smaller. This bounds the concurrent overshoot to the reservation, so a fan of
  parallel agent queries cannot spend past the cap unchecked. A query whose actual
  scan exceeds the whole remaining cap still executes once (no estimate can know
  the cost of a scan before running it) - the bound is on *concurrency*, not on a
  single first query.
- **Audit.** Every data crossing to the agent is an observation in the Workshop's
  approval log: the SQL, the scope, the row count, and the bytes scanned. Failed
  billed queries are observed too (marked restricted), because engine error text can
  carry warehouse-derived content; and the agent-facing error text itself is
  sanitized: provider messages never forward verbatim, only the mapped,
  value-free guidance (the raw text stays in Worker logs, which do not cross RPC).
- **Private by default.** Observations are marked `containsRestrictedData`, and the
  observer strategy is A (private-only): a gadget that reads warehouse data cannot be
  shared with anyone. Data cannot leak sideways into a shared workspace's actions or
  web fetches either.

**Documented residual risk:** error text can still confirm the existence of a named
object through *differentiated mapped codes* (one bit per guess), which upstream's own
observer guidance accepts for existence probing. The raw provider message no longer
crosses to agents at all; scope-rejected queries return a normalized reason, and
`basin://` URLs with empty path segments are refused outright (they are labelled
narrower by the Workshop's URL resolution than the gatekeeper could ever enforce).

## Setup

### Prerequisite: the token recipe

Basin SQL authenticates with an R2 API token. **Today, even read-only queries require
the R2 "Admin Read & Write" permission**, an open-beta limitation: that credential can
read every catalog in the account, which is exactly why it must live only in this
gatekeeper's Worker secret and never in a gadget. Create it from the **R2 API tokens
flow**, not the generic API-tokens builder: dashboard → Storage & Databases → R2 →
Overview → (Account Details) Manage API tokens → Create API token → permission
**Admin Read & Write**, then Create User API Token (or Account API token). Scoped to
the account that owns the warehouse bucket.

Do **not** use the generic builder at
[My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens): its
"Workers R2 Storage" Read/Write groups are S3-object-level permissions and leave
Basin SQL answering `80013 Unauthorized` (HTTP 403) on every query, including
`SELECT 1`. That is an authorization-layer rejection, not the enforcement the
probes below test for.

Before wiring the token anywhere, run the two mandatory probes against your warehouse:

```sh
TOKEN=<your-token> ACCOUNT=<account-id> BUCKET=<bucket>
curl -s "https://api.sql.cloudflarestorage.com/api/v1/accounts/$ACCOUNT/basin-sql/query/$BUCKET" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "COPY (SELECT 1) TO '\''x'\''"}'    # must be REJECTED
curl -s "https://api.sql.cloudflarestorage.com/api/v1/accounts/$ACCOUNT/basin-sql/query/$BUCKET" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "SELECT 1; SELECT 2"}'              # must be REJECTED
```

If either succeeds, your engine accepts writes or stacked statements: do not install
this token; report the result upstream and re-probe after the platform changes.

The passing shape, verified against a live warehouse (2026-10-26): each probe is
rejected with a **query-level** error (HTTP 400, code 40003) - `"invalid SQL:
only read-only queries are allowed"` and `"invalid SQL: expected a single SQL
statement, got 2 instead"`. If instead both probes return `80013 Unauthorized`
(HTTP 401/403), the token itself is not accepted for Basin SQL: wrong token
type or permissions (see above) - fix the token, then re-probe.

### Mode 1: per-user connect (default)

Each user connects their own warehouse: on the Connectors page they paste the account
ID, the bucket name, and an R2 API token on a form (the Home Assistant gatekeeper's
URL + token pattern: Basin has no OAuth provider). The token is stored in the user's
own Durable Object, validated live (`SHOW DATABASES`) before it is saved, never
logged, and never returned to any session method. Users then grant whole-bucket,
namespace, or table bindings to agents and gadgets.

### Mode 2: deployment auto-provision

Set these on the gatekeeper Worker and every OS user gets the warehouse as an ambient
`BASIN` binding (the Shared Tasks / Web Search pattern):

| Binding | Kind | Notes |
|---|---|---|
| `BASIN_SQL_TOKEN` | secret | the R2 API token; its presence selects this mode |
| `BASIN_ACCOUNT_ID` | plain var | the account that owns the bucket |
| `BASIN_BUCKET` | plain var | the warehouse bucket |
| `BASIN_SCOPE` | plain var | `bucket` (default), `namespace:<ns>`, or `table:<ns>/<table>` |

Install secrets with `wrangler secret put BASIN_SQL_TOKEN` against the deployed Worker.
Use a dedicated token (never reuse one that other systems hold) so its blast radius is
this gatekeeper alone. All users of the deployment share the underlying credential; the
observation log still attributes every query to the individual user, and each
workspace's budget counter is its own.

#### Per-user scoping (enterprise mode)

`BASIN_SCOPE` gives every user the same grant. An enterprise that needs per-table
governance on the shared credential instead sets `BASIN_USER_SCOPES` (JSON var):

```json
{
  "exact": { "ian@corp.example": "bucket" },
  "patterns": [
    { "pattern": "*@finance.example.com", "scope": "namespace:finance" },
    { "pattern": "*@corp.example", "scope": "namespace:public" }
  ],
  "default": "namespace:public"
}
```

Each user's ambient singleton is then minted with *their* scope: exact email matches
win (case-insensitive), then suffix patterns in order, then `default`. Unmatched users
with no `default` get no warehouse at all - a clear provisioning-time error rather than
a silent over-grant. The plan verifier enforces the resolved scope per user, per
query, with the same audit trail; this is the query-gateway governance pattern (the
Trino-plus-Ranger shape) running entirely inside the gatekeeper.

Two prerequisites:

- **Identity plumbing.** The platform does not pass user identity to auto-provisioned
  accounts (`createAccount()` is identity-blind by contract). Apply
  `patches/workshop-note-provisioned-owner.patch` to your `cloudflare-os` checkout
  (verified against commit `bd10b0e`): it makes the Workshop record the provisioning
  user's verified email on accounts that declare `receivesProvisionedOwner`. The patch
  is one small, additive hunk; the upstream-shaped proposal it demonstrates is drafted
  in `docs/upstream-issue-per-user-scoping.md`.
- **Account re-provisioning after enabling the map.** Accounts provisioned before the
  patch have no recorded owner; with `BASIN_USER_SCOPES` set those accounts fail closed
  at singleton mint with re-provisioning guidance (disable and re-enable the connector,
  or revoke the account).

With `BASIN_USER_SCOPES` unset, nothing changes: `BASIN_SCOPE` applies to everyone as
before.

### Tunables (both modes)

| Var | Default | Meaning |
|---|---|---|
| `BASE_URL` | unset | The gatekeeper's public path (e.g. `https://<host>/gatekeeper/basin`). Required for per-user connect: the release manifest sets it, and connect flows refuse to mint URLs against the localhost fallback |
| `BASIN_DAILY_SCAN_MB` | `2048` | per-binding daily scan budget |
| `BASIN_RESERVE_MB` | `10` | bytes reserved per billed query before execution (reserve-then-settle, bounding concurrent overshoot; a query that scans less keeps its reservation) |
| `BASIN_MAX_ROWS` | `500` | rows returned per page |
| `BASIN_QUERY_TIMEOUT_MS` | `30000` | query abort timeout |
| `BASIN_CATALOG_TTL_MS` | `3600000` | schema discovery cache TTL (per scope) |
| `BASIN_DESCRIBE_CAP` | `100` | tables with inline column detail in `getCatalog()` |
| `BASIN_NOTES` | unset | JSON array of strings: deployment notes appended to the catalog |
| `BASIN_USER_SCOPES` | unset | per-user scope map for the ambient singleton (see above); when set, unmapped users fail closed |

## Installation

This package is a Cloudflare OS gatekeeper; it builds inside a workspace that contains
a `cloudflare-os` checkout (it `link:`s to `@gadgets/workshop-shared`,
`@gadgets/gatekeeper-kit` and `@gadgets/configurator-ui`, which only exist there).
There is no third-party gatekeeper marketplace today, so installing means vendoring
the package into your deployment wrapper:

1. **Starter-wrapper deployments** (the supported route): copy `packages/gatekeeper-basin/`
   from this repository into the `packages/` directory of your
   [cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter) checkout,
   add the Worker to your deploy configuration and a
   `GATEKEEPER_BASIN` service binding (entrypoint `GatekeeperVendor`) on the Workshop
   and Router, and deploy in the gatekeeper tier, before the Workshop and Router.
2. **Upstream adoption**: the file layout and conventions match the upstream packages
   (`cloudflare.config.ts`, generated `wrangler.jsonc`, `deploy-inputs.json`, kit
   leaves, the vitest projects, `plans/` design record) so vendoring the package
   into `cloudflare-os` is a directory copy plus review.

No KV, R2, or D1 resources are required: all gatekeeper state lives in Durable Object
storage.

`deploy-inputs.json` is empty: the installable-gatekeeper default of OAuth
`CLIENT_ID`/`CLIENT_SECRET` inputs does not apply (Basin has no OAuth app), and the
auto-provision token is optional, so installs must not block on it.

## Development

The repository is a workspace in the [cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter)
shape: the package lives at `packages/gatekeeper-basin/` and `link:`s into a checkout
of upstream `cloudflare-os/` at the root.

```sh
bash scripts/dev-setup.sh          # clone upstream at the pinned commit, install, generate
pnpm test:run                     # pure-logic suites (Node)
pnpm types:check                   # tsc against the upstream contracts
cd packages/gatekeeper-basin && ../../node_modules/.bin/wrangler deploy --dry-run
```

Deploy with the package's `pnpm deploy` (which regenerates the configurator frames
uncached first); a plain `wrangler deploy` is not a supported path - it never
regenerates the frames, so it ships them stale (a tree missing frames fails the
bundle, which is at least loud).

The pinned commit and the compatibility note above update together, in one change.
CI (`.github/workflows/ci.yml`) vendors the package into that exact checkout, plus a
weekly drift leg against upstream `main` that type-checks, so upstream changes that
would break the package surface within a week.

**Verified against upstream commit `bd10b0e` (2026-10-25).**

### Test corpus

- `__tests__/guardrails.test.ts`: the audited bypass corpus for the lexical layer
  (comment and string awareness, statement smuggling, LIMIT form attacks).
- `__tests__/scope.test.ts`: the binding-scope corpus, including the cases that killed
  a pure-lexical scope checker in review: delimited identifiers, CTE shadowing,
  lateral and scalar subqueries, `information_schema`, metadata enumeration, and the
  engine-plan verifier over realistic DataFusion plan text.
- `__tests__/basin-sql.test.ts`: response validation and error mapping (40020, 401,
  403), no blind casts.
- `__tests__/budget.test.ts`: per-UTC-day counting, cap enforcement, rollover.
- `__tests__/catalog.test.ts`: discovery row shapes, identifier rules, notes channels.

A workerd suite for the DOs and sessions (fake provider, TestHooks harness) is the
next milestone; the pure-logic suites above cover the security-critical parsing and
policy layers.

## Known limitations

- The Basin SQL credential is account-wide today (open beta; see the token recipe).
  The binding scope check, not the token, is the table-level boundary.
- The exact column shapes of `SHOW DATABASES` / `SHOW TABLES` / `DESCRIBE` / `EXPLAIN`
  output are parsed defensively but have been verified against one live warehouse;
  if Basin changes them, discovery degrades loudly (errors surface to the agent) and
  the parsers in `src/catalog.ts` / `src/scope.ts` need one live session to adapt.
- `EXPLAIN` plan text drives the authoritative scope check. If Basin changes plan
  output such that no `TableScan` line appears, narrow-binding data queries are
  refused (fail closed) rather than guessed about.
- Table and namespace identifiers must be plain `[A-Za-z_][A-Za-z0-9_]*` names inside
  narrow bindings; anything quoted is refused.
- No write or management surface exists, by design: pipeline, stream, and catalog
  administration belongs to the Cloudflare API (and, in Cloudflare OS, to the
  Cloudflare gatekeeper), not to a data-access gatekeeper.

## License

Apache-2.0. The lexical guardrails in `src/guardrails.ts` are vendored from the
basin-flowviz project (MIT, (c) Ian Hogben) with its audit lineage documented in the
file header.
