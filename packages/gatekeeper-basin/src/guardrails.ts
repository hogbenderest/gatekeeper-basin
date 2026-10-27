// Basin SQL lexical guardrails, vendored from the basin-flowviz project (MIT,
// (c) Ian Hogben), where they were extracted from the audited console path and
// live-verified against Basin SQL. Audit lineage:
// run 1 (2026-10-24) comment/string handling and statement allowlist; run 2
// (2026-10-24) strict LIMIT parsing; run 3 review re-applied both after the guardrail
// extraction. Do not loosen these rules without re-running the bypass corpus in
// __tests__/guardrails.test.ts.
//
// The checks always run on the same text that is forwarded to the engine: comments are
// stripped first, and string literal *contents* are neutralized for structural analysis
// while the forwarded query keeps the literals themselves. No comment or literal can
// hide live SQL from the checks.

export const MAX_QUERY_CHARS = 10_000;
const MAX_LIMIT = 2000;
const MAX_OFFSET = 20_000;
const DEFAULT_LIMIT = 200;

const SQL_WRITE_KEYWORDS =
  /\b(insert|update|delete|create|drop|alter|grant|revoke|truncate|copy|attach|pragma)\b/i;
const LIMIT_ANY_RE = /\blimit\s+(\d+)\b/i;
const OFFSET_ANY_RE = /\boffset\s+(\d+)\b/i;

/** The number of rows the guardrail appends a LIMIT for, when a query carries none. */
export const defaultRowLimit = DEFAULT_LIMIT;
/** The largest row count a single query may request. */
export const maxRowLimit = MAX_LIMIT;

// Remove -- and /* */ comments that are OUTSIDE single-quoted strings ('' is the in-string
// escape). Comment-aware, string-aware: comment markers inside strings are data, not
// comments; -- inside a block comment is comment text.
export function stripSqlComments(q: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < q.length) {
    const c = q[i];
    if (inString) {
      if (c === "'") {
        if (q[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        inString = false;
      }
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "-" && q[i + 1] === "-") {
      while (i < q.length && q[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && q[i + 1] === "*") {
      i += 2;
      while (i < q.length && !(q[i] === "*" && q[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Blank out single-quoted string CONTENTS for structural analysis. The forwarded query
// keeps the literals; the analysis cannot be fooled by text inside them.
export function neutralizeStrings(s: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < s.length) {
    const c = s[i];
    if (inString) {
      if (c === "'") {
        if (s[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
        out += "'";
      }
      i++;
      continue;
    }
    if (c === "'") {
      inString = true;
      out += "'";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export type SqlCheck =
  | { ok: true; query: string }
  | { ok: false; error: string };

/**
 * Lexical pre-flight every query passes before it reaches the engine: size cap, single
 * statement, read-only statement allowlist, write-keyword blocklist, strict LIMIT parsing.
 *
 * Additionally rejects `EXPLAIN ANALYZE`, which executes the query (billing a scan and
 * returning real rows) rather than planning it: the free preflight is bare `EXPLAIN` only.
 */
export function sanitizeSql(raw: string): SqlCheck {
  if (raw.length > MAX_QUERY_CHARS)
    return { ok: false, error: "Query too long (10 KB cap)." };
  const bare = stripSqlComments(raw).trim().replace(/;+\s*$/, "");
  const analysis = neutralizeStrings(bare).trim();
  if (!analysis) return { ok: false, error: "Empty query." };
  if (analysis.includes(";"))
    return { ok: false, error: "Only one statement at a time (stray semicolon)." };
  const head = analysis.replace(/^\(+\s*/, "");
  if (!/^(select|show|explain|with|describe)\b/i.test(head))
    return {
      ok: false,
      error: "Only SELECT / SHOW / EXPLAIN / DESCRIBE queries are allowed.",
    };
  if (SQL_WRITE_KEYWORDS.test(analysis))
    return { ok: false, error: "Write keywords are not allowed." };
  if (/^explain[\s(]*analyze\b/i.test(head))
    return {
      ok: false,
      error:
        "EXPLAIN ANALYZE (including parenthesized option lists) runs the query; use EXPLAIN for the free plan.",
    };
  // Forward the comment-stripped text: the checker and the backend see the same string.
  let q = bare;
  if (/^(select|with)\b/i.test(head)) {
    // Strict LIMIT validation: the engine's grammar accepts forms a simpler regex did not
    // model - the MySQL comma form "LIMIT offset, count" (the guard validated the first
    // number while the engine used the second as the count), scientific notation, and
    // LIMIT ALL. Any LIMIT expression that is not plain integers in an accepted shape is
    // rejected outright (run-2 audit finding).
    const LIMIT_CLAUSE_RE = /\blimit\b([^()]*)/gi;
    let lm: RegExpExecArray | null;
    while ((lm = LIMIT_CLAUSE_RE.exec(analysis)) !== null) {
      const cm = lm[1]
        .trim()
        .match(/^(\d+)(?:\s*,\s*(\d+))?(?:\s+offset\s+(\d+))?\s*$/i);
      if (!cm)
        return { ok: false, error: "Unsupported LIMIT syntax in the query." };
      const count = cm[2] ? parseInt(cm[2], 10) : parseInt(cm[1], 10);
      if (count > MAX_LIMIT)
        return { ok: false, error: `LIMIT is capped at ${MAX_LIMIT}.` };
      if (cm[2] && parseInt(cm[1], 10) > MAX_OFFSET)
        return { ok: false, error: `OFFSET is capped at ${MAX_OFFSET}.` };
      if (cm[3] && parseInt(cm[3], 10) > MAX_OFFSET)
        return { ok: false, error: `OFFSET is capped at ${MAX_OFFSET}.` };
    }
    const off = analysis.match(OFFSET_ANY_RE);
    if (off && parseInt(off[1], 10) > MAX_OFFSET)
      return { ok: false, error: `OFFSET is capped at ${MAX_OFFSET}.` };
    // No LIMIT anywhere in the analyzed text: append one to the stripped query (trailing
    // comments are already gone, so it always applies).
    if (!LIMIT_ANY_RE.test(analysis)) q = `${bare} LIMIT ${DEFAULT_LIMIT}`;
    // If a LIMIT exists only inside a subquery/CTE, the outer query stays unbounded here;
    // Basin SQL's server default caps returned rows.
  }
  return { ok: true, query: q };
}

/** The query text scope analysis runs over: comment-stripped, literals neutralized. */
export function analysisText(raw: string): string {
  return neutralizeStrings(stripSqlComments(raw)).trim();
}

/** Escape a string literal for embedding into generated SQL: '' doubling only. */
export function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
