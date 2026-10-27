// Discovery parsing over the metadata row shapes Basin SQL returns, identifier
// validation, the deployment notes channel, and ingest-column detection.

import { describe, expect, it } from "vitest";
import {
  isIdentifier,
  deploymentNotes,
  discoverNamespaces,
  discoverTables,
  describeTable,
  identifier,
  ingestColumnsPresent,
  PLATFORM_NOTES,
} from "../src/catalog.js";
import { createBasinSqlClient } from "../src/basin-sql.js";

function fakeClient(rows: Record<string, unknown>[]) {
  const originalFetch = globalThis.fetch;
  let lastQuery = "";
  const client = {
    client: createBasinSqlClient({ accountId: "a".repeat(32), bucket: "b", token: "t" }),
    get lastQuery() {
      return lastQuery;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
  globalThis.fetch = (async (_url: RequestInfo, init?: RequestInit) => {
    lastQuery = JSON.parse(String(init?.body)).query;
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          request_id: "r",
          schema: [{ name: "x", type: "Utf8" }],
          rows,
          metrics: { bytes_scanned: 0, files_scanned: 0 },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return client;
}

describe("identifier", () => {
  it("accepts plain SQL identifiers only", () => {
    expect(identifier("dns_queries")).toBe("dns_queries");
    expect(identifier("_x1")).toBe("_x1");
    expect(isIdentifier("ok_name")).toBe(true);
    expect(isIdentifier("has-hyphen")).toBe(false);
    expect(() => identifier("has-hyphen")).toThrow();
    expect(() => identifier("1abc")).toThrow();
    expect(() => identifier('a"b')).toThrow();
    expect(() => identifier("")).toThrow();
  });
});

describe("discovery over plausible row shapes", () => {
  it("reads SHOW DATABASES rows under any of the known column names", async () => {
    const f = fakeClient([
      { database_name: "default" },
      { namespace: "homelab" },
      { name: "ha" },
      { unknown_column: "cfzone" },
    ]);
    try {
      expect(await discoverNamespaces(f.client)).toEqual(["default", "homelab", "ha", "cfzone"]);
      expect(f.lastQuery).toBe("SHOW DATABASES");
    } finally {
      f.restore();
    }
  });

  it("filters information_schema from SHOW DATABASES", async () => {
    const f = fakeClient([{ database_name: "homelab" }, { database_name: "information_schema" }]);
    try {
      expect(await discoverNamespaces(f.client)).toEqual(["homelab"]);
    } finally {
      f.restore();
    }
  });

  it("reads SHOW TABLES rows and issues the qualified statement", async () => {
    const f = fakeClient([{ table_name: "dns_queries" }, { name: "syslog" }]);
    try {
      expect(await discoverTables(f.client, "homelab")).toEqual(["dns_queries", "syslog"]);
      expect(f.lastQuery).toBe("SHOW TABLES IN homelab");
    } finally {
      f.restore();
    }
  });

  it("reads DESCRIBE rows into typed columns, skipping the header-like names", async () => {
    const f = fakeClient([
      { column_name: "host", data_type: "Utf8" },
      { name: "ts", data_type: "Timestamp(Nanosecond, None)" },
      { name: "message", type: "Utf8" },
    ]);
    try {
      expect(await describeTable(f.client, "homelab", "syslog")).toEqual([
        { name: "host", type: "Utf8" },
        { name: "ts", type: "Timestamp(Nanosecond, None)" },
        { name: "message", type: "Utf8" },
      ]);
      expect(f.lastQuery).toBe("DESCRIBE homelab.syslog");
    } finally {
      f.restore();
    }
  });
});

describe("ingest columns", () => {
  it("detects the pipelines-added columns when present", () => {
    expect(ingestColumnsPresent([{ name: "__ingest_ts" }, { name: "event_id" }])).toEqual([
      "__ingest_ts",
      "event_id",
    ]);
    expect(ingestColumnsPresent([{ name: "host" }])).toEqual([]);
  });
});

describe("platform and deployment notes", () => {
  it("ships the live-verified engine notes", () => {
    expect(PLATFORM_NOTES.some((n) => n.includes("json_get_str"))).toBe(true);
    expect(PLATFORM_NOTES.some((n) => n.includes("2000 bytes"))).toBe(true);
    expect(PLATFORM_NOTES.some((n) => n.includes("40020"))).toBe(true);
    expect(PLATFORM_NOTES.some((n) => n.includes("__ingest_ts"))).toBe(true);
  });

  it("accepts a JSON array of strings, tolerating bad input", () => {
    expect(deploymentNotes('["house convention: times are UTC"]')).toEqual([
      "house convention: times are UTC",
    ]);
    expect(deploymentNotes(undefined)).toEqual([]);
    expect(deploymentNotes("not json")).toEqual([]);
    expect(deploymentNotes('{"a":1}')).toEqual([]);
    expect(deploymentNotes('[42, "ok"]')).toEqual(["ok"]);
  });
});
