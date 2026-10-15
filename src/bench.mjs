/*
  Database side of pg-pagination-bench. Uses one connection, parameterised queries only.
  Read-only against the benchmarked table (SELECT / EXPLAIN ANALYZE of SELECT).
*/
import { performance } from "node:perf_hooks";
import pg from "pg";
import { buildQueries, xorshift32, offsetRows, scanNode, shuffled } from "./core.mjs";

/* timestamptz (OID 1184) as text: JS Date drops microseconds and would shift the keyset boundary */
const TEXT_TIMESTAMPTZ = {
  getTypeParser: (oid, format) => (oid === 1184 ? (v) => v : pg.types.getTypeParser(oid, format)),
};

export async function connect(connectionString) {
  const client = new pg.Client({ connectionString, types: TEXT_TIMESTAMPTZ });
  await client.connect();
  return client;
}

/** Keyset boundaries (last row of page N−1) and reference ids of every measured page. */
export async function prepare(client, { depths, pageSize, table, orderBy }) {
  const q = buildQueries({ table, orderBy, pageSize });
  const cursors = new Map();
  const reference = new Map();
  for (const page of depths) {
    if (page > 1) {
      const { rows } = await client.query(q.boundary, [offsetRows(page, pageSize) - 1]);
      if (!rows.length) throw new Error(`Page ${page} does not exist: the table has fewer than ${offsetRows(page, pageSize)} rows`);
      cursors.set(page, orderBy.map((c) => rows[0][c]));
    }
    const { rows } = await client.query(q.offset, [offsetRows(page, pageSize)]);
    reference.set(page, rowKey(rows, orderBy));
  }
  return { q, cursors, reference };
}

/* page identity = ordered tuple of order-column values (works without an "id" column) */
const rowKey = (rows, orderBy) => rows.map((r) => orderBy.map((c) => r[c]).join("|")).join(",");

export function statement(prep, variant, page, pageSize) {
  if (variant === "offset") return [prep.q.offset, [offsetRows(page, pageSize)]];
  if (page === 1) return [prep.q.first, []];
  return [prep.q.keyset, prep.cursors.get(page)];
}

export async function measure(client, prep, variant, page, { pageSize, orderBy }) {
  const [sql, params] = statement(prep, variant, page, pageSize);
  const ex = await client.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`, params);
  const plan = ex.rows[0]["QUERY PLAN"][0];
  const t0 = performance.now();
  const res = await client.query(sql, params);
  const clientMs = performance.now() - t0;
  return {
    server_exec_ms: plan["Execution Time"],
    planning_ms: plan["Planning Time"],
    shared_hit: plan.Plan["Shared Hit Blocks"],
    shared_read: plan.Plan["Shared Read Blocks"],
    client_ms: clientMs,
    rows: res.rows.length,
    rows_match: rowKey(res.rows, orderBy) === prep.reference.get(page) ? 1 : 0,
    scan_node: scanNode(plan.Plan),
  };
}

/**
 * Full protocol of one run: warm-up (not summarised) + rounds with shuffled depth order
 * and alternating variant order. Calls onRow for every CSV row.
 */
export async function run(client, opts, onRow) {
  const { depths, pageSize, rounds, warmup, seed, runId, table, orderBy } = opts;
  const prep = await prepare(client, { depths, pageSize, table, orderBy });
  let seq = 0;
  const emit = (phase, round, variant, page, m) =>
    onRow([runId, phase, round, ++seq, variant, page, page === 0 ? 0 : offsetRows(page, pageSize),
      m.server_exec_ms ?? "", m.planning_ms ?? "", m.shared_hit ?? "", m.shared_read ?? "",
      m.client_ms.toFixed(3), m.rows ?? "", m.rows_match ?? "", m.scan_node ?? ""]);

  for (let w = 1; w <= warmup; w++) {
    for (const page of depths) for (const variant of ["offset", "keyset"]) emit("warmup", w, variant, page, await measure(client, prep, variant, page, opts));
  }
  const rnd = xorshift32(seed + runId);
  for (let round = 1; round <= rounds; round++) {
    const t0 = performance.now();
    await client.query("SELECT 1");
    emit("measure", round, "ping", 0, { client_ms: performance.now() - t0 });
    const variants = round % 2 === 0 ? ["offset", "keyset"] : ["keyset", "offset"];
    for (const page of shuffled(depths, rnd)) {
      for (const variant of variants) emit("measure", round, variant, page, await measure(client, prep, variant, page, opts));
    }
  }
}

/** Text EXPLAIN (ANALYZE, BUFFERS) for given pages — for reading plans, not for timing tables. */
export async function explain(client, opts, pages) {
  const prep = await prepare(client, { ...opts, depths: pages });
  const out = [];
  for (const page of pages) {
    for (const variant of ["offset", "keyset"]) {
      const [sql, params] = statement(prep, variant, page, opts.pageSize);
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      out.push({ variant, page, sql, params, plan: rows.map((r) => r["QUERY PLAN"]).join("\n") });
    }
  }
  return out;
}

export async function serverInfo(client) {
  const lines = [(await client.query("SELECT version()")).rows[0].version];
  for (const s of ["shared_buffers", "work_mem", "effective_cache_size", "random_page_cost", "jit", "max_parallel_workers_per_gather"]) {
    lines.push(`${s} = ${Object.values((await client.query(`SHOW ${s}`)).rows[0])[0]}`);
  }
  return lines.join("\n");
}
