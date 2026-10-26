// The guardrail bypass corpus. Case provenance: the basin-flowviz audit runs
// (comment-in-string, doubled quotes, multi-statement, keyword smuggling, LIMIT forms)
// plus the EXPLAIN ANALYZE execution vector added for this gatekeeper.

import { describe, expect, it } from "vitest";
import { analysisText, sanitizeSql, sqlLit, stripSqlComments } from "../src/guardrails.js";

const ok = (q: string) => {
  const check = sanitizeSql(q);
  if (!check.ok) throw new Error(`expected pass: ${q} -> ${check.error}`);
  return check.query;
};
const reject = (q: string) => {
  const check = sanitizeSql(q);
  if (check.ok) throw new Error(`expected reject: ${q} -> ${check.query}`);
  return check.error;
};

describe("statement allowlist", () => {
  it("allows SELECT, WITH, SHOW, DESCRIBE, EXPLAIN", () => {
    expect(ok("SELECT 1 FROM t").length).toBeGreaterThan(0);
    expect(ok("WITH x AS (SELECT 1 AS a) SELECT a FROM x")).toContain("WITH");
    expect(ok("SHOW DATABASES")).toBe("SHOW DATABASES");
    expect(ok("DESCRIBE ns.t")).toBe("DESCRIBE ns.t");
    expect(ok("EXPLAIN SELECT 1 FROM t")).toContain("EXPLAIN");
  });

  it("rejects write statements and write keywords anywhere", () => {
    expect(reject("INSERT INTO t VALUES (1)")).toBeDefined();
    expect(reject("UPDATE t SET a = 1")).toBeDefined();
    expect(reject("DELETE FROM t")).toBeDefined();
    expect(reject("CREATE TABLE t (a int)")).toBeDefined();
    expect(reject("DROP TABLE t")).toBeDefined();
    expect(reject("GRANT ALL ON t TO u")).toBeDefined();
    expect(reject("TRUNCATE t")).toBeDefined();
    expect(reject("COPY (SELECT 1) TO 'x'")).toBeDefined();
    // write keyword smuggled into a read statement (outside a string)
    expect(reject("SELECT * FROM t WHERE a IN (DELETE)")).toBeDefined();
    // a write keyword inside a string is data, not SQL: passes the lexical layer
    expect(ok("SELECT 'insert into something' FROM t")).toBeDefined();
  });

  it("rejects non-statements and multiple statements", () => {
    expect(reject("")).toBeDefined();
    expect(reject("   ")).toBeDefined();
    expect(reject("SET ROLE admin")).toBeDefined();
    expect(reject("SELECT 1 FROM t; SELECT 2 FROM u")).toBeDefined();
    expect(ok("SELECT 1 FROM t;;")).toBe("SELECT 1 FROM t LIMIT 200"); // trailing semicolons trimmed
    // semicolon inside a string is fine
    expect(ok("SELECT 'a;b' FROM t")).toBeDefined();
  });

  it("rejects EXPLAIN ANALYZE, which executes the query", () => {
    expect(reject("EXPLAIN ANALYZE SELECT * FROM t")).toBeDefined();
  });

  it("rejects oversized queries", () => {
    expect(reject(`SELECT '${"x".repeat(11_000)}' FROM t`)).toBeDefined();
  });
});

describe("comment and string awareness", () => {
  it("strips line and block comments, but not inside strings", () => {
    expect(stripSqlComments("SELECT 1 -- comment\nFROM t")).toBe("SELECT 1  \nFROM t");
    expect(stripSqlComments("SELECT /* c */ 1")).toBe("SELECT   1");
    // -- inside a string is data
    expect(ok("SELECT 'a--b' FROM t")).toBe("SELECT 'a--b' FROM t LIMIT 200");
    // -- inside a block comment is comment text
    expect(stripSqlComments("/* -- */ SELECT 1")).toBe("  SELECT 1");
  });

  it("does not let a comment hide live SQL", () => {
    // the forwarded text is comment-stripped: a trailing comment cannot smuggle a statement
    const q = ok("SELECT 1 FROM t -- ; DROP TABLE t");
    expect(q).toBe("SELECT 1 FROM t LIMIT 200");
    expect(ok("SELECT 1 FROM t -- LIMIT 1")).toContain("LIMIT 200"); // comment gone, LIMIT appended
  });

  it("neutralized analysis cannot be fooled by string contents", () => {
    const analysis = analysisText("SELECT 'DELETE FROM x' FROM t");
    expect(analysis).toBe("SELECT '' FROM t");
  });
});

describe("LIMIT hygiene", () => {
  it("appends a LIMIT when none is present", () => {
    expect(ok("SELECT * FROM t")).toBe("SELECT * FROM t LIMIT 200");
  });

  it("accepts plain and OFFSET forms within caps", () => {
    expect(ok("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t LIMIT 10");
    expect(ok("SELECT * FROM t LIMIT 2000")).toBe("SELECT * FROM t LIMIT 2000");
    expect(ok("SELECT * FROM t LIMIT 10 OFFSET 20000")).toContain("OFFSET 20000");
  });

  it("rejects forms the engine would read differently", () => {
    // MySQL comma form: the first number is the offset; a naive guard validated the wrong one
    expect(reject("SELECT * FROM t LIMIT 5, 999999999")).toBeDefined();
    expect(ok("SELECT * FROM t LIMIT 100, 2000")).toContain("LIMIT 100, 2000");
    // scientific notation and LIMIT ALL
    expect(reject("SELECT * FROM t LIMIT 1e3")).toBeDefined();
    expect(reject("SELECT * FROM t LIMIT ALL")).toBeDefined();
    // caps
    expect(reject("SELECT * FROM t LIMIT 2001")).toBeDefined();
    expect(reject("SELECT * FROM t OFFSET 20001")).toBeDefined();
  });
});

describe("sqlLit", () => {
  it("escapes single quotes by doubling", () => {
    expect(sqlLit("o'brien")).toBe("'o''brien'");
  });
});
