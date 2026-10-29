// Observations through a real session in workerd (audit run 1, finding 4): every data
// crossing is authorized; a failed billed query arms the workspace latch BEFORE its
// error is released - and the raw engine text never crosses, only the mapped message;
// a blocked observation refuses the crossing, success and error alike.

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

describe("observations", () => {
  it("observes a successful data query as restricted, with the SQL", async () => {
    new FakeBasinSql().install();
    const { name, props } = bucketProps();
    const result = unwrap(
      await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]),
    ) as { rows: unknown[] };
    expect(result.rows).toHaveLength(1);
    const { observations } = await hooks().queueLog(name);
    expect(observations).toHaveLength(1);
    expect(observations[0].title).toBe("Query the Basin warehouse");
    expect(observations[0].containsRestrictedData).toBe(true);
  });

  it("a failed billed query is observed before its error is released, and the raw engine text never crosses", async () => {
    const basin = new FakeBasinSql().install();
    // The live probe result (probe-results.md): the engine echoes cell values into
    // cast errors. The fake reproduces that shape.
    basin.on(
      /^SELECT/i,
      () => providerFailure(40004, "invalid query: Cannot cast string 'did:plc:xyz' to value of Int64 type"),
    );
    const { name, props } = bucketProps();
    const err = failure(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]));
    expect(err).not.toContain("did:plc:xyz"); // the raw text never crosses
    expect(err).toContain("code 40004"); // the mapped, value-free guidance does
    const { observations } = await hooks().queueLog(name);
    const failed = observations.find((o) => o.title === "Basin query failed");
    expect(failed).toBeDefined();
    expect(failed!.containsRestrictedData).toBe(true);
  });

  it("a blocked observation refuses the error too: the failure observation is in the error path", async () => {
    const basin = new FakeBasinSql().install();
    basin.on(/^SELECT/i, () => providerFailure(40001, "engine says no"));
    const { name, props } = bucketProps();
    await hooks().refuseObservations(name, true);
    const err = failure(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]));
    expect(err).toMatch(/refused this observation/);
    await hooks().refuseObservations(name, false);
  });

  it("a blocked observation refuses rows the same way", async () => {
    new FakeBasinSql().install();
    const { name, props } = bucketProps();
    await hooks().refuseObservations(name, true);
    const err = failure(await hooks().run(name, props, [["query", "SELECT * FROM homelab.dns_queries"]]));
    expect(err).toMatch(/refused this observation/);
    await hooks().refuseObservations(name, false);
  });

  it("getCatalog is observed as restricted too", async () => {
    new FakeBasinSql().install();
    const { name, props } = bucketProps();
    unwrap(await hooks().run(name, props, [["getCatalog"]]));
    const { observations } = await hooks().queueLog(name);
    expect(observations.some((o) => o.title === "Read the warehouse catalog")).toBe(true);
  });
});
