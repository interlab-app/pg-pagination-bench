#!/usr/bin/env bash
# Full local example: disposable PostgreSQL 17 in Docker → setup → run → summarize → explain.
# Produces examples/sample-output/*. Needs Docker and Node.js >= 20; run from the package root after npm install.
set -euo pipefail
NAME=${NAME:-pgpb-example}
PORT=${PORT:-55418}
OUT=${OUT:-examples/sample-output}
docker run --rm -d --name "$NAME" --cpus=2 --memory=2g -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
  -p "$PORT:5432" postgres:17-alpine -c jit=off > /dev/null
trap 'docker stop "$NAME" > /dev/null' EXIT
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 > /dev/null 2>&1 && break; sleep 1; done
export DATABASE_URL="postgres://postgres:bench@localhost:$PORT/bench"
mkdir -p "$OUT"
node bin/pg-pagination-bench.mjs setup | tee "$OUT/setup.txt"
node bin/pg-pagination-bench.mjs run --rounds "${ROUNDS:-5}" --out "$OUT/raw.local-example.csv"
node bin/pg-pagination-bench.mjs summarize "$OUT/raw.local-example.csv" | tee "$OUT/summary.txt"
node bin/pg-pagination-bench.mjs info > "$OUT/info.txt"
node bin/pg-pagination-bench.mjs explain --pages 50000 > "$OUT/explain-p50000.txt"
