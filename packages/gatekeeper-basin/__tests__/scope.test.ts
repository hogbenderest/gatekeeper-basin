// The binding-scope bypass corpus. These are the cases that killed a pure-lexical
// scope check in review: delimited identifiers, CTE shadowing, subqueries in
// projections, lateral subqueries, information_schema, and metadata statements that
// enumerate beyond the grant. The authoritative enforcement for data statements is
// the engine's own resolved plan (checkExplainPlan); the lexical layer (staticScopeCheck)
// enforces metadata statements and refuses what no analyzer here promises to
// understand, and must never false-positive on a legitimate query.

import { describe, expect, it } from "vitest";
import {
  checkExplainPlan,
  explainSubject,
  extractCteNames,
  extractDottedRefs,
  statementKind,
  staticScopeCheck,
  type BasinScope,
} from "../src/scope.js";

const BUCKET: BasinScope = { kind: "bucket" };
const NS: BasinScope = { kind: "namespace", namespace: "homelab" };
const TABLE: BasinScope = { kind: "table", namespace: "homelab", table: "dns_queries" };

const pass = (analysis: string, scope: BasinScope = NS) => {
  const r = staticScopeCheck(analysis, scope);
  if (!r.ok) throw new Error(`expected pass: ${analysis} -> ${r.reason}`);
};
const rejectWith = (analysis: string, scope: BasinScope = NS) => {
  const r = staticScopeCheck(analysis, scope);
  if (r.ok) throw new Error(`expected reject: ${analysis}`);
  return r.reason;
};

describe("bucket scope passes the lexical layer", () => {
  it("allows everything, including information_schema and SHOW", () => {
    expect(staticScopeCheck("SELECT 1 FROM x.y", BUCKET).ok).toBe(true);
    expect(staticScopeCheck("SHOW DATABASES", BUCKET).ok).toBe(true);
    expect(staticScopeCheck("SELECT * FROM information_schema.tables", BUCKET).ok).toBe(true);
    expect(staticScopeCheck('SELECT * FROM "homelab"."x"', BUCKET).ok).toBe(true);
  });
});

describe("delimited identifiers are refused for narrow bindings", () => {
  it("double quotes and backticks cannot smuggle a table past the analysis", () => {
    // The classic bypass: a quoted identifier a naive tokenizer would split wrong.
    expect(rejectWith('SELECT * FROM "homelab"."secret_table"', NS)).toContain("Quoted");
    expect(rejectWith("SELECT * FROM `homelab`.`secret_table`", NS)).toContain("Quoted");
    expect(rejectWith('SELECT * FROM "homelab"."dns_queries"', TABLE)).toContain("Quoted");
    // even an in-scope quoted reference is refused: no promise is made about quoting
    expect(rejectWith('SELECT * FROM "homelab"."dns_queries"', NS)).toContain("Quoted");
  });
});

describe("information_schema is refused for narrow bindings", () => {
  it("anywhere in the query", () => {
    expect(rejectWith("SELECT table_name FROM information_schema.tables", NS)).toContain("information_schema");
    expect(rejectWith("SELECT table_name FROM information_schema.tables", TABLE)).toContain("information_schema");
  });
});

describe("SHOW is scope-checked", () => {
  it("SHOW DATABASES is refused; SHOW TABLES must target the bound namespace", () => {
    expect(rejectWith("SHOW DATABASES", NS)).toContain("SHOW");
    expect(rejectWith("SHOW TABLES", NS)).toBeDefined();
    expect(rejectWith("SHOW TABLES IN other", NS)).toContain("must target");
    expect(staticScopeCheck("SHOW TABLES IN homelab", NS).ok).toBe(true);
    // a table binding cannot list its siblings
    expect(rejectWith("SHOW TABLES IN homelab", TABLE)).toBeDefined();
  });
});

describe("DESCRIBE is scope-checked", () => {
  it("namespace scope must qualify, and stay inside", () => {
    expect(rejectWith("DESCRIBE dns_queries", NS)).toContain("Qualify");
    expect(staticScopeCheck("DESCRIBE homelab.dns_queries", NS).ok).toBe(true);
    expect(rejectWith("DESCRIBE other.secret", NS)).toContain("must target");
  });

  it("table scope may describe only its own table", () => {
    expect(staticScopeCheck("DESCRIBE homelab.dns_queries", TABLE).ok).toBe(true);
    expect(rejectWith("DESCRIBE homelab.syslog", TABLE)).toContain("must name");
    expect(rejectWith("DESCRIBE dns_queries", TABLE)).toContain("must name");
  });
});

