const crypto = require('crypto');
const { jwtSecret } = require('../middleware/auth');

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const signatureFor = (proofId, version, fileId, expires) => crypto
  .createHmac('sha256', jwtSecret())
  .update(`${proofId}:${version}:${fileId}:${expires}`)
  .digest('hex');

function sharePath(proof, file, now = Date.now()) {
  const expires = now + MAX_AGE_MS;
  const fileId = String(file.fileId);
  const signature = signatureFor(String(proof._id), proof.version, fileId, expires);
  return `/proof-share/${proof._id}/${fileId}/${expires}/${signature}`;
}

function validShare(proof, fileId, expiresText, signature, now = Date.now()) {
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + MAX_AGE_MS) return false;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  if (!(proof.files || []).some((file) => String(file.fileId) === fileId)) return false;
  const expected = signatureFor(String(proof._id), proof.version, fileId, expires);
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { sharePath, validShare };
