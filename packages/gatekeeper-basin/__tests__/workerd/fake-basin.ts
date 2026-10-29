// Basin SQL, faked at the `fetch` boundary for the workerd suite. Installed with
// vi.stubGlobal, which reaches the gatekeeper because the whole suite - test file,
// TestHooks, and the Durable Objects - runs in one isolate. The fake records every
// statement it is asked, answers the metadata statements the gatekeeper's discovery
// and preflight issue (SHOW DATABASES, SHOW TABLES IN, DESCRIBE, EXPLAIN), and
// models data queries with a controllable bytes_scanned. A test injects a route with
// `on()`, whose routes answer before the built-in ones, latest first. Anything sent
// anywhere but the Basin SQL endpoint fails the test.

import { env } from "cloudflare:test";
import { vi } from "vitest";
import type { BasinGatekeeperProps } from "../../src/basin.js";
import type { BasinScope } from "../../src/scope.js";
import type { TestHooks } from "./worker.js";

export const ACCOUNT_ID = "023e105f4ecef8ad9ca31a8372d0c353";
export const ENDPOINT =
  `https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT_ID}/basin-sql/query/basin-demo`;

/** A validated success envelope, in the shape parseQueryResponse accepts. */
export function envelope(rows: Record<string, unknown>[], bytesScanned: number) {
  return {
    success: true,
    result: {
      request_id: "req_test",
      schema: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "Utf8" })),
      rows,
      metrics: { bytes_scanned: bytesScanned, files_scanned: 1 },
    },
  };
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A provider failure body, as the engine returns one (HTTP 400, errors array). */
export function providerFailure(code: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/** The warehouse model the fake answers from. */
export type FakeTable = { table: string; columns: { name: string; type: string }[] };

export class FakeBasinSql {
  /** Every statement the fake was asked, in order - the strongest assertion target. */
  readonly requests: string[] = [];
  /** bytes_scanned the fake reports for a data query (discovery and EXPLAIN stay free). */
  bytesScanned = 200_000;

  namespaces: { namespace: string; tables: FakeTable[] }[] = [
    {
      namespace: "homelab",
      tables: [
        {
          table: "dns_queries",
          columns: [
            { name: "client_hash", type: "Utf8" },
            { name: "event_id", type: "Utf8" },
            { name: "__ingest_ts", type: "Timestamp" },
          ],
        },
        { table: "syslog_events", columns: [{ name: "event_id", type: "Utf8" }] },
      ],
    },
  ];

  readonly #routes: { match: RegExp; respond: (sql: string) => Response | Promise<Response> }[] = [];

  /** Route matching statements to a response; the latest-added route wins. */
  on(match: RegExp, respond: (sql: string) => Response | Promise<Response>): this {
    this.#routes.push({ match, respond });
    return this;
  }

  install(): this {
    vi.stubGlobal("fetch", this.#fetch);
    return this;
  }

  #fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ENDPOINT) throw new Error(`The fake only expects the Basin SQL endpoint, not ${url}`);
    const sql = JSON.parse(String(init?.body)).query;
    if (typeof sql !== "string") throw new Error("The fake expects a { query } JSON body.");
    this.requests.push(sql);
    for (const route of [...this.#routes].reverse()) {
      if (route.match.test(sql)) return await route.respond(sql);
    }
    // Discovery and preflight: metadata statements, free, bytes_scanned 0.
    if (/^SHOW DATABASES$/i.test(sql)) {
      return json(envelope(this.namespaces.map((n) => ({ database_name: n.namespace })), 0));
    }
    let m = /^SHOW TABLES IN ([A-Za-z_][A-Za-z0-9_]*)$/i.exec(sql);
    if (m) {
      const ns = this.namespaces.find((n) => n.namespace === m![1]);
      return json(envelope((ns?.tables ?? []).map((t) => ({ table_name: t.table })), 0));
    }
    m = /^DESCRIBE ([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/i.exec(sql);
    if (m) {
      const ns = this.namespaces.find((n) => n.namespace === m![1]);
      const table = ns?.tables.find((t) => t.table === m![2]);
      return json(
        envelope((table?.columns ?? []).map((c) => ({ column_name: c.name, data_type: c.type })), 0),
      );
    }
    if (/^EXPLAIN\b/i.test(sql)) {
      // The engine names every table a query reads as a TableScan node, in the plan
      // text the preflight consumes. Reflect the statement's own dotted references.
      const subject = sql.replace(/^EXPLAIN\s+/i, "");
      const refs = [...subject.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(
        (r) => `${r[1]}.${r[2]}`,
      );
      const plan = [...new Set(refs)].map((ref) => `TableScan: ${ref} projection=[*]`).join("\n");
      return json(envelope([{ plan }], 0));
    }
    // A data query: what the gatekeeper came to guard.
    return json(envelope([{ c: "value" }], this.bytesScanned));
  };
}

export function hooks(): TestHooks {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks")) as unknown as TestHooks;
}

export function unwrap<T>(outcome: { ok: T } | { error: string }): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A forwarded call's failure message, failing the test when it succeeded. */
export function failure(outcome: { ok: unknown } | { error: string }): string {
  if (!("error" in outcome)) throw new Error(`expected a failure, got ${JSON.stringify(outcome.ok)}`);
  return outcome.error;
}

/** A fresh deployment-mode facet name + props for one scenario: fresh budget, fresh cache. */
export function freshProps(scope: BasinScope): { name: string; props: BasinGatekeeperProps } {
  return { name: crypto.randomUUID(), props: { mode: "deployment", scope } };
}

export const bucketProps = () => freshProps({ kind: "bucket" });
