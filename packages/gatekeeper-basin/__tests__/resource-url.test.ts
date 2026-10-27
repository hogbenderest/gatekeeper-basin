// The basin:// parser-differential corpus (security audit run 1, finding 2).
// The Workshop resolves request URLs with URLPattern, whose named groups match
// a bare "/" segment; the gatekeeper's parse is the enforcement authority, so
// it refuses empty segments rather than parsing them into a wider scope, and
// tolerates exactly one trailing slash (what the Workshop's toggle strips).

import { describe, expect, it } from "vitest";
import { parseBasinResourceUrl } from "../src/resource-url.js";

const ACCT = "023e105f4ecef8ad9ca31a8372d0c353";

describe("parseBasinResourceUrl", () => {
  it("parses bucket, namespace, and table URLs", () => {
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo`).scope).toEqual({ kind: "bucket" });
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo/homelab`).scope).toEqual({
      kind: "namespace",
      namespace: "homelab",
    });
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo/homelab/dns_queries`).scope).toEqual({
      kind: "table",
      namespace: "homelab",
      table: "dns_queries",
    });
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo`).bucket).toBe("basin-demo");
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo`).accountId).toBe(ACCT);
  });

  it("tolerates exactly one trailing slash, like the Workshop's URLPattern toggle", () => {
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo/`).scope).toEqual({ kind: "bucket" });
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo/homelab/`).scope).toEqual({
      kind: "namespace",
      namespace: "homelab",
    });
    expect(parseBasinResourceUrl(`basin://${ACCT}/basin-demo/homelab/dns_queries/`).scope.kind).toBe("table");
  });

  it("refuses empty path segments instead of parsing them as a wider scope (finding 2)", () => {
    // The Workshop labels this "Basin namespace" (namespace group matches "/");
    // the gatekeeper must never mint the bucket-scope binding that label hides.
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/basin-demo//`)).toThrow();
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/basin-demo///`)).toThrow();
    // .../homelab// labels "Basin table"; enforcement must not silently widen to namespace.
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/basin-demo/homelab//`)).toThrow();
    expect(() => parseBasinResourceUrl(`basin://${ACCT}//basin-demo`)).toThrow();
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/basin-demo//homelab`)).toThrow();
  });

  it("refuses four or more segments, non-basin schemes, and malformed hosts", () => {
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/b/ns/tbl/extra`)).toThrow();
    expect(() => parseBasinResourceUrl("https://example.com/bucket")).toThrow(/basin:/);
    expect(() => parseBasinResourceUrl("basin://ab/b")).toThrow(/account ID/);
    expect(() => parseBasinResourceUrl("basin://")).toThrow();
    expect(() => parseBasinResourceUrl("not a url")).toThrow();
  });

  it("refuses out-of-grammar namespace and table names", () => {
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/basin-demo/2026-events`)).toThrow();
    expect(() => parseBasinResourceUrl(`basin://${ACCT}/basin-demo/ns/dns:queries`)).toThrow();
  });
});