describe("data statements pass the lexical layer to the plan check", () => {
  it("legitimate shapes are never false-positives lexically", () => {
    // alias-qualified column references, the shapes that killed the lexical rule
    pass("SELECT d.query_name, d.fields.x FROM homelab.dns_queries AS d");
    pass("SELECT dns_queries.client_hash FROM homelab.dns_queries");
    pass("SELECT * FROM homelab.dns_queries x JOIN homelab.syslog s ON x.a = s.b");
    pass("WITH c AS (SELECT 1 AS a FROM homelab.dns_queries) SELECT a FROM c");
    pass("SELECT * FROM homelab.dns_queries LIMIT 10", TABLE);
  });

  it("out-of-scope references pass lexically and are caught by the plan check", () => {
    // by design: the plan check is the authority for table references
    pass("SELECT * FROM other.secret");
    pass("SELECT (SELECT max(a) FROM other.secret) FROM homelab.dns_queries");
    pass("SELECT * FROM homelab.dns_queries, LATERAL (SELECT * FROM other.secret) s");
    pass("SELECT a FROM homelab.dns_queries UNION ALL SELECT a FROM other.secret");
    pass("SELECT * FROM homelab.syslog", TABLE);
  });
});

describe("EXPLAIN statements are checked via their subject", () => {
  it("classifies and unwraps EXPLAIN", () => {
    expect(statementKind("EXPLAIN SELECT 1 FROM t")).toBe("explain");
    expect(statementKind("EXPLAIN   SELECT 1")).toBe("explain");
    expect(explainSubject("EXPLAIN SELECT a FROM other.secret")).toBe("SELECT a FROM other.secret");
  });

  it("an EXPLAIN of a metadata statement obeys the metadata rules", () => {
    expect(rejectWith(explainSubject("EXPLAIN SHOW DATABASES"))).toContain("SHOW");
    expect(rejectWith(explainSubject("EXPLAIN DESCRIBE other.secret"))).toContain("must target");
  });
});

describe("checkExplainPlan: the authoritative, engine-resolved check", () => {
  // Realistic DataFusion EXPLAIN output shapes.
  const planOf = (...lines: string[]) => lines.join("\n");

  it("accepts plans whose scans are all inside the grant", () => {
    const plan = planOf(
      "logical_plan",
      "Projection: homelab.dns_queries.client_hash",
      "  TableScan: homelab.dns_queries projection=[client_hash, query_name]",
      "physical_plan",
      "  ProjectionExec: expr=[client_hash]",
      "  CoalesceBatchesExec",
      "    RepartitionExec",
      "      DataSourceExec: file_groups={1 group}, projection=[client_hash], file_type=parquet",
    );
    expect(checkExplainPlan(plan, NS).ok).toBe(true);
    expect(checkExplainPlan(plan, TABLE).ok).toBe(true);
  });

  it("rejects scans outside a namespace binding", () => {
    const plan = planOf(
      "TableScan: homelab.dns_queries projection=[client_hash]",
      "TableScan: other.secret projection=[x]",
    );
    expect(checkExplainPlan(plan, NS).ok).toBe(false);
  });

  it("rejects sibling-table scans inside a table binding", () => {
    const plan = planOf("TableScan: homelab.syslog projection=[host]");
    expect(checkExplainPlan(plan, TABLE).ok).toBe(false);
    expect(checkExplainPlan("TableScan: homelab.dns_queries projection=[host]", TABLE).ok).toBe(true);
  });

  it("rejects cross-namespace reads from a subquery, lateral, or UNION", () => {
    expect(
      checkExplainPlan(
        planOf(
          "TableScan: homelab.dns_queries",
          "SubqueryAlias: secret",
          "  TableScan: other.secret",
        ),
        NS,
      ).ok,
    ).toBe(false);
  });

  it("rejects information_schema scans and unparseable plans", () => {
    expect(checkExplainPlan("TableScan: information_schema.tables", NS).ok).toBe(false);
    // a data statement whose plan shows no TableScan at all: refuse rather than guess
    expect(checkExplainPlan("weird plan text with no scan", NS).ok).toBe(false);
    // explicitly marked metadata statements may have no scans
    expect(checkExplainPlan("no scans here", NS, { metadataStatement: true }).ok).toBe(true);
  });

  it("handles the 'TableScan of' variant and quoted plan output", () => {
    expect(checkExplainPlan("TableScan of homelab.dns_queries", NS).ok).toBe(true);
    expect(checkExplainPlan('TableScan: "homelab"."dns_queries"', NS).ok).toBe(true);
  });

  it("bucket scope needs no plan check (the endpoint is already bucket-scoped)", () => {
    expect(checkExplainPlan("anything", BUCKET).ok).toBe(true);
  });
});

describe("extract helpers", () => {
  it("extractDottedRefs finds plain pairs", () => {
    expect(extractDottedRefs("a.b + c.d.e")).toEqual([
      { first: "a", second: "b" },
      { first: "c", second: "d" },
    ]);
  });

  it("extractCteNames tracks WITH names", () => {
    const ctes = extractCteNames("WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b");
    expect(ctes.has("a") && ctes.has("b")).toBe(true);
  });
});
