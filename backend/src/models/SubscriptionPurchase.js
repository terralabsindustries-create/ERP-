const mongoose = require('mongoose');

/*
  One attempt to buy a Carbon Print Flow plan, from order creation to settlement.
  This is the SaaS billing ledger and is deliberately separate from the ERP's
  customer Payment / AccountTransaction collections.

  status:
    created      order exists, nothing captured yet
    failed       Razorpay reported a failed attempt (the order can still be paid)
    cancelled    the customer closed checkout (the order can still be paid)
    paid         payment captured and verified; counts toward access
    refunded     fully refunded; no longer counts toward access
    dispute_lost chargeback lost; no longer counts toward access
*/
const schema = new mongoose.Schema({
  workspaceKey: { type: String, required: true, index: true },
  dataScope: { type: String },
  purchasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  packId: { type: String, required: true },
  months: { type: Number, required: true },
  amountPaise: { type: Number, required: true },
  currency: { type: String, required: true, default: 'INR' },
  receipt: { type: String },
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String, index: true, sparse: true },
  status: {
    type: String,
    enum: ['created', 'failed', 'cancelled', 'paid', 'refunded', 'dispute_lost'],
    default: 'created',
    index: true
  },
  disputeStatus: { type: String, enum: ['none', 'open', 'won', 'lost'], default: 'none' },
  refundedPaise: { type: Number, default: 0 },
  failureReason: { type: String },
  paidAt: { type: Date },          // when Razorpay says the payment was made
  settledAt: { type: Date },       // when we confirmed it
  settledVia: { type: String, enum: ['checkout', 'webhook', 'sync'] },
  // Provider identifiers kept for audit and deduplication.
  verifiedSignature: { type: Boolean, default: false },
  webhookEventIds: { type: [String], default: [] },
  // Last time this order was checked with Razorpay (status sync). Repeat checks
  // within a short window answer from our record instead of calling Razorpay.
  lastSyncedAt: { type: Date }
}, { timestamps: true });

schema.index({ workspaceKey: 1, createdAt: -1 });
schema.index({ workspaceKey: 1, status: 1 });
schema.index({ status: 1, createdAt: 1 });

// Any change to a purchase can change what a business is entitled to: drop the
// cached entitlement (services/subscriptionService.js) so the next request
// re-reads it. Required lazily — the service requires this model.
const invalidate = () => require('../services/subscriptionService').invalidateEntitlements();
for (const op of ['save', 'findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'insertMany']) {
  schema.post(op, invalidate);
}

module.exports = mongoose.model('SubscriptionPurchase', schema);
