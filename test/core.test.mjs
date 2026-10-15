import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertIdent, buildQueries, csvLine, fmt, lastPage, xorshift32, offsetRows, parseCsv, parseDepths,
  quantile, renderSummary, scanNode, setupSql, shuffled, stat, summarize,
} from "../src/core.mjs";

test("assertIdent accepts plain and schema-qualified names, rejects injection", () => {
  assert.equal(assertIdent("orders"), "orders");
  assert.equal(assertIdent("public.orders"), "public.orders");
  for (const bad of ["orders; DROP TABLE x", "1orders", "a-b", "", "o\"rders", "a.b.c", null]) {
    assert.throws(() => assertIdent(bad), /Invalid/);
  }
});

test("buildQueries: composite DESC order, row-comparison keyset, parameterised offset", () => {
  const q = buildQueries({ table: "orders", orderBy: ["created_at", "id"], pageSize: 20 });
  assert.equal(q.offset, "SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET $1");
  assert.equal(q.first, "SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 20");
  assert.equal(q.keyset, "SELECT * FROM orders WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 20");
  assert.equal(q.boundary, "SELECT created_at, id FROM orders ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET $1");
});

test("buildQueries: single order column has no tuple parentheses", () => {
  const q = buildQueries({ table: "events", orderBy: ["id"], pageSize: 50, columns: ["id", "payload"] });
  assert.equal(q.keyset, "SELECT id, payload FROM events WHERE id < $1 ORDER BY id DESC LIMIT 50");
});

test("buildQueries rejects bad page size and too many order columns", () => {
  assert.throws(() => buildQueries({ pageSize: 0 }), /pageSize/);
  assert.throws(() => buildQueries({ orderBy: ["a", "b", "c", "d", "e"] }), /1–4/);
  assert.throws(() => buildQueries({ orderBy: ["id; --"] }), /Invalid order column/);
});

test("offsetRows and lastPage", () => {
  assert.equal(offsetRows(1, 20), 0);
  assert.equal(offsetRows(50000, 20), 999980);
  assert.equal(lastPage(1_000_000, 20), 50000);
  assert.equal(lastPage(1_000_001, 20), 50001);
  assert.equal(lastPage(0, 20), 1);
});

test("xorshift32 is deterministic and shuffled keeps elements", () => {
  const a = xorshift32(42);
  const b = xorshift32(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const input = [1, 100, 1000, 10000, 50000];
  const out = shuffled(input, xorshift32(20261013));
  assert.deepEqual([...out].sort((x, y) => x - y), input);
  assert.deepEqual(input, [1, 100, 1000, 10000, 50000], "input not mutated");
  assert.deepEqual(out, shuffled(input, xorshift32(20261013)), "same seed → same order");
});

test("quantile uses linear interpolation", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([4, 1, 3, 2], 0.25), 1.75);
  assert.equal(quantile([7], 0.75), 7);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  const s = stat([1, 2, 3, 4, 100]);
  assert.deepEqual([s.n, s.median, s.min, s.max], [5, 3, 1, 100]);
});

test("fmt keeps ~3–4 significant digits like the published tables", () => {
  assert.equal(fmt(243.0567), "243.1");
  assert.equal(fmt(48.2521), "48.25");
  assert.equal(fmt(5.8449), "5.845");
  assert.equal(fmt(0.037), "0.037");
});

test("scanNode finds the first scan in a nested plan", () => {
  const plan = { "Node Type": "Limit", Plans: [{ "Node Type": "Sort", Plans: [{ "Node Type": "Bitmap Heap Scan", Plans: [] }] }] };
  assert.equal(scanNode(plan), "Bitmap Heap Scan");
  const idx = { "Node Type": "Limit", Plans: [{ "Node Type": "Index Scan", "Scan Direction": "Backward", "Index Name": "i" }] };
  assert.equal(scanNode(idx), "Index Scan Backward i");
  assert.equal(scanNode({ "Node Type": "Result" }), "");
});

test("csvLine quotes values with spaces/commas/quotes and parseCsv reverses it", () => {
  const line = csvLine([1, "measure", 2, "Index Scan Backward x", 'a "q", b', "", null]);
  assert.equal(line, '1,measure,2,"Index Scan Backward x","a ""q"", b",,');
  const rows = parseCsv(`h1,h2,h3,h4,h5,h6,h7\r\n${line}\r\n`);
  assert.deepEqual(rows, [{ h1: "1", h2: "measure", h3: "2", h4: "Index Scan Backward x", h5: 'a "q", b', h6: "", h7: "" }]);
});

test("parseDepths validates, deduplicates and sorts", () => {
  assert.deepEqual(parseDepths("1000, 1,100,1"), [1, 100, 1000]);
  assert.throws(() => parseDepths("0,5"), /Invalid depths/);
  assert.throws(() => parseDepths("abc"), /Invalid depths/);
});

test("setupSql: R-01 defaults, three rows per minute, rejects bad input", () => {
  const sql = setupSql();
  assert.match(sql, /SELECT setseed\(0\.42\);/);
  assert.match(sql, /% 333334\)/);
  assert.match(sql, /generate_series\(1, 1000000\)/);
  assert.match(sql, /CREATE INDEX orders_created_at_id_idx ON orders \(created_at, id\);/);
  assert.match(setupSql({ rows: 30000 }), /% 10000\)/);
  assert.throws(() => setupSql({ rows: 0 }), /rows/);
  assert.throws(() => setupSql({ seed: 2 }), /seed/);
  assert.throws(() => setupSql({ table: "x;drop" }), /Invalid table/);
});

test("summarize ignores warm-up rows and counts mismatches", () => {
  const rows = [
    { run: "1", phase: "warmup", variant: "offset", page: "2", offset_rows: "20", server_exec_ms: "99", client_ms: "99", planning_ms: "1", shared_hit: "5", shared_read: "0", rows_match: "1", scan_node: "S" },
    { run: "1", phase: "measure", variant: "ping", page: "0", client_ms: "0.4" },
    { run: "1", phase: "measure", variant: "offset", page: "2", offset_rows: "20", server_exec_ms: "1", client_ms: "2", planning_ms: "0.1", shared_hit: "5", shared_read: "0", rows_match: "1", scan_node: "S" },
    { run: "1", phase: "measure", variant: "offset", page: "2", offset_rows: "20", server_exec_ms: "3", client_ms: "4", planning_ms: "0.1", shared_hit: "5", shared_read: "0", rows_match: "0", scan_node: "S" },
  ];
  const s = summarize(rows);
  assert.equal(s.measureRows, 3);
  assert.equal(s.warmupRows, 1);
  assert.equal(s.rowsMismatch, 1);
  assert.equal(s.points.length, 1);
  assert.equal(s.points[0].server.median, 2);
  assert.equal(s.ping.n, 1);
  assert.match(renderSummary(s), /offset \| 2 \| 20 \| 2 \| 2\.000/);
});

test("xorshift32: seed 0 is not degenerate, outputs are spread over [0, 1)", () => {
  const r = xorshift32(0);
  const xs = Array.from({ length: 10000 }, () => r());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(xs).size > 9990, "no short cycle");
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean}`);
  assert.notDeepEqual(shuffled([1, 2, 3, 4, 5], xorshift32(1)), shuffled([1, 2, 3, 4, 5], xorshift32(2)));
});
