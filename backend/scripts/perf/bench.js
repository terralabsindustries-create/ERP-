#!/usr/bin/env node
/**
 * API latency benchmark.
 *
 *   node scripts/perf/bench.js [--rtt 80] [--samples 30] [--out report.json]
 *
 * Seeds a throwaway database on the LOCAL MongoDB (never MONGODB_URI), starts
 * the Express app on an ephemeral port, and puts a TCP proxy between the app
 * and mongod that delays every chunk by rtt/2 in each direction. That models an
 * app server talking to a database in another region (e.g. EC2 ↔ Atlas), which
 * is where per-request DB round trips turn into seconds.
 *
 * For each endpoint it reports P50/P95/P99 wall time, the number of MongoDB
 * commands one request issues (round trips) and the JSON payload size.
 * The database is dropped at the end.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bench-jwt-secret';
process.env.BCRYPT_SALT_ROUNDS = '4';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.PERF_LOG = process.env.PERF_LOG || 'off';
// Model production: the entitlement cache is on outside tests (see subscriptionService).
process.env.ENTITLEMENT_CACHE_MS = process.env.ENTITLEMENT_CACHE_MS || '60000';

const net = require('net');
const http = require('http');
const mongoose = require('mongoose');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const RTT = Number(arg('rtt', 80));
const SAMPLES = Number(arg('samples', 30));
const OUT = arg('out', null);
const MONGO_HOST = '127.0.0.1';
const MONGO_PORT = 27017;

if (!console.__quiet) {
  const orig = console.log;
  console.log = (...a) => { if (String(a[0]).startsWith('[bench]')) orig(...a); };
  console.warn = () => {};
  console.info = () => {};
  console.__orig = orig;
}
const log = (...a) => console.log('[bench]', ...a);

function startLatencyProxy(rtt) {
  const half = rtt / 2;
  const server = net.createServer((client) => {
    const upstream = net.connect(MONGO_PORT, MONGO_HOST);
    // Every chunk is delivered `half` ms after it arrived, in order, without
    // holding back the chunks behind it: latency, not a bandwidth limit.
    const pipe = (from, to) => from.on('data', (chunk) => {
      setTimeout(() => { if (!to.destroyed) to.write(chunk); }, half);
    });
    pipe(client, upstream);
    pipe(upstream, client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const { seed } = require('./seed');

const ENDPOINTS = [
  ['auth/me', '/api/auth/me'],
  ['customers list (100)', '/api/customers?status=all&limit=100'],
  ['customers search', '/api/customers?status=all&limit=20&search=Bench%20Customer%2012'],
  ['jobs list (limit 500, as Jobs page)', '/api/jobs?limit=500'],
  ['jobs list (limit 25)', '/api/jobs?limit=25'],
  ['job board (board + dashboard)', '/api/jobs/board'],
  ['counter jobs (active)', '/api/walk-in-jobs?view=active&limit=100'],
  ['notifications', '/api/notifications'],
  ['razorpay plans', '/api/razorpay/plans'],
  ['razorpay subscription', '/api/razorpay/subscription'],
  ['dashboard stats', '/api/dashboard/stats'],
  ['invoices list (25)', '/api/invoices?limit=25'],
  ['global search', '/api/search?q=Bench%20Customer%2012'],
  ['customers page (server, 50 by name)', '/api/customers?status=all&limit=50&sortBy=name&sortOrder=asc'],
  ['customers summary (header + tabs)', '/api/customers/stats/summary'],
  ['jobs page (server, 25, stage filter)', '/api/jobs?limit=25&stage=open'],
  ['jobs summary (header)', '/api/jobs/stats/summary'],
  ['GST report (month)', `/api/gst-reports?month=${new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 7)}`]
];

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' }, agent: false }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes }));
    });
    req.on('error', reject);
    req.end();
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function main() {
  const proxy = await startLatencyProxy(RTT);
  const dbName = `terralabs_perf_${process.pid}_${Date.now()}`;
  const uri = `mongodb://127.0.0.1:${proxy.address().port}/${dbName}?directConnection=true`;
  await mongoose.connect(uri, { monitorCommands: true });
  log(`db=${dbName} simulated RTT=${RTT}ms samples=${SAMPLES}`);

  let commands = 0;
  mongoose.connection.getClient().on('commandStarted', () => { commands += 1; });

  const t = Date.now();
  const org = await seed();
  log(`seeded in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  const app = require('../../src/app');
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const token = org.tokens.admin;

  const results = [];
  for (const [label, path] of ENDPOINTS) {
    await get(port, path, token); // warm-up
    const times = [];
    let status; let bytes; let cmds = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const before = commands;
      const r = await get(port, path, token);
      cmds += commands - before;
      times.push(r.ms); status = r.status; bytes = r.bytes;
    }
    times.sort((a, b) => a - b);
    const row = {
      endpoint: label, path, status, p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1), p99: +pct(times, 99).toFixed(1),
      dbCommandsPerRequest: +(cmds / SAMPLES).toFixed(1), payloadKB: +(bytes / 1024).toFixed(1)
    };
    results.push(row);
    log(`${label.padEnd(38)} ${String(status).padEnd(4)} p50 ${String(row.p50).padStart(7)}ms  p95 ${String(row.p95).padStart(7)}ms  p99 ${String(row.p99).padStart(7)}ms  db ${String(row.dbCommandsPerRequest).padStart(5)}  ${String(row.payloadKB).padStart(8)} KB`);
  }

  // Page-level: how the Customers page fetched every customer before (one page
  // of 100 after another) and now (first page, then the rest 4 at a time).
  const pageScenario = async (label, batched) => {
    const times = [];
    for (let run = 0; run < 3; run++) {
      const t0 = Date.now();
      const first = await get(port, '/api/customers?status=all&limit=100&page=1', token);
      const pages = 15;
      if (batched) {
        for (let start = 2; start <= pages; start += 4) {
          await Promise.all(Array.from({ length: Math.min(4, pages - start + 1) }, (_, i) => get(port, `/api/customers?status=all&limit=100&page=${start + i}`, token)));
        }
      } else {
        for (let page = 2; page <= pages; page++) await get(port, `/api/customers?status=all&limit=100&page=${page}`, token);
      }
      if (first.status !== 200) throw new Error('customers page failed');
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const row = { endpoint: label, p50: times[1], min: times[0], max: times[2] };
    results.push(row);
    log(`${label.padEnd(38)}      p50 ${row.p50}ms (min ${row.min}, max ${row.max}) over 3 runs`);
  };
  await pageScenario('Customers page, 1500 rows, sequential', false);
  await pageScenario('Customers page, 1500 rows, batched x4', true);

  // Concurrency: 8 in-flight requests of the Jobs page list, as several open tabs/users would make.
  const conc = [];
  const tc = Date.now();
  await Promise.all(Array.from({ length: 8 }, async () => { for (let i = 0; i < 5; i++) conc.push((await get(port, '/api/jobs?limit=25', token)).ms); }));
  conc.sort((a, b) => a - b);
  const concurrency = { endpoint: 'jobs list (25) x8 concurrent', p50: +pct(conc, 50).toFixed(1), p95: +pct(conc, 95).toFixed(1), p99: +pct(conc, 99).toFixed(1), wallMs: Date.now() - tc };
  log(`${concurrency.endpoint.padEnd(38)}      p50 ${concurrency.p50}ms p95 ${concurrency.p95}ms p99 ${concurrency.p99}ms`);

  if (OUT) require('fs').writeFileSync(OUT, JSON.stringify({ rttMs: RTT, samples: SAMPLES, node: process.version, at: new Date().toISOString(), results, concurrency }, null, 2));

  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  proxy.close();
}

main().catch(async (e) => {
  console.__orig ? console.__orig(e) : console.error(e);
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
