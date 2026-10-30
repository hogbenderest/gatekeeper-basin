// The governed pipeline through a real session in workerd: the free EXPLAIN preflight
// verifies the engine plan on narrow bindings before anything is billed (the authoritative
// check - data statements are not checked for table references lexically, by design),
// the lexical guardrails refuse EXPLAIN ANALYZE before the engine, the response read cap
// bounds what the client buffers, and discovery skips out-of-grammar names.

import { afterEach, describe, expect, it, vi } from "vitest";
import { bucketProps, FakeBasinSql, failure, freshProps, hooks, json, unwrap } from "./fake-basin.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const tableProps = () => freshProps({ kind: "table", namespace: "homelab", table: "dns_queries" });

describe("governed queries", () => {
  it("a table binding verifies the engine plan before the billed scan, and refuses sibling tables", async () => {
    const basin = new FakeBasinSql().install();
    const { name, props } = tableProps();
    const err = failure(
      await hooks().run(name, props, [["query", "SELECT * FROM homelab.syslog_events"]]),
    );
    expect(err).toMatch(/outside this binding/);
    // The preflight ran; the billed query never did.
    expect(basin.requests.some((s) => /^EXPLAIN /i.test(s))).toBe(true);
    expect(basin.requests.some((s) => /^SELECT /i.test(s))).toBe(false);
  });

  it("the engine plan is authoritative: a clean query whose plan touches another table is refused", async () => {
    const basin = new FakeBasinSql().install();
    // The SQL text names the granted table; the plan the engine returns names a sibling.
    // This is the case the lexical layer cannot see, and the preflight exists for.
    basin.on(
      /^EXPLAIN /i,
      () => json({ success: true, result: { request_id: "req", schema: [], rows: [{ plan: "TableScan: homelab.syslog_events projection=[*]" }], metrics: { bytes_scanned: 0, files_scanned: 0 } } }),
    );
    const { name, props } = tableProps();
    const err = failure(
      await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]),
    );
    expect(err).toMatch(/outside this binding/);
    expect(basin.requests.some((s) => /^SELECT /i.test(s))).toBe(false);
  });

  it("a query inside the grant passes the plan check and runs", async () => {
    const basin = new FakeBasinSql().install();
    const { name, props } = tableProps();
    const result = unwrap(
      await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]),
    ) as { rows: unknown[] };
    expect(result.rows).toHaveLength(1);
    expect(basin.requests[0]).toMatch(/^EXPLAIN /i);
    expect(basin.requests[1]).toMatch(/^SELECT /i);
  });

  it("refuses EXPLAIN ANALYZE lexically, before the engine", async () => {
    const basin = new FakeBasinSql().install();
    const { name, props } = bucketProps();
    const err = failure(
      await hooks().run(name, props, [["query", "EXPLAIN ANALYZE SELECT * FROM homelab.dns_queries"]]),
    );
    expect(err).toMatch(/EXPLAIN ANALYZE/);
    expect(basin.requests).toHaveLength(0);
  });

  it("refuses an oversized provider response at the read cap, arming the latch", async () => {
    const basin = new FakeBasinSql().install();
    basin.on(/^SELECT/i, () => json("x".repeat(2 * 1024 * 1024)));
    const { name, props } = bucketProps();
    const err = failure(
      await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]),
    );
    expect(err).toMatch(/read cap/);
    const { observations } = await hooks().queueLog(name);
    expect(observations.some((o) => o.title === "Basin query failed" && o.containsRestrictedData)).toBe(
      true,
    );
  });

  it("getCatalog lists the grant and skips out-of-grammar names instead of failing", async () => {
    const basin = new FakeBasinSql().install();
    basin.namespaces[0].tables.push({ table: "2026-events", columns: [{ name: "x", type: "Utf8" }] });
    const { name, props } = bucketProps();
    const catalog = unwrap(await hooks().run(name, props, [["getCatalog"]])) as {
      namespaces: { namespace: string; tables: string[] }[];
    };
    const homelab = catalog.namespaces.find((n) => n.namespace === "homelab");
    expect(homelab!.tables).toContain("dns_queries");
    expect(homelab!.tables).toContain("syslog_events");
    expect(homelab!.tables).not.toContain("2026-events");
  });

  it("getNamespace's narrow discovery never poisons the session catalog: the cache is scope-keyed (audit finding 8)", async () => {
    const basin = new FakeBasinSql().install();
    basin.namespaces.push({
      namespace: "netflow",
      tables: [{ table: "flows", columns: [{ name: "event_id", type: "Utf8" }] }],
    });
    const { name, props } = bucketProps();
    // A narrow discovery first: pre-fix it cached under one scope-blind key.
    const ns = unwrap(await hooks().run(name, props, [["getNamespace", "homelab"], ["describe"]])) as {
      namespace: string;
      tables: string[];
    };
    expect(ns.tables).toContain("dns_queries");
    // The bucket-wide catalog must still see every namespace, not the narrow view.
    const catalog = unwrap(await hooks().run(name, props, [["getCatalog"]])) as {
      namespaces: { namespace: string; tables: string[] }[];
    };
    expect(catalog.namespaces.map((n) => n.namespace).sort()).toEqual(["homelab", "netflow"]);
  });
});
