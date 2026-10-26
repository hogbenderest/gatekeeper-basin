# Basin Gatekeeper Design Record

The design record for `gatekeeper-basin`, following the convention of
`plans/gitlab-gatekeeper.md` and `plans/gatekeeper-kit.md`. The README covers setup and
operation; this records why the design is the way it is.

## 1. Problem and positioning

Basin is the Cloudflare data platform's storage layer: Apache Iceberg tables in R2,
queried through Basin SQL, a serverless read-only engine on
`api.sql.cloudflarestorage.com`. Nothing shipped with Cloudflare OS can query it. The
Cloudflare API covers Basin Catalog *administration* only, and its MCP toolset likewise
(no query tools, verified against the live catalog 2026-10-26), because the query
endpoint is not part of `api.cloudflare.com`. This gatekeeper is the missing data-access
path, and doubles as a reference implementation of the query-gateway governance pattern
a data lake behind an agent needs: the credential never leaves the gatekeeper, grants
are enforced in front of the engine, and every read is audited.

## 2. Auth modes

Two modes, selected by configuration, mirroring the two trust models real deployments
have:

- **Per-user connect** (default). Basin SQL authenticates with a static R2 API token;
  there is no OAuth provider, so the connect flow is the Home Assistant gatekeeper's
  URL + token shape: a nonce-guarded form, connect-time live validation (`SHOW
  DATABASES`), credential storage in the user's own `UserAccount` Durable Object,
  staged (never live) reconnects through `gatekeeper-kit/credential-stage`. This is
  what makes the gatekeeper usable by any OS deployment, and what makes it a fit for
  multi-tenant companies: two users never see each other's warehouses because there
  is no shared credential to see through.
- **Deployment auto-provision** (`BASIN_SQL_TOKEN` secret present). One shared
  credential from env vars, minted as an ambient singleton per user (the
  Scheduled Tasks / Web Search pattern), scope narrowed by `BASIN_SCOPE`. Same trust
  boundary as the community HA auto-provision patch: every OS user the Access policy
  admits shares the credential; audit attribution remains per user via the approval
  queue each session is bound to.

The vendor's `autoProvisionsAccount` flag and `connectAccount`/`createAccount`
behaviour are derived from the same env var, so the admin panel's three-state mode
(disabled / optional / enabled) governs the whole surface.

## 3. Resource model

One grouped connect card, the Drive whole-drive / folder / file analogue:

| Granularity | URL | Session | Scope enforcement |
|---|---|---|---|
| Warehouse | `basin://<account>/<bucket>` | `BasinSession` | none needed: the REST endpoint is bucket-scoped by construction |
| Namespace | `basin://<account>/<bucket>/<ns>` | `BasinNamespace` | plan check + metadata rules |
| Table | `basin://<account>/<bucket>/<ns>/<table>` | `BasinTable` | plan check + metadata rules |

Types are declared narrow-before-broad (`table`, `namespace`, `bucket`) so the
Workshop's first-match grant check lands on the right granularity; `basin://` is an
honest scheme (the URL names exactly what is granted). Narrow bindings enumerate only
themselves: a table binding's discovery lists its table and nothing else.

## 4. Scope enforcement (the hard part)

A binding must not leak anything outside its grant, but the credential the gatekeeper
holds is bucket-wide and Basin SQL has no per-table ACL. Enforcement history:

1. **Pure lexical check (rejected).** The first draft extracted `ns.table` references
   from the neutralized query text and rejected out-of-scope pairs. Adversarial review
   killed it: delimited identifiers (`"ns"."table"`) defeat token analysis, and
   alias-qualified columns (`d.name`, `dns_queries.col`) make any dotted-pair rule
   false-positive on ordinary queries. SQL has too many shapes to analyze soundly.
