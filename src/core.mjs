/*
  Pure helpers of pg-pagination-bench: no database access, no I/O.
  Everything here is covered by test/core.test.mjs.
*/

/** Safe SQL identifier: letters, digits, underscore; optional schema prefix. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/;

export function assertIdent(name, what = "identifier") {
  if (typeof name !== "string" || !IDENT.test(name)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(name)} (allowed: letters, digits, underscore, optional schema.)`);
  }
  return name;
}

/**
 * Build the three statements compared by the benchmark.
 * All order columns are sorted DESC; the keyset predicate is a row comparison,
 * which PostgreSQL can turn into an index condition on a matching composite index.
 */
export function buildQueries({ table = "orders", orderBy = ["created_at", "id"], columns = ["*"], pageSize = 20 } = {}) {
  assertIdent(table, "table");
  if (!Array.isArray(orderBy) || orderBy.length < 1 || orderBy.length > 4) throw new Error("orderBy must list 1–4 columns");
  orderBy.forEach((c) => assertIdent(c, "order column"));
  const cols = columns.length === 1 && columns[0] === "*" ? "*" : columns.map((c) => assertIdent(c, "column")).join(", ");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10000) throw new Error("pageSize must be an integer 1–10000");
  const order = `ORDER BY ${orderBy.map((c) => `${c} DESC`).join(", ")}`;
  const tuple = orderBy.length === 1 ? orderBy[0] : `(${orderBy.join(", ")})`;
  const params = orderBy.map((_, i) => `$${i + 1}`);
  const ptuple = orderBy.length === 1 ? params[0] : `(${params.join(", ")})`;
  return {
    offset: `SELECT ${cols} FROM ${table} ${order} LIMIT ${pageSize} OFFSET $1`,
    first: `SELECT ${cols} FROM ${table} ${order} LIMIT ${pageSize}`,
    keyset: `SELECT ${cols} FROM ${table} WHERE ${tuple} < ${ptuple} ${order} LIMIT ${pageSize}`,
    /** last row of page N−1 = keyset boundary for page N */
    boundary: `SELECT ${orderBy.join(", ")} FROM ${table} ${order} LIMIT 1 OFFSET $1`,
    order,
  };
}

/** Rows skipped by OFFSET to reach a 1-based page. */
export const offsetRows = (page, pageSize) => (page - 1) * pageSize;

/**
 * Deterministic PRNG: xorshift32 (G. Marsaglia, "Xorshift RNGs",
 * Journal of Statistical Software 8(14), 2003 — shifts 13, 17, 5), written from the paper.
 * Only used to shuffle the depth order, not for anything security-related.
 * Same seed → same sequence; seed 0 is replaced (xorshift needs a non-zero state);
 * the first outputs are skipped so that small seeds still give a well-mixed start.
 */
export function xorshift32(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
  for (let i = 0; i < 8; i++) next();
  return next;
}

