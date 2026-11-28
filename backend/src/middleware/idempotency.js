/**
 * Idempotency for critical creates. A client sends `Idempotency-Key: <8-100 chars>`
 * (a UUID per user action; the same value on every retry of that action).
 *
 *   - first request with the key: runs; a successful (2xx) answer is stored
 *   - same key again, same request: the stored answer is returned with
 *     `Idempotent-Replay: true`, the work is NOT repeated
 *   - same key, different request body/path: 422 IDEMPOTENCY_KEY_REUSED
 *   - same key while the first is still running: 409 REQUEST_IN_PROGRESS
 *   - a failed first attempt (4xx/5xx) releases the key so a retry can succeed
 *
 * Without the header the request behaves exactly as before. Keys are scoped to
 * the caller's business, so one tenant can never replay or probe another's.
 */
const crypto = require('crypto');
const IdempotencyRecord = require('../models/IdempotencyRecord');

const KEY = /^[A-Za-z0-9._:-]{8,100}$/;

function idempotent(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (!KEY.test(key)) return res.status(400).json({ status: 'error', code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-100 letters, digits or . _ : -' });

  const scope = String(req.user.dataScope || req.user._id);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([req.method, req.baseUrl + req.path, req.body || {}])).digest('hex');

  IdempotencyRecord.create({ scope, key, fingerprint })
    .then((record) => {
      const json = res.json.bind(res);
      res.json = (body) => {
        res.json = json;
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const settle = ok
          ? IdempotencyRecord.updateOne({ _id: record._id }, { $set: { status: 'done', responseStatus: res.statusCode, responseBody: body } })
          : IdempotencyRecord.deleteOne({ _id: record._id });
        // Store before the client can retry.
        settle.catch((e) => console.error('Idempotency record update failed:', e.message)).finally(() => json(body));
        return res;
      };
      next();
    })
    .catch(async (error) => {
      if (error.code !== 11000) return next(error);
      const existing = await IdempotencyRecord.findOne({ scope, key }).lean();
      if (!existing) return next(); // expired or released between the two reads
      if (existing.fingerprint !== fingerprint) {
        return res.status(422).json({ status: 'error', code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for a different request.' });
      }
      if (existing.status === 'done') {
        res.set('Idempotent-Replay', 'true');
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      return res.status(409).json({ status: 'error', code: 'REQUEST_IN_PROGRESS', message: 'The same request is still being processed. Wait a moment and retry.' });
    });
}

module.exports = { idempotent };
