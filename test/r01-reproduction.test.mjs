/*
  Regression against the published InterLAB R-01 study (2026-10-12):
  summarising its raw.csv with this package must give exactly the medians
  printed in the study's summary.txt and article tables.
  Source: https://interlab.app/en/blog/paginaciya-offset-keyset-postgresql
  Raw data: https://interlab.app/research/paginaciya-offset-keyset-postgresql/raw.csv
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fmt, parseCsv, statText, summarize } from "../src/core.mjs";

const rows = parseCsv(readFileSync(new URL("./fixtures/r01-raw.csv", import.meta.url), "utf8"));
const s = summarize(rows);
const point = (variant, page) => s.points.find((p) => p.variant === variant && p.page === page);

test("R-01 fixture shape: 3 runs, 330 measured + 60 warm-up rows, all pages identical", () => {
  assert.deepEqual(s.runs, ["1", "2", "3"]);
  assert.equal(s.measureRows, 330);
  assert.equal(s.warmupRows, 60);
  assert.equal(s.rowsMismatch, 0);
  assert.equal(s.points.length, 10);
  assert.ok(s.points.every((p) => p.n === 30));
});

test("R-01 server medians match the published table", () => {
  const expected = {
    "offset/1": "0.037", "keyset/1": "0.042",
    "offset/100": "0.660", "keyset/100": "0.034",
    "offset/1000": "5.845", "keyset/1000": "0.038",
    "offset/10000": "48.25", "keyset/10000": "0.044",
    "offset/50000": "243.1", "keyset/50000": "0.059",
  };
  for (const [key, value] of Object.entries(expected)) {
    const [variant, page] = key.split("/");
    assert.equal(fmt(point(variant, +page).server.median), value, key);
  }
  assert.equal(statText(point("offset", 50000).server), "243.1 [215.5–281.4] (200.5–503.3)");
});

test("R-01 buffers: OFFSET grows with depth, keyset reads 23 buffers everywhere", () => {
  assert.deepEqual(
    [1, 100, 1000, 10000, 50000].map((p) => point("offset", p).sharedHit.median),
    [23, 2019, 20157, 201535, 1007665],
  );
  assert.ok([1, 100, 1000, 10000, 50000].every((p) => point("keyset", p).sharedHit.median === 23));
  assert.ok(s.points.every((p) => p.sharedRead.max === 0), "all reads served from shared_buffers");
});

test("R-01 per-run medians of the deepest OFFSET page", () => {
  const r = point("offset", 50000).perRunServerMedian;
  assert.deepEqual([fmt(r["1"]), fmt(r["2"]), fmt(r["3"])], ["222.4", "272.7", "245.1"]);
});

test("R-01 keyset plan changed between runs on the last page (documented limitation)", () => {
  assert.deepEqual(point("keyset", 50000).scanNodes.sort(), ["Bitmap Heap Scan", "Index Scan Backward orders_created_at_id_idx"]);
});
