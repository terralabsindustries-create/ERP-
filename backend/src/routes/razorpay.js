const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const rzp = require('../services/razorpayClient');
const svc = require('../services/subscriptionService');
const SubscriptionPurchase = require('../models/SubscriptionPurchase');
const RazorpayWebhookEvent = require('../models/RazorpayWebhookEvent');
const { listPacks } = require('../config/subscriptionPlans');

/*
  Carbon Print Flow plan purchases (SaaS billing). Entirely separate from the
  ERP's customer payments and ledger. Prices and durations are decided by
  config/subscriptionPlans.js; the browser only names a pack.
*/
const router = express.Router();

if (!rzp.isConfigured()) {
  console.warn('⚠️  Razorpay is not configured. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.');
}

const fail = (res, err) => {
  if (err instanceof svc.PurchaseError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  console.error('Subscription payment error:', err && err.message);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};

const requireConfigured = (req, res, next) => {
  if (rzp.isConfigured()) return next();
  return res.status(503).json({ success: false, message: 'Online payments are not available right now.', code: 'RAZORPAY_NOT_CONFIGURED' });
};

const stateResponse = (result, user) => ({
  success: true,
  state: result.state,
  granted: result.granted,
  purchase: svc.publicPurchase(result.purchase),
  message: {
    paid: 'Payment confirmed. Your plan is active.',
    pending: 'Your payment is not confirmed yet. If you were charged, access will update automatically.',
    failed: 'The payment failed. You have not been charged; please try again.',
    ignored: 'This payment can no longer be applied.'
  }[result.state]
});

// Catalog
router.get('/plans', protect, (req, res) => {
  res.json({ success: true, packs: listPacks(), canPurchase: req.user.role === 'admin' });
});

// Current plan, expiry and purchase history for the caller's business
router.get('/subscription', protect, async (req, res) => {
  try {
    const [subscription, purchases] = await Promise.all([
      svc.getEntitlement(req.user),
      SubscriptionPurchase.find({ workspaceKey: svc.workspaceKeyFor(req.user) }).sort({ createdAt: -1 }).limit(50)
    ]);
    res.json({
      success: true,
      subscription,
      purchases: purchases.map(svc.publicPurchase),
      canPurchase: req.user.role === 'admin'
    });
  } catch (err) { fail(res, err); }
});

// Start a purchase. Only `packId` is read from the body.
router.post('/create-order', protect, requireConfigured, async (req, res) => {
  try {
    const { purchase, pack } = await svc.createOrder(req.user, req.body && req.body.packId);
    res.json({
      success: true,
      keyId: rzp.keyId(), // public key id only
      order: { id: purchase.orderId, amount: purchase.amountPaise, currency: purchase.currency },
      pack
    });
  } catch (err) { fail(res, err); }
});

// Checkout callback
router.post('/verify-payment', protect, requireConfigured, async (req, res) => {
  try {
    const result = await svc.verifyCheckout(req.user, req.body || {});
    res.status(result.state === 'pending' ? 202 : 200).json(stateResponse(result, req.user));
  } catch (err) { fail(res, err); }
});

// Customer closed checkout
router.post('/order/:orderId/cancel', protect, async (req, res) => {
  try {
    const purchase = await svc.markCancelled(req.user, String(req.params.orderId));
    res.json({ success: true, purchase: svc.publicPurchase(purchase) });
  } catch (err) { fail(res, err); }
});

// Status of one order, scoped to the caller's business
router.get('/order/:orderId', protect, async (req, res) => {
  try {
    const purchase = await SubscriptionPurchase.findOne({ orderId: String(req.params.orderId), workspaceKey: svc.workspaceKeyFor(req.user) });
    if (!purchase) return res.status(404).json({ success: false, message: 'Order not found.' });
    res.json({ success: true, purchase: svc.publicPurchase(purchase) });
  } catch (err) { fail(res, err); }
});

// Ask Razorpay directly (after a refresh, closed tab or missed callback)
router.post('/order/:orderId/sync', protect, requireConfigured, async (req, res) => {
  try {
    const purchase = await SubscriptionPurchase.findOne({ orderId: String(req.params.orderId), workspaceKey: svc.workspaceKeyFor(req.user) });
    if (!purchase) return res.status(404).json({ success: false, message: 'Order not found.' });
    const result = await svc.syncPurchase(purchase);
    res.json(stateResponse(result, req.user));
  } catch (err) { fail(res, err); }
});

/*
  Public webhook. Mounted in app.js BEFORE express.json() with express.raw(), so
  req.body is the exact bytes Razorpay signed.
*/
const STALE_PROCESSING_MS = 60 * 1000;

const claimEvent = async (eventId, event) => {
  try {
    await RazorpayWebhookEvent.create({ eventId, event });
    return 'claimed';
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
  }
  const retry = await RazorpayWebhookEvent.findOneAndUpdate(
    { $or: [{ eventId, status: 'failed' }, { eventId, status: 'processing', updatedAt: { $lt: new Date(Date.now() - STALE_PROCESSING_MS) } }] },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } }
  );
  if (retry) return 'claimed';
  const existing = await RazorpayWebhookEvent.findOne({ eventId });
  return existing && existing.status === 'done' ? 'duplicate' : 'busy';
};

const webhookHandler = async (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !svc.verifyWebhookSignature(raw, req.get('X-Razorpay-Signature'))) {
    return res.status(400).json({ success: false, message: 'Invalid signature' });
  }
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ success: false });

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ success: false }); }
  const eventId = req.get('X-Razorpay-Event-Id') || `body_${crypto.createHash('sha256').update(raw).digest('hex')}`;

  try {
    const claim = await claimEvent(eventId, event.event);
    if (claim === 'duplicate') return res.status(200).json({ success: true, duplicate: true });
    if (claim === 'busy') return res.status(409).json({ success: false, message: 'Event is being processed' });
    try {
      const outcome = await svc.applyWebhookEvent(event, eventId);
      await RazorpayWebhookEvent.updateOne({ eventId }, { $set: { status: 'done', processedAt: new Date() } });
      return res.status(200).json({ success: true, outcome });
    } catch (err) {
      await RazorpayWebhookEvent.updateOne({ eventId }, { $set: { status: 'failed', error: String(err.message).slice(0, 300) } });
      console.error('Razorpay webhook processing failed:', event.event, err.message);
      return res.status(500).json({ success: false }); // Razorpay will retry
    }
  } catch (err) {
    console.error('Razorpay webhook error:', err.message);
    return res.status(500).json({ success: false });
  }
};

module.exports = router;
module.exports.webhookHandler = webhookHandler;
