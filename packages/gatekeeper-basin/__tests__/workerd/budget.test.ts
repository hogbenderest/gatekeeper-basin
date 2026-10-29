// The reserve-then-settle budget through a real session in workerd (plans/basin-gatekeeper
// §10, audit run 1, finding 1): the reservation is claimed before the outbound fetch, so
// concurrent queries against one facet cannot all pass one bare check; settlement,
// persistence across an eviction-restart, and what free statements cost.
//
// miniflare bindings: BASIN_DAILY_SCAN_MB=3, BASIN_RESERVE_MB=1 - three billed queries
// fit per facet, the fourth is refused before its fetch.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bucketProps,
  FakeBasinSql,
  failure,
  hooks,
  providerFailure,
  unwrap,
} from "./fake-basin.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const RESERVE = 1024 * 1024;
const CAP = 3 * RESERVE;

describe("budget reserve-then-settle", () => {
  it("reserves before the fetch: three concurrent queries fit the cap, the fourth never reaches the engine", async () => {
    const basin = new FakeBasinSql().install();
    const { name, props } = bucketProps();
    const outcomes = await hooks().runParallel(name, props, [
      ["query", "SELECT * FROM homelab.dns_queries"],
      ["query", "SELECT * FROM homelab.dns_queries"],
      ["query", "SELECT * FROM homelab.dns_queries"],
      ["query", "SELECT * FROM homelab.dns_queries"],
    ]);
    const okays = outcomes.filter((o) => "ok" in o);
    const errors = outcomes.filter((o) => "error" in o);
    expect(okays).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(failure(errors[0])).toMatch(/budget is exhausted/);
    // The refused query never reached the engine: exactly three data queries did.
    expect(basin.requests.filter((s) => /^SELECT/i.test(s))).toHaveLength(3);
    // Each settling query scanned 200 KB, under its 1 MB reservation: reservations stand.
    const budget = unwrap(await hooks().run(name, props, [["getBudget"]])) as { usedBytes: number };
    expect(budget.usedBytes).toBe(3 * RESERVE);
  });

  it("settles upward when the actual scan exceeds the reservation", async () => {
    const basin = new FakeBasinSql().install();
    basin.bytesScanned = 1_500_000;
    const { name, props } = bucketProps();
    unwrap(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]));
    const budget = unwrap(await hooks().run(name, props, [["getBudget"]])) as { usedBytes: number };
    expect(budget.usedBytes).toBe(1_500_000);
  });

  it("keeps the reservation when the actual scan is below it", async () => {
    const basin = new FakeBasinSql().install();
    basin.bytesScanned = 200_000;
    const { name, props } = bucketProps();
    unwrap(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]));
    const budget = unwrap(await hooks().run(name, props, [["getBudget"]])) as { usedBytes: number };
    expect(budget.usedBytes).toBe(RESERVE);
  });

  it("a failed billed query keeps its reservation, and still arms the workspace latch", async () => {
    const basin = new FakeBasinSql().install();
    basin.on(/^SELECT/i, () => providerFailure(40001, "engine says no"));
    const { name, props } = bucketProps();
    expect(
      failure(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]])),
    ).toBeTruthy();
    const budget = unwrap(await hooks().run(name, props, [["getBudget"]])) as { usedBytes: number };
    expect(budget.usedBytes).toBe(RESERVE);
    const { observations } = await hooks().queueLog(name);
    expect(
      observations.some((o) => o.title === "Basin query failed" && o.containsRestrictedData),
    ).toBe(true);
  });

  it("free statements reserve nothing: EXPLAIN and getCatalog leave the counter untouched", async () => {
    new FakeBasinSql().install();
    const { name, props } = bucketProps();
    unwrap(await hooks().run(name, props, [["query", "EXPLAIN SELECT * FROM homelab.dns_queries"]]));
    unwrap(await hooks().run(name, props, [["getCatalog"]]));
    const budget = unwrap(await hooks().run(name, props, [["getBudget"]])) as {
      usedBytes: number;
      capBytes: number;
      resetsAtUtc: string;
    };
    expect(budget.usedBytes).toBe(0);
    expect(budget.capBytes).toBe(CAP);
    expect(Date.parse(budget.resetsAtUtc)).toBeGreaterThan(Date.now() - 1000);
  });

  it("the counter persists across an eviction-restart", async () => {
    const basin = new FakeBasinSql().install();
    basin.bytesScanned = 1_500_000;
    const { name, props } = bucketProps();
    unwrap(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]));
    hooks().restart(name);
    const budget = unwrap(await hooks().run(name, props, [["getBudget"]])) as { usedBytes: number };
    expect(budget.usedBytes).toBe(1_500_000);
  });
});
