# pg-pagination-bench

Measure how `LIMIT … OFFSET` and keyset (cursor) pagination behave **by page depth** on your own PostgreSQL — with warm-up, shuffled rounds, server and client time, buffer counts, plan type and a raw CSV you can re-analyse.

> Version 0.1.0 · License: [MIT](LICENSE) · Research behind it: [R-01](https://interlab.app/en/blog/paginaciya-offset-keyset-postgresql)

## Why

"Keyset is faster than OFFSET" is usually stated without numbers for *your* table, index and depth. This tool turns it into a measurement you can repeat:

- the same 20-row page fetched with `OFFSET (N−1)×size` and with `WHERE (created_at, id) < ($1, $2)`;
- both variants are checked to return **identical rows** (`rows_match`) — otherwise the comparison is meaningless;
- server time from `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`, client round-trip time, shared buffers, the scan node chosen by the planner;
- warm-up passes excluded from the summary, depth order shuffled with a fixed seed, variant order alternated per round;
- everything goes to a CSV; the summary (median, p25/p75, min/max) is recomputed from it.

It is the generalised harness behind the InterLAB study **"OFFSET vs keyset in PostgreSQL 17: page depth measured"** (2026-10-12, 1,000,000 rows, 3 runs × 10 rounds): <https://interlab.app/en/blog/paginaciya-offset-keyset-postgresql>. The test suite re-summarises that study's published raw data and asserts the published medians.

## Not in scope

- Not a general load-testing tool: one connection, sequential queries, no concurrency.
- Not a cold-cache benchmark: after warm-up, data is normally in `shared_buffers`; disk reads are not controlled.
- Not a verdict for production: one machine and one dataset show the *shape* of the curve, not your latency budget.
- Benchmarks a table **you are allowed to query**. `setup` drops and recreates the target table — run it only against a disposable database.

## Requirements

- Node.js ≥ 20 — tested on 20.20.2 and 24.18.0
- PostgreSQL — tested on 15.19, 16.14 and 17.11 (`postgres:<version>-alpine` in Docker 29.6); `setup` produces the same data checksum on all three
- One runtime dependency: [`pg`](https://www.npmjs.com/package/pg) 8.23.1 (MIT)

## Quick start (disposable Docker database)

```bash
npm install
docker run --rm -d --name pgpb -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
  -p 55417:5432 postgres:17-alpine -c jit=off
export DATABASE_URL=postgres://postgres:bench@localhost:55417/bench

node bin/pg-pagination-bench.mjs setup                      # 1,000,000 rows + index (created_at, id)
node bin/pg-pagination-bench.mjs run --out raw.csv          # warm-up + 10 rounds
node bin/pg-pagination-bench.mjs summarize raw.csv          # medians, p25/p75, min/max
node bin/pg-pagination-bench.mjs explain --pages 50000      # plans for reading, not for timing
docker stop pgpb
```

`setup` prints a checksum. With the defaults (`--rows 1000000 --seed 0.42`) it must be `48c42fd798489f22b2847d4427ff3f80` — the same data as the InterLAB R-01 study, so buffer counts are directly comparable.

Several independent runs (fresh container each time) are appended with `--run-id 2 --no-header`.

### Your own table

```bash
node bin/pg-pagination-bench.mjs run --table public.events --order occurred_at,id --depths 1,100,1000,5000 --out events.csv
```

Requirements: the order columns must be unique together (add the primary key as the last column) and ideally covered by one composite index in the same order. Identifiers are validated (`[A-Za-z_][A-Za-z0-9_]*`, optional schema); values are always passed as query parameters. `run` and `explain` only execute `SELECT` / `EXPLAIN ANALYZE SELECT`. Still, use a replica or staging copy: deep `OFFSET` pages scan many rows.

## Commands

| Command | What it does |
|---|---|
| `setup` | Drops and recreates `--table` with `--rows` synthetic orders (3 per minute, fixed seed), builds the `(created_at, id)` index, runs `VACUUM (ANALYZE)`, prints count + md5 checksum |
| `run` | Computes keyset boundaries and reference pages, then warm-up (`--warmup`, default 2) and `--rounds` (default 10) measured rounds; writes CSV |
| `summarize <csv> [--json]` | Summary per variant × page and per run |
| `explain [--pages]` | Text `EXPLAIN (ANALYZE, BUFFERS)` for both variants |
| `info` | Server version and settings that change the result (`shared_buffers`, `work_mem`, `jit`, …) |

CSV columns: `run, phase, round, seq, variant, page, offset_rows, server_exec_ms, planning_ms, shared_hit, shared_read, client_ms, rows, rows_match, scan_node`. Rows with `variant=ping` time a `SELECT 1` (connection overhead).

## Example output

A real local run (2026-10-13, Docker Desktop/WSL2 on Windows, `--cpus=2 --memory=2g`, PostgreSQL 17.11, 1 run × 5 rounds — a smoke example, **not** a new study) is in [`examples/sample-output/`](examples/sample-output/). Server-time medians: OFFSET 0.034 → 0.800 → 7.313 → 56.90 → 286.5 ms on pages 1 → 100 → 1,000 → 10,000 → 50,000; keyset 0.036–0.071 ms on the same pages, 23 shared buffers at every depth. Buffer counts are identical to the R-01 study; absolute times differ between runs and machines.

## Tests

```bash
npm test                    # unit tests + R-01 reproduction from the published raw.csv (no database)
PGBENCH_TEST_URL=postgres://postgres:bench@localhost:55418/bench npm run test:integration
```

The integration test drops/creates the table `pgpb_it_orders` in the given database — disposable databases only.

## Interpreting results honestly

- Read medians with their spread; a single run on a shared machine is noisy (R-01 saw 222–273 ms medians for the same deep page across three fresh containers).
- The planner may choose different plans for the same query between runs (R-01: `Index Scan Backward` vs `Bitmap Heap Scan` on the last keyset page). `scan_node` records it.
- Keyset changes the product contract: no "jump to page 7 of 50,000", cursors instead of page numbers. See the study's "What this means for a product" section.

## Citing

Cite the tool via [`CITATION.cff`](CITATION.cff) and the study it reproduces as:

> InterLAB Research (2026). R-01: OFFSET vs keyset pagination in PostgreSQL 17: how response time depends on page depth. Published 12 October 2026. https://interlab.app/en/blog/paginaciya-offset-keyset-postgresql — raw data: https://interlab.app/research/paginaciya-offset-keyset-postgresql/raw.csv

Quote numbers together with their conditions (version, data size, hardware, warm cache).

## References

- PostgreSQL 17 documentation: [LIMIT and OFFSET](https://www.postgresql.org/docs/17/queries-limit.html), [EXPLAIN](https://www.postgresql.org/docs/17/sql-explain.html), [row constructor comparison](https://www.postgresql.org/docs/17/functions-comparisons.html#ROW-WISE-COMPARISON), [indexes and ORDER BY](https://www.postgresql.org/docs/17/indexes-ordering.html).
- G. Marsaglia, “Xorshift RNGs”, *Journal of Statistical Software* 8(14), 1–6, 2003, [doi:10.18637/jss.v008.i14](https://doi.org/10.18637/jss.v008.i14) — the generator (`xorshift32`, shifts 13/17/5) used only to shuffle the depth order.
- Dependency licenses: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Licensing

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 IE Ydyrysov (InterLAB). The single runtime dependency tree (`pg` and its 13 sub-dependencies) is MIT/ISC. The bundled data (`test/fixtures/r01-raw.csv`, `examples/sample-output/`) are synthetic benchmark measurements without personal data.

## Reporting problems

See [CONTRIBUTING.md](CONTRIBUTING.md) (bugs, methodology issues) and [SECURITY.md](SECURITY.md) (vulnerabilities — not via public issues). Changes: [CHANGELOG.md](CHANGELOG.md).


There is no support SLA. If you find a bug or a methodological mistake, open an issue in the repository (once published) with your CSV, `info` output and steps. Do not include credentials or production data in issues.

## Attribution

Built by [InterLAB](https://interlab.app) as the reproducible harness of its research note R-01. Related reading: [keyset pagination recipe](https://interlab.app/en/blog/recept-sql-paginaciya), [reading EXPLAIN ANALYZE](https://interlab.app/en/blog/optimizaciya-zaprosov-explain).
