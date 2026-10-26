// Client correctness: response validation (no blind casts), provider error mapping,
// and the EXPLAIN plan text extractor. The HTTP layer itself is exercised in the
// workerd suite; these tests pin the parsing contract the security layers depend on.

import { describe, expect, it } from "vitest";
import {
  BasinSqlError,
  createBasinSqlClient,
  explainPlanText,
  mapProviderError,
  parseQueryResponse,
} from "../src/basin-sql.js";

const successBody = {
  success: true,
  result: {
    request_id: "req_123",
    schema: [
      { name: "client_hash", type: "Utf8" },
      { name: "count", descriptor: { type: { name: "Int64", nullable: true } } },
    ],
    rows: [{ client_hash: "abc", count: 7 }],
    metrics: { bytes_scanned: 10485760, files_scanned: 4 },
  },
};

describe("parseQueryResponse", () => {
  it("validates and types a successful envelope", () => {
    const parsed = parseQueryResponse(successBody);
    expect(parsed.requestId).toBe("req_123");
    expect(parsed.schema).toEqual([
      { name: "client_hash", type: "Utf8" },
      { name: "count", type: "Int64" },
    ]);
    expect(parsed.rows).toEqual([{ client_hash: "abc", count: 7 }]);
    expect(parsed.metrics).toEqual({ bytesScanned: 10485760, filesScanned: 4 });
    expect(parsed.totalRows).toBe(1);
  });

  it("maps provider failures to actionable BasinSqlErrors", () => {
    try {
      parseQueryResponse({
        success: false,
        errors: [{ code: 40020, message: "query exceeds manifest limit" }],
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BasinSqlError);
      const err = e as BasinSqlError;
      expect(err.code).toBe(40020);
      expect(err.message).toContain("Split multi-table queries");
      expect(err.providerMessage).toBe("query exceeds manifest limit");
    }
  });

  it("rejects malformed envelopes instead of casting them", () => {
    expect(() => parseQueryResponse(null)).toThrow(BasinSqlError);
    expect(() => parseQueryResponse({ success: true })).toThrow(BasinSqlError);
    expect(() =>
      parseQueryResponse({ success: true, result: { schema: "no", rows: [] } }),
    ).toThrow(BasinSqlError);
    expect(() =>
      parseQueryResponse({ success: true, result: { schema: [], rows: [42] } }),
    ).toThrow(BasinSqlError);
    expect(() =>
      parseQueryResponse({
        success: true,
        result: { schema: [], rows: [], metrics: { bytes_scanned: "lots" } },
      }),
    ).toThrow(BasinSqlError);
  });

  it("accepts numeric strings in metrics and unknown request ids", () => {
    const parsed = parseQueryResponse({
      success: true,
      result: { schema: [], rows: [], metrics: { bytes_scanned: "123", files_scanned: 1 } },
    });
    expect(parsed.metrics.bytesScanned).toBe(123);
    expect(parsed.requestId).toBe("unknown");
  });
});

describe("error mapping", () => {
  it("gives the token failures a credential-shaped message", () => {
    expect(mapProviderError(401, "denied")).toContain("token was rejected");
    expect(mapProviderError(403, "denied")).toContain("token was rejected");
    const err401 = new BasinSqlError(mapProviderError(401, "x"), 401);
    expect(err401.authFailure).toBe(true);
    expect(new BasinSqlError("m", 40020).authFailure).toBe(false);
  });

  it("passes through unknown codes with the provider message", () => {
    expect(mapProviderError(50000, "boom")).toBe("boom");
    expect(mapProviderError(undefined, "")).toContain("returned an error");
  });
});

describe("explainPlanText", () => {
  it("joins every string cell value, ignoring other types", () => {
    const parsed = parseQueryResponse({
      success: true,
      result: {
        schema: [
          { name: "plan_type", type: "Utf8" },
          { name: "plan", type: "Utf8" },
        ],
        rows: [
          { plan_type: "logical_plan", plan: "TableScan: homelab.dns_queries", extra: 5 },
          { plan_type: "physical_plan", plan: "  ProjectionExec", other: null },
        ],
        metrics: { bytes_scanned: 0, files_scanned: 0 },
      },
    });
    expect(explainPlanText(parsed)).toBe(
      "logical_plan\nTableScan: homelab.dns_queries\nphysical_plan\n  ProjectionExec",
    );
  });
});

describe("createBasinSqlClient", () => {
  it("targets the basin-sql REST endpoint with the credential", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = createBasinSqlClient({
      accountId: "48f5cc18f1a716e781d39f1d6777ddc9",
      bucket: "basin-demo",
      token: "secret-token",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify(successBody), { status: 200 });
    }) as typeof fetch;
    try {
      const parsed = await client.runQuery("SELECT 1 FROM t");
      expect(parsed.rows).toHaveLength(1);
      expect(seen!.url).toBe(
        "https://api.sql.cloudflarestorage.com/api/v1/accounts/48f5cc18f1a716e781d39f1d6777ddc9/basin-sql/query/basin-demo",
      );
      const headers = seen!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret-token");
      expect(JSON.parse(String(seen!.init.body))).toEqual({ query: "SELECT 1 FROM t" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces auth failures without leaking the token", async () => {
    const client = createBasinSqlClient({ accountId: "a".repeat(32), bucket: "b", token: "secret-token" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    try {
      await expect(client.runQuery("SHOW DATABASES")).rejects.toThrow(/token was rejected/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
