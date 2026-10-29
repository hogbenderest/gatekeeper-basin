#!/usr/bin/env node
// Basin SQL engine prober: an ops tool for verifying a credential and the engine
// behaviours the gatekeeper depends on, before wiring either into a deployment.
//
// Usage:
//   BASIN_SQL_TOKEN=<r2 api token> BASIN_ACCOUNT_ID=<account id> BASIN_BUCKET=<bucket> \
//     node scripts/probe-engine.mjs [probe ...]
//
// Probes (default: all):
//   show-databases    the credential queries the warehouse at all (metadata, free)
//   copy-rejected     writes are refused (the 40003 read-only enforcement the gatekeeper relies on)
//   stacked-rejected  stacked statements are refused (the single-statement rule)
//   explain-analyze   whether EXPLAIN (ANALYZE) executes the query vs the free bare EXPLAIN
//   error-echo        whether engine error text echoes values (literal cast + column cast)
//
// The token is read from the environment only and never printed. Reports are JSON on stdout.

const TOKEN = process.env.BASIN_SQL_TOKEN;
const ACCOUNT_ID = process.env.BASIN_ACCOUNT_ID;
const BUCKET = process.env.BASIN_BUCKET;
if (!TOKEN || !ACCOUNT_ID || !BUCKET) {
  console.error("Set BASIN_SQL_TOKEN, BASIN_ACCOUNT_ID and BASIN_BUCKET in the environment.");
  process.exit(2);
}

const URL_ =
  `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(ACCOUNT_ID)}` +
  `/basin-sql/query/${encodeURIComponent(BUCKET)}`;

async function post(sql) {
  const resp = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(30_000),
  });
  return JSON.parse(await resp.text());
}

/** One governed-API call: status, envelope subset, and timing. The token never crosses into the result. */
async function run(sql) {
  const started = Date.now();
  let body;
  try {
    body = await post(sql);
  } catch (e) {
    return { transportError: String(e).slice(0, 200), ms: Date.now() - started };
  }
  const rows = body?.result?.rows ?? body?.rows;
  const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
  return {
    success: body?.success === true,
    errorCode: typeof first?.code === "number" ? first.code : undefined,
    errorMessage:
      typeof first?.message === "string" && first.message.length > 0 ? first.message.slice(0, 300) : undefined,
    rowCount: Array.isArray(rows) ? rows.length : undefined,
    bytesScanned: body?.result?.metrics?.bytes_scanned ?? body?.metrics?.bytes_scanned,
    ms: Date.now() - started,
  };
}

const probes = {
  async "show-databases"() {
    return {
      probe: "show-databases",
      sql: "SHOW DATABASES",
      expectation: "success true; namespaces listed",
      result: await run("SHOW DATABASES"),
    };
  },
  async "copy-rejected"() {
    const sql = "COPY INTO _probe_should_not_exist FROM SELECT 1";
    return {
      probe: "copy-rejected",
      sql,
      expectation: "refused, error 40003, message contains 'read-only'",
      result: await run(sql),
    };
  },
  async "stacked-rejected"() {
    const sql = "SHOW DATABASES; SHOW DATABASES";
    return {
      probe: "stacked-rejected",
      sql,
      expectation: "refused, error 40003, message contains 'single SQL statement'",
      result: await run(sql),
    };
  },
  async "explain-analyze"(ctx) {
    const ref = ctx.tableRef;
    const cases = [];
    for (const [label, sql, expectation] of [
      ["bare EXPLAIN", `EXPLAIN SELECT * FROM ${ref}`, "free metadata plan: success, bytes_scanned 0"],
      ["EXPLAIN ANALYZE", `EXPLAIN ANALYZE SELECT * FROM ${ref}`, "executes: bytes_scanned > 0, or rejected"],
      ["EXPLAIN (ANALYZE)", `EXPLAIN (ANALYZE) SELECT * FROM ${ref}`, "executes: bytes_scanned > 0, or rejected"],
      ["EXPLAIN(ANALYZE)", `EXPLAIN(ANALYZE) SELECT * FROM ${ref}`, "same as the spaced paren form"],
    ]) {
      cases.push({ label, sql, expectation, result: await run(sql) });
    }
    return { probe: "explain-analyze", table: ref, cases };
  },
  async "error-echo"(ctx) {
    const ref = ctx.tableRef;
    const marker = `probe_marker_${Math.random().toString(36).slice(2, 10)}`;
    const cases = [];
    for (const [label, sql] of [
      ["literal cast", `SELECT CAST('${marker}' AS BIGINT) FROM ${ref} LIMIT 1`],
      ["column cast", `SELECT CAST(${ctx.textColumn} AS BIGINT) FROM ${ref} LIMIT 1`],
    ]) {
      const result = await run(sql);
      cases.push({
        label,
        sql,
        expectation: "error message echoes the value (audit run 1, findings 4/5 conditional severity)",
        result,
        literalEchoed: label === "literal cast" ? result.errorMessage?.includes(marker) : undefined,
      });
    }
    return { probe: "error-echo", table: ref, marker, cases };
  },
};

/** A queryable table reference plus a text column, discovered from the warehouse itself. */
async function discoverTarget() {
  const nsRows = (await post("SHOW DATABASES"))?.result?.rows ?? [];
  const namespaceNames = nsRows
    .map((r) => r.database_name ?? r.namespace ?? r.name)
    .filter((n) => typeof n === "string" && n !== "information_schema");
  for (const ns of namespaceNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ns)) continue;
    const tblRows = (await post(`SHOW TABLES IN ${ns}`))?.result?.rows ?? [];
    const tables = tblRows
      .map((r) => r.table_name ?? r.name ?? r.tables_in_bucket)
      .filter((t) => typeof t === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    if (tables.length === 0) continue;
    const columns = (await post(`DESCRIBE ${ns}.${tables[0]}`))?.result?.rows ?? [];
    const textCol =
      columns.find((c) => /varchar|text|string/i.test(String(c.data_type ?? c.type)))?.column_name ??
      columns[0]?.column_name;
    if (typeof textCol === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(textCol)) {
      return { tableRef: `${ns}.${tables[0]}`, textColumn: textCol };
    }
  }
  throw new Error("No queryable table found for the analyze/echo probes.");
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(probes);
const ctx = names.includes("explain-analyze") || names.includes("error-echo") ? await discoverTarget() : {};
const report = { probedAt: new Date().toISOString(), bucket: BUCKET, accountId: ACCOUNT_ID, probes: [] };
for (const name of names) {
  const probe = probes[name];
  if (!probe) {
    console.error(`Unknown probe: ${name}`);
    process.exit(2);
  }
  report.probes.push(await probe(ctx));
}
console.log(JSON.stringify(report, null, 2));