2. **Engine-resolved check (shipped).** DataFusion names every real table read as a
   `TableScan` node in its EXPLAIN output, and `EXPLAIN` is metadata-only and free.
   Every data statement on a narrow binding is prefaced by `EXPLAIN <query>`; the plan
   is parsed for its scan set; the query runs only if every scan is inside the grant.
   A plan with no recognizable scan fails closed. The same check runs on `EXPLAIN`
   statements the agent issues directly, before the plan text is returned (it reveals
   schema).
3. **The lexical layer survives with a narrower job:** refuse what no analyzer here
   promises to understand (delimited identifiers, `information_schema`) and enforce
   the metadata statements that never reach a plan (`SHOW DATABASES` refused; `SHOW
   TABLES IN` must target the bound namespace and is refused for table bindings;
   `DESCRIBE` must name a table inside the grant).

`EXPLAIN ANALYZE` is refused outright by the guardrails: it executes the query rather
than planning it. Documented residual: provider error text can confirm the existence
of a named object (one bit per guess), which upstream's observer guidance accepts for
existence probing; scope rejections return normalized reasons.

The corpus in `__tests__/scope.test.ts` is the security contract: every bypass shape
from the review (quoted identifiers, CTE shadowing, lateral and scalar subqueries,
UNION arms, information_schema, sibling enumeration) is pinned as a test.

## 5. Security model

- Read-only; no actions; `applyAction`/`revertAction` throw.
- One observation per data crossing, marked `containsRestrictedData: true`: query
  (SQL in a `sql` field, scope, rows, bytes), every cursor page, catalog reads, table
  schema, freshness probes. `getBudget()` is observed too (a count the caller asked
  for is data) but not marked restricted: it is gatekeeper-owned state, not warehouse
  data.
- Observer strategy A (private-only): `addObserver` always throws, so a gadget that
  read warehouse data cannot be shared; `containsRestrictedData` additionally locks
  the workspace (no further public web fetches, manual approval on every action), so
  data cannot leak sideways through other gatekeepers either. Roadmap, not v1:
  strategy B for per-user mode, probing the observer's own token with a free
  `DESCRIBE` of the granted resource.
