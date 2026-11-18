const mongoose = require('mongoose');

// Durable record of every verified Razorpay webhook delivery (dedupe by event id).
const schema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  event: { type: String },
  status: { type: String, enum: ['processing', 'done', 'failed'], default: 'processing' },
  attempts: { type: Number, default: 1 },
  processedAt: { type: Date },
  error: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('RazorpayWebhookEvent', schema);
