const mongoose = require('mongoose');

/**
 * A critical mutation's Idempotency-Key (see middleware/idempotency.js): the
 * same key from the same business returns the stored result instead of doing
 * the work twice. Records expire after 48 hours.
 */
const schema = new mongoose.Schema({
  scope: { type: String, required: true },
  key: { type: String, required: true },
  fingerprint: { type: String, required: true },
  status: { type: String, enum: ['in_progress', 'done'], default: 'in_progress' },
  responseStatus: Number,
  responseBody: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 48 * 3600 }
});
schema.index({ scope: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyRecord', schema);
