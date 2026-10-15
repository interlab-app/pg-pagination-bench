/*
  Integration test against a disposable PostgreSQL. Skipped unless PGBENCH_TEST_URL is set.
  It DROPS and recreates the table "pgpb_it_orders" in that database — never point it at real data.

    docker run --rm -d --name pgpb-test -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench -p 55418:5432 postgres:17-alpine
    PGBENCH_TEST_URL=postgres://postgres:bench@localhost:55418/bench npm run test:integration
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { checksumSql, setupStatements, summarize } from "../src/core.mjs";

const URL_ = process.env.PGBENCH_TEST_URL;
const TABLE = "pgpb_it_orders";

test("end-to-end: setup → run → summarize on 30 000 rows", { skip: !URL_ && "PGBENCH_TEST_URL not set" }, async () => {
  const { connect, run, explain } = await import("../src/bench.mjs");
  const client = await connect(URL_);
  try {
    for (const sql of setupStatements({ table: TABLE, rows: 30000 })) await client.query(sql);
    const { rows: chk } = await client.query(checksumSql(TABLE));
    assert.equal(Number(chk[0].rows), 30000);

    // same seed and size → same data: the checksum is stable across setups
    for (const sql of setupStatements({ table: TABLE, rows: 30000 })) await client.query(sql);
    const { rows: chk2 } = await client.query(checksumSql(TABLE));
    assert.equal(chk2[0].checksum, chk[0].checksum);

    const csv = [];
    await run(
      client,
      { depths: [1, 50, 1500], pageSize: 20, rounds: 3, warmup: 1, seed: 1, runId: 1, table: TABLE, orderBy: ["created_at", "id"] },
      (row) => csv.push(row),
    );
    const keys = ["run", "phase", "round", "seq", "variant", "page", "offset_rows", "server_exec_ms", "planning_ms", "shared_hit", "shared_read", "client_ms", "rows", "rows_match", "scan_node"];
    const objs = csv.map((r) => Object.fromEntries(keys.map((k, i) => [k, String(r[i])])));
    const s = summarize(objs);
    assert.equal(s.rowsMismatch, 0, "keyset and OFFSET return identical pages");
    assert.equal(s.points.length, 6);
    const off = (p) => s.points.find((x) => x.variant === "offset" && x.page === p).sharedHit.median;
    const key = (p) => s.points.find((x) => x.variant === "keyset" && x.page === p).sharedHit.median;
    assert.ok(off(1500) > off(50), "OFFSET touches more buffers deeper");
    assert.ok(key(1500) <= key(1) * 3, "keyset buffer count stays near the first page");

    const plans = await explain(client, { pageSize: 20, table: TABLE, orderBy: ["created_at", "id"] }, [1500]);
    assert.equal(plans.length, 2);
    assert.match(plans[0].plan, /Execution Time/);
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
    await client.end();
  }
});
