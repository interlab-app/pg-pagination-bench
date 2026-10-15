# Security

## Scope
pg-pagination-bench runs `SELECT` / `EXPLAIN ANALYZE SELECT` queries for `run` and `explain`. `setup` and the integration test **drop and recreate** a table — use them only against disposable databases. Table and column names are validated; values are always passed as query parameters.

## Reporting a vulnerability
Please do **not** open a public issue for a security problem. Use GitHub’s private vulnerability reporting for this repository (Security → Report a vulnerability) or email hello@interlab.app with “pg-pagination-bench security” in the subject.

There is no bug bounty and no guaranteed response time; reports are handled on a best-effort basis. Supported version: the latest release only.
