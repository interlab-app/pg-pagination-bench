# Contributing

Thanks for looking at pg-pagination-bench. This is a small tool maintained on a best-effort basis: there is no support SLA, and responses may take time.

## What is welcome
- Bug reports with a reproducible case: the command you ran, `info` output, PostgreSQL and Node.js versions, and (if possible) the CSV.
- Methodology issues — if you think the measurement is unfair or misleading, explain why; that is the most valuable feedback.
- Small, focused pull requests with tests.

## What is out of scope
Load testing, concurrency, cold-cache control, ORMs or drivers other than `pg`, dashboards. Open an issue first if unsure.

## Development

```bash
npm ci
npm test                       # unit + reproduction tests, no database needed (Node.js 20+)
```

Integration test (needs a **disposable** PostgreSQL — it drops and recreates a table):

```bash
docker run --rm -d --name pgpb-test -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench -p 55418:5432 postgres:17-alpine
PGBENCH_TEST_URL=postgres://postgres:bench@localhost:55418/bench npm run test:integration
docker stop pgpb-test
```

## Verification before a release

```bash
npm ci && npm test                                        # pass 19, skipped 1
PGBENCH_TEST_URL=... npm run test:integration             # pass 1 on PostgreSQL 15, 16 and 17
DATABASE_URL=... node bin/pg-pagination-bench.mjs setup   # checksum 48c42fd798489f22b2847d4427ff3f80
npm audit --omit=dev                                      # 0 vulnerabilities expected
```

## Rules
- Never commit credentials, connection strings with real passwords, `.env` files or production data. Example connection strings use the throwaway password `bench`.
- Keep published numbers traceable to a CSV. Do not change the R-01 fixture.
- By contributing you agree that your contribution is provided under the project’s license once one is published (see README → Licensing).
