#!/usr/bin/env node
/*
  pg-pagination-bench — compare LIMIT/OFFSET and keyset pagination by page depth.

  Commands:
    setup      create the synthetic table (DROPs and recreates --table!) and print its checksum
    run        measure; CSV to stdout (or --out file)
    summarize  medians/percentiles from a CSV file
    explain    EXPLAIN (ANALYZE, BUFFERS) text for the given pages
    info       server version and settings that affect the result

  Connection: --url or DATABASE_URL (e.g. postgres://postgres:bench@localhost:55417/bench).
*/
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertIdent, checksumSql, CSV_HEADER, csvLine, lastPage, parseCsv, parseDepths, renderSummary, setupStatements, summarize } from "../src/core.mjs";

const HELP = `Usage: pg-pagination-bench <command> [options]

Commands:
  setup       Create the synthetic table and index (DROPS --table first), print row count and checksum
  run         Run warm-up + measured rounds, write CSV
  summarize   Summarise a CSV produced by "run": pg-pagination-bench summarize raw.csv [--json]
  explain     Print EXPLAIN (ANALYZE, BUFFERS) for --pages
  info        Print server version and relevant settings

Options:
  --url <conn>          connection string (default: $DATABASE_URL)
  --table <name>        table (default: orders)
  --order <a,b>         order columns, all DESC, must be unique together (default: created_at,id)
  --rows <n>            setup: rows to generate (default: 1000000)
  --seed <x>            setup: setseed value in [-1, 1] (default: 0.42)
  --depths <list>       run: pages to measure (default: 1,100,1000,10000,50000 capped by table size)
  --page-size <n>       rows per page (default: 20)
  --rounds <n>          run: measured rounds (default: 10)
  --warmup <n>          run: warm-up passes, not summarised (default: 2)
  --run-id <n>          run: value of the "run" column (default: 1)
  --shuffle-seed <n>    run: seed for the depth order (default: 20261012)
  --pages <list>        explain: pages (default: largest two depths)
  --out <file>          run: write CSV to file instead of stdout
  --no-header           run: omit CSV header (to append several runs)
  --json                summarize: JSON instead of text
  -h, --help`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    table: { type: "string", default: "orders" },
    order: { type: "string", default: "created_at,id" },
    rows: { type: "string", default: "1000000" },
    seed: { type: "string", default: "0.42" },
    depths: { type: "string" },
    "page-size": { type: "string", default: "20" },
    rounds: { type: "string", default: "10" },
    warmup: { type: "string", default: "2" },
    "run-id": { type: "string", default: "1" },
    "shuffle-seed": { type: "string", default: "20261012" },
    pages: { type: "string" },
    out: { type: "string" },
    "no-header": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, file] = positionals;
if (values.help || !cmd) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const int = (name) => {
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

async function withClient(fn) {
  const url = values.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error("No connection: pass --url or set DATABASE_URL");
  const { connect } = await import("../src/bench.mjs");
  const client = await connect(url);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let table, orderBy, pageSize;
try {
  table = assertIdent(values.table, "table");
  orderBy = values.order.split(",").map((s) => assertIdent(s.trim(), "order column"));
  pageSize = int("page-size");
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

async function tableRows(client) {
  const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
  return Number(rows[0].n);
}

async function defaultDepths(client) {
  const max = lastPage(await tableRows(client), pageSize);
  const base = [1, 100, 1000, 10000, 50000].filter((d) => d < max);
  return [...base, max].filter((d, i, a) => a.indexOf(d) === i);
}

try {
  if (cmd === "summarize") {
    if (!file) throw new Error("summarize needs a CSV path");
    const s = summarize(parseCsv(readFileSync(file, "utf8")));
    console.log(values.json ? JSON.stringify(s, null, 2) : renderSummary(s));
  } else if (cmd === "setup") {
    const statements = setupStatements({ table, rows: int("rows"), seed: Number(values.seed) });
    await withClient(async (client) => {
      for (const sql of statements) await client.query(sql);
      const { rows } = await client.query(checksumSql(table));
      console.log(`${rows[0].rows} rows | md5 ${rows[0].checksum} | table ${rows[0].table_size}`);
    });
  } else if (cmd === "run") {
    await withClient(async (client) => {
      const depths = values.depths ? parseDepths(values.depths) : await defaultDepths(client);
      const lines = [];
      const write = values.out ? (l) => lines.push(l) : (l) => console.log(l);
      if (!values["no-header"]) write(CSV_HEADER.join(","));
      const { run } = await import("../src/bench.mjs");
      await run(
        client,
        { depths, pageSize, rounds: int("rounds"), warmup: int("warmup"), seed: int("shuffle-seed"), runId: int("run-id"), table, orderBy },
        (row) => write(csvLine(row)),
      );
      if (values.out) writeFileSync(values.out, lines.join("\n") + "\n");
    });
  } else if (cmd === "explain") {
    await withClient(async (client) => {
      const pages = values.pages ? parseDepths(values.pages) : (await defaultDepths(client)).slice(-2);
      const { explain } = await import("../src/bench.mjs");
      for (const e of await explain(client, { pageSize, table, orderBy }, pages)) {
        console.log(`-- ${e.variant}, page ${e.page} (page size ${pageSize})\n-- ${e.sql}\n-- params: ${JSON.stringify(e.params)}\n\n${e.plan}\n`);
      }
    });
  } else if (cmd === "info") {
    await withClient(async (client) => {
      const { serverInfo } = await import("../src/bench.mjs");
      console.log(await serverInfo(client));
      console.log(`${table}: ${await tableRows(client)} rows`);
    });
  } else {
    throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
