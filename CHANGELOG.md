# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-10-15

First public version of the harness behind the InterLAB study R-01 “OFFSET vs keyset pagination in PostgreSQL 17” (published 2026-10-12).

### Added
- `setup`: synthetic `orders` table of any size (default 1,000,000 rows, fixed seed) with a data checksum. Defaults reproduce the R-01 dataset (`48c42fd798489f22b2847d4427ff3f80`), verified on PostgreSQL 15.19, 16.14 and 17.11.
- `run`: warm-up excluded from results, depth order shuffled with a fixed seed (`xorshift32`, Marsaglia 2003), alternating variant order, `rows_match` check, server time (`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`), client time, buffers, scan node, connection ping; raw CSV.
- Custom tables: `--table`, `--order` (1–4 DESC columns), `--depths`, `--page-size`; identifiers validated, values parameterised.
- `summarize` (text or `--json`), `explain`, `info`.
- Tests: 19 unit/reproduction tests (the published R-01 `raw.csv` re-summarised to the published medians and buffer counts) and 1 integration test against a disposable PostgreSQL; tested on Node.js 20 and 24.
- `CITATION.cff`, `THIRD_PARTY_LICENSES.md`.

### Known limitations
Single connection, no concurrency; warm cache only; `run.sh`-style multi-run orchestration is left to the shell.