- Budget: per binding per UTC day, from the engine's own `metrics.bytes_scanned`,
  in the Gatekeeper DO's storage. Per the overseer's facet topology, one DO exists
  per workspace binding, so in auto-provision mode each user's workspace has its own
  budget (shared only among that workspace's collaborators). The gatekeeper is
  deliberately identity-blind; per-user attribution lives in the Workshop's
  observation log, not here.

## 6. Ergonomics for agents

- `getCatalog()` ships live-verified platform notes (double-encoded JSON and the
  `json_get_str` unwrap, the 2000-byte JSON function cap and the regexp_replace
  fallback, the 5000-manifest cap, `__ingest_ts`, at-least-once `event_id`), because
  those facts are what separate an agent that queries Basin correctly from one that
  flails. They are facts about the engine, not any warehouse, so every deployment
  benefits. `BASIN_NOTES` appends deployment-specific notes.
- Provider errors are mapped to actionable messages (`40020` -> split the UNION;
  401/403 -> token guidance), because a raw provider error teaches the agent nothing.
- Results page through a `more` cursor (one observation per page) with a row cap, so
  a large result neither truncates silently nor blows one RPC reply.
- `getBudget()` lets the agent regulate itself before querying.

## 7. State and storage

No KV, R2, or D1. `UserAccount` DO: credentials, connect nonces, staged reconnects.
`BasinGatekeeper` DO (per binding): budget counters (`budget:<day>`), discovery cache
(`catalog`, `cols:<ns>:<table>`), both TTL-bounded. Everything else (identity, grants,
audit) stays in Workshop storage, by design: the gatekeeper plugs into the OS
capability system instead of building a parallel permission store.

## 8.1 Per-user scoping for the ambient singleton (the enterprise mode)

Auto-provision mode relocates consent from connect-time to admin-time, which creates a
query-time enforcement obligation at the gatekeeper. `BASIN_SCOPE` alone discharges it
with one deployment-wide decision; an enterprise with per-table governance needs a
per-user one.

- **Resolution.** `BASIN_USER_SCOPES` maps the provisioning user's verified email to
  the scope of their ambient singleton: exact matches (case-insensitive), then suffix
  patterns in declaration order, then an optional `default`. Unmatched users with no
  default fail closed at singleton mint with operator guidance - a visible error beats
  a silent over-grant. Scope specs share the `BASIN_SCOPE` grammar, and the resolved
  scope is enforced by the same per-binding machinery: the facet carries it in props,
  the plan verifier checks every query against it, and the observation log names it.
- **Identity bridge.** Verified against upstream `bd10b0e`: `createAccount()` is
  identity-blind by contract, ambient facet props are entirely the gatekeeper's own
  mint, and the only identity-carrying surface in the whole contract is
  `getSupportedResources(options.userId)`, which upstream itself calls a temporary
  hack. There is also no group-claims source anywhere in the platform. So the fork
  ships `patches/workshop-note-provisioned-owner.patch` (generated from, and verified
  against, the pinned upstream commit): at auto-provisioning, the Workshop records the
  provisioning user's verified email (`profile.id` on the user DO) on accounts whose
  description declares `receivesProvisionedOwner`. The account stores it write-once in
  a `BasinOwnerRecord` DO keyed deterministically from the account id - whoever could
  rewrite the owner could rewrite the scope it resolves to, so it is immutable once
  set. Gatekeepers that do not declare the flag are untouched; an unpatched Workshop
  ignores it (the method simply is never called, and `BASIN_USER_SCOPES` unset keeps
  the old behaviour).
- **What this is upstream-shaped about.** The contract addition is one optional flag
  on `AccountDescription` plus one optional method on `GatekeeperUser`, gated on the
  declared flag per the platform's own optional-method convention. It exposes the
  platform gap with a consuming implementation rather than proposing an abstract
  capability. The proposal is drafted in
  `docs/upstream-issue-per-user-scoping.md`.
- **Re-provisioning.** Accounts provisioned before the patch carry no owner record;
  with the map set they fail closed with guidance (disable/re-enable the connector or
  revoke the account), rather than silently falling back to the deployment-wide scope.
- **Budget topology note.** Facets are per workspace (children of each user's
  overseer), so per-user scopes also mean per-user facet instances: the per-binding
  budget and catalog caches stay separated per user's workspace, as before.

## 8. Conformance and divergence from the write-gatekeeper skill


Follows: three-tier architecture, `types.d.ts` as the agent's sole documentation
(self-contained, lint-enforced upstream), STOP-for-API-review (held with the operator,
2026-10-26), observations before returns, read-only action surface, strategy A, kit
leaves for credential staging/expiry, connect handoff through
`connectHandoffPageHtml`, per-type configurators with narrow-before-broad declaration
order and `groupedWith`.

Diverges (with reasons): no caching of query results (queries are user-authored and
budget-accounted; caching would blur the budget semantics), no hooks (Basin has no
push plane), no management operations (pipeline/stream/catalog administration belongs
to the Cloudflare API surface, not a data-access gatekeeper), and the lexical layer
refuses delimited identifiers rather than parsing them (refusal is the only sound
claim a small analyzer can make).

## 9. Open items

- Workerd suite: fake-provider tests for the DOs and sessions (TestHooks harness,
  the `gatekeeper-cloudflare` pattern), including the full pipeline against mocked
  EXPLAIN output. The pure-logic suites already pin the security-critical layers.
- Strategy-B observer probing for per-user mode.
- Track the Basin SQL beta: when read-only queries stop requiring R2 Storage Admin
  R&W (or accept bucket-scoped read tokens), the token recipe narrows and this
  design needs no other change.
- The discovery/EXPLAIN row-shape parsers are defensive against observed variants;
  re-verify against a live warehouse at each pin bump.
