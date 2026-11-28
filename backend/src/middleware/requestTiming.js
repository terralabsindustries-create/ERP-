/**
 * Request timing.
 *
 * Every API response carries `Server-Timing: app;dur=<ms>` so the browser's
 * network panel shows how much of a slow request was the server and how much
 * was the network. Requests slower than PERF_SLOW_MS (default 1000 ms) are
 * logged as one JSON line:
 *
 *   {"evt":"slow_request","method":"GET","route":"/api/jobs","status":200,"ms":1420,"bytes":"28411"}
 *
 * The line carries no query string, body, token or user details — only the
 * path with ids replaced — so it is safe to ship to any log store.
 * PERF_LOG=all logs every request; PERF_LOG=off logs nothing.
 */
const OBJECT_ID = /\b[0-9a-f]{24}\b/gi;

const routeOf = (req) => (req.originalUrl || req.url || '').split('?')[0].replace(OBJECT_ID, ':id');

function requestTiming(req, res, next) {
  const started = process.hrtime.bigint();
  const mode = process.env.PERF_LOG || 'slow';
  const slowMs = Number(process.env.PERF_SLOW_MS || 1000);

  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}`);
    return writeHead.apply(this, args);
  };

  res.on('finish', () => {
    if (mode === 'off') return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (mode !== 'all' && ms < slowMs) return;
    process.stdout.write(`${JSON.stringify({
      evt: ms >= slowMs ? 'slow_request' : 'request',
      method: req.method,
      route: routeOf(req),
      status: res.statusCode,
      ms: Math.round(ms),
      bytes: res.getHeader('Content-Length') || null,
      at: new Date().toISOString()
    })}\n`);
  });
  next();
}

module.exports = { requestTiming, routeOf };