/** Fisher–Yates shuffle with an injected random source; does not mutate input. */
export function shuffled(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Quantile with linear interpolation between neighbours (same as R-01). */
export function quantile(xs, p) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

/** 3 significant-ish digits: 243.1 / 48.25 / 5.845 / 0.037 */
export const fmt = (x) => (x >= 100 ? x.toFixed(1) : x >= 10 ? x.toFixed(2) : x.toFixed(3));

export function stat(xs) {
  return {
    n: xs.length,
    median: quantile(xs, 0.5),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

export const statText = (s) => `${fmt(s.median)} [${fmt(s.p25)}–${fmt(s.p75)}] (${fmt(s.min)}–${fmt(s.max)})`;

/** First scan node in an EXPLAIN (FORMAT JSON) plan tree, e.g. "Index Scan Backward orders_created_at_id_idx". */
export function scanNode(plan) {
  if (!plan) return "";
  if (/Scan/.test(plan["Node Type"] ?? "")) {
    return [plan["Node Type"], plan["Scan Direction"], plan["Index Name"]].filter(Boolean).join(" ");
  }
  for (const p of plan.Plans ?? []) {
    const s = scanNode(p);
    if (s) return s;
  }
  return "";
}

export const CSV_HEADER = [
  "run", "phase", "round", "seq", "variant", "page", "offset_rows", "server_exec_ms", "planning_ms",
  "shared_hit", "shared_read", "client_ms", "rows", "rows_match", "scan_node",
];

/** One CSV line; strings containing comma/quote are quoted. */
export function csvLine(values) {
  return values
    .map((v) => {
      if (v === undefined || v === null) return "";
      const s = String(v);
      return /[",\n]/.test(s) || (typeof v === "string" && /\s/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). Returns array of objects keyed by header. */
export function parseCsv(text) {
  const records = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") records.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    records.push(row);
  }
  const [head, ...body] = records;
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ""])));
}

/**
 * Aggregate measurement rows (phase=measure) per variant × page.
 * Returns plain data so it can be rendered as text or JSON.
 */
export function summarize(rows) {
  const m = rows.filter((r) => r.phase === "measure");
  const runs = [...new Set(m.map((r) => String(r.run)))];
  const pages = [...new Set(m.filter((r) => r.variant !== "ping").map((r) => +r.page))].sort((a, b) => a - b);
  const pings = m.filter((r) => r.variant === "ping").map((r) => +r.client_ms);
  const points = [];
  for (const page of pages) {
    for (const variant of ["offset", "keyset"]) {
      const g = m.filter((r) => r.variant === variant && +r.page === page);
      if (!g.length) continue;
      points.push({
        variant,
        page,
        offsetRows: +g[0].offset_rows,
        n: g.length,
        server: stat(g.map((r) => +r.server_exec_ms)),
        client: stat(g.map((r) => +r.client_ms)),
        planning: stat(g.map((r) => +r.planning_ms)),
        sharedHit: stat(g.map((r) => +r.shared_hit)),
        sharedRead: stat(g.map((r) => +r.shared_read)),
        scanNodes: [...new Set(g.map((r) => r.scan_node))],
        rowsMismatch: g.filter((r) => String(r.rows_match) === "0").length,
        perRunServerMedian: Object.fromEntries(
          runs.map((run) => [run, quantile(g.filter((r) => String(r.run) === run).map((r) => +r.server_exec_ms), 0.5)]),
        ),
      });
    }
  }
  return {
    runs,
    measureRows: m.length,
    warmupRows: rows.length - m.length,
    rowsMismatch: m.filter((r) => String(r.rows_match) === "0").length,
    ping: pings.length ? stat(pings) : null,
    points,
  };
}

export function renderSummary(s) {
  const out = [];
  out.push(`runs=${s.runs.join(",")}; rows measure=${s.measureRows}, warmup=${s.warmupRows}; rows_match=0: ${s.rowsMismatch}`);
  out.push("format: median [p25–p75] (min–max), ms; buffers — median (min–max)", "");
  if (s.ping) out.push(`ping (SELECT 1), client_ms, n=${s.ping.n}: ${statText(s.ping)}`, "");
  out.push("variant | page | offset_rows | n | server_exec_ms | client_ms | planning_ms | shared_hit | shared_read | scan_node");
  for (const p of s.points) {
    const buf = (b) => `${b.median} (${b.min}–${b.max})`;
    out.push(
      [p.variant, p.page, p.offsetRows, p.n, statText(p.server), statText(p.client), statText(p.planning), buf(p.sharedHit), buf(p.sharedRead), p.scanNodes.join(" / ")].join(" | "),
    );
  }
  out.push("", "median server_exec_ms per run");
  out.push(`variant | page | ${s.runs.map((r) => `run ${r}`).join(" | ")}`);
  for (const p of s.points) out.push([p.variant, p.page, ...s.runs.map((r) => fmt(p.perRunServerMedian[r]))].join(" | "));
  return out.join("\n");
}

/** Parse "1,100,1000" → [1, 100, 1000]; validates positive integers, sorted, unique. */
export function parseDepths(text) {
  const xs = String(text)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);
  if (!xs.length || xs.some((x) => !Number.isInteger(x) || x < 1)) throw new Error(`Invalid depths: ${text}`);
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Highest page that still exists for a table of `rows` rows. */
export const lastPage = (rows, pageSize) => Math.max(1, Math.ceil(rows / pageSize));

/**
 * SQL for the synthetic dataset used by R-01, parameterised by row count.
 * With rows=1_000_000 and seed=0.42 it generates the same data as the R-01 setup.sql;
 * the R-01 data checksum is 48c42fd798489f22b2847d4427ff3f80 (verified by `setup` on PostgreSQL 17).
 * setseed() lasts for the session, so the statements must run on one connection, in order.
 */
export function setupStatements({ table = "orders", rows = 1_000_000, seed = 0.42 } = {}) {
  assertIdent(table, "table");
  if (!Number.isInteger(rows) || rows < 1 || rows > 50_000_000) throw new Error("rows must be an integer 1–50000000");
  if (!(seed >= -1 && seed <= 1)) throw new Error("seed must be within [-1, 1] (PostgreSQL setseed)");
  const minutes = Math.ceil(rows / 3); // three orders per minute, as in R-01
  const idx = `${table.replace(".", "_")}_created_at_id_idx`;
  return [
    `DROP TABLE IF EXISTS ${table}`,
    `CREATE TABLE ${table} (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz    NOT NULL,
    customer   text           NOT NULL,
    total      numeric(12, 2) NOT NULL
)`,
    `SELECT setseed(${seed})`,
    `INSERT INTO ${table} (created_at, customer, total)
SELECT timestamptz '2026-01-01 00:00:00+00' + ((g::bigint * 7919) % ${minutes}) * interval '1 minute',
       'customer-' || (floor(random() * 5000))::int,
       round((100 + random() * 30000)::numeric, 2)
FROM generate_series(1, ${rows}) AS g`,
    `CREATE INDEX ${idx} ON ${table} (created_at, id)`,
    // VACUUM cannot run inside a transaction block: execute statements one by one
    `VACUUM (ANALYZE) ${table}`,
  ];
}

/** Same statements as one psql-ready script. */
export const setupSql = (opts) => setupStatements(opts).join(";\n\n") + ";\n";

export function checksumSql(table = "orders") {
  assertIdent(table, "table");
  return `SELECT count(*)::bigint AS rows,
       md5(string_agg(id || '|' || created_at::text || '|' || customer || '|' || total, ',' ORDER BY id)) AS checksum,
       pg_size_pretty(pg_relation_size('${table}')) AS table_size
FROM ${table}`;
}
