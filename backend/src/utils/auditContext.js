/**
 * Per-request audit context (correlation id, client address, user agent),
 * carried with AsyncLocalStorage so every ActivityLog entry written while a
 * request is handled — however deep in a service — shares one correlation id
 * without each call site passing it along.
 *
 * A caller may supply X-Correlation-ID (letters, digits, . _ - only, ≤ 64
 * characters) to tie a browser action to server records; anything else is
 * replaced by a generated id. The id is echoed back on the response.
 */
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const storage = new AsyncLocalStorage();
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

function auditContext(req, res, next) {
  const supplied = req.get('x-correlation-id');
  const correlationId = supplied && SAFE_ID.test(supplied) ? supplied : crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  storage.run({ correlationId, ipAddress: req.ip, userAgent: String(req.get('user-agent') || '').slice(0, 300) }, next);
}

const currentContext = () => storage.getStore() || {};
/** Runs `fn` under a fresh context (scripts, jobs, tests). */
const runWithContext = (ctx, fn) => storage.run({ correlationId: crypto.randomUUID(), ...ctx }, fn);

module.exports = { auditContext, currentContext, runWithContext };
