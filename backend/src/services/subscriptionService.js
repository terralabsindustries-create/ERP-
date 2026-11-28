const crypto = require('crypto');
const SubscriptionPurchase = require('../models/SubscriptionPurchase');
const User = require('../models/User');
const { getPack, addCalendarMonthsIST } = require('../config/subscriptionPlans');
const rzp = require('./razorpayClient');

/*
  Prepaid plan purchases for Carbon Print Flow itself. Nothing here touches the
  ERP's customer Payment / AccountTransaction records.

  Access is derived, never cached: a business's paid expiry is a fold over its
  settled purchases in the order they were paid. Marking a purchase `paid` is the
  one atomic step that grants access, so a Checkout callback, a webhook and a
  status sync racing on the same payment grant it exactly once, and a refund
  simply stops a purchase counting.
*/

const workspaceKeyFor = (user) => (user.dataScope ? `scope:${user.dataScope}` : `user:${user._id}`);

const timingSafeEqualHex = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/** Checkout signature: HMAC_SHA256(order_id|payment_id, key_secret). */
const verifyCheckoutSignature = (orderId, paymentId, signature) =>
  !!signature && timingSafeEqualHex(hmacHex(rzp.keySecret(), `${orderId}|${paymentId}`), signature);

/** Webhook signature: HMAC_SHA256(raw body, webhook secret). */
const verifyWebhookSignature = (rawBody, signature) => {
  const secret = rzp.webhookSecret();
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  return timingSafeEqualHex(hmacHex(secret, rawBody), signature);
};

class PurchaseError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const publicPurchase = (p) => ({
  id: String(p._id),
  orderId: p.orderId,
  paymentId: p.paymentId || null,
  packId: p.packId,
  months: p.months,
  amountPaise: p.amountPaise,
  currency: p.currency,
  status: p.status,
  disputeStatus: p.disputeStatus,
  refundedPaise: p.refundedPaise || 0,
  failureReason: p.failureReason || null,
  paidAt: p.paidAt || null,
  createdAt: p.createdAt
});

/* ---------- entitlement ---------- */

const foldPaid = (purchases) => {
  const paid = purchases
    .filter((p) => p.status === 'paid')
    .sort((a, b) => (new Date(a.paidAt) - new Date(b.paidAt)) || String(a._id).localeCompare(String(b._id)));
  let start = null;
  let end = null;
  let last = null;
  for (const p of paid) {
    const paidAt = new Date(p.paidAt);
    const running = end && end > paidAt;
    const from = running ? end : paidAt;
    if (!running) start = paidAt; // a lapse (or the first purchase) starts a new access period
    end = addCalendarMonthsIST(from, p.months);
    last = p;
  }
  return { start, end, last };
};

const resolveEntitlement = async (user, now = new Date()) => {
  const key = workspaceKeyFor(user);
  // Both lookups are independent; one round trip instead of two.
  const [purchases, admins] = await Promise.all([
    SubscriptionPurchase.find({ workspaceKey: key, status: 'paid' }).select('status paidAt months packId').lean(),
    User.find(user.dataScope ? { dataScope: user.dataScope, role: 'admin' } : { _id: user._id }).select('subscription').lean()
  ]);
  const { start, end, last } = foldPaid(purchases);
  if (end && end > now) {
    return { isActive: true, status: 'paid', plan: 'prepaid', packId: last.packId, months: last.months, startDate: start, endDate: end, autoRenew: false };
  }
  // No running paid access: fall back to the trial / earlier plan held by the business's admin(s).
  let best = null;
  for (const a of admins) {
    const s = a.subscription;
    if (s && s.isActive && s.endDate && s.endDate > now && (!best || s.endDate > best.endDate)) best = s;
  }
  if (best) {
    return { isActive: true, status: best.plan === 'free' || !best.plan ? 'trial' : 'legacy', plan: best.plan || 'free', startDate: best.startDate, endDate: best.endDate, autoRenew: false };
  }
  return { isActive: false, status: 'expired', plan: end ? 'prepaid' : null, startDate: start, endDate: end, autoRenew: false };
};

/*
  The entitlement is checked on every ERP request (middleware/requireSubscription)
  and on /auth/me. Resolving it costs database round trips, which with a remote
  database dominated small requests. It is cached per business for a short time:

  - an active entitlement for ENTITLEMENT_CACHE_MS (default 60 s), never past its
    own end date, so access still ends on time;
  - an inactive one for ENTITLEMENT_NEGATIVE_CACHE_MS (default 10 s), so a plan
    bought on another server instance is picked up quickly;
  - any write to a plan purchase in this process clears the cache at once
    (see invalidateEntitlements, called from the SubscriptionPurchase hooks).

  Concurrent misses for the same business share one lookup. Set
  ENTITLEMENT_CACHE_MS=0 to turn caching off.
*/
const entitlementCache = new Map(); // key -> { value, expiresAt } | { pending }
const cacheMs = () => Number(process.env.ENTITLEMENT_CACHE_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 60000));
const negativeCacheMs = () => Number(process.env.ENTITLEMENT_NEGATIVE_CACHE_MS ?? Math.min(10000, cacheMs()));

const invalidateEntitlements = (workspaceKey) => {
  if (workspaceKey) entitlementCache.delete(workspaceKey);
  else entitlementCache.clear();
};

const getEntitlement = async (user, now = new Date()) => {
  const ttl = cacheMs();
  if (!(ttl > 0)) return resolveEntitlement(user, now);
  const key = workspaceKeyFor(user);
  const hit = entitlementCache.get(key);
  if (hit && hit.pending) return hit.pending;
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const pending = resolveEntitlement(user, now).then((value) => {
    const life = value.isActive ? ttl : negativeCacheMs();
    const until = value.isActive && value.endDate ? Math.min(Date.now() + life, new Date(value.endDate).getTime()) : Date.now() + life;
    if (entitlementCache.get(key)?.pending === pending) entitlementCache.set(key, { value, expiresAt: until });
    return value;
  }, (error) => {
    if (entitlementCache.get(key)?.pending === pending) entitlementCache.delete(key);
    throw error;
  });
  entitlementCache.set(key, { pending });
  if (entitlementCache.size > 5000) entitlementCache.delete(entitlementCache.keys().next().value);
  return pending;
};

/** Attach the business-wide entitlement so generateProfile() reports it for every login. */
const attachEntitlement = async (user) => {
  try {
    user.$locals.entitlement = await getEntitlement(user);
  } catch (err) {
    console.error('Could not resolve subscription:', err.message);
  }
  return user;
};

/* ---------- orders ---------- */

const createOrder = async (user, packId) => {
  if (user.role !== 'admin') {
    throw new PurchaseError(403, 'Only the business admin can buy or renew the plan.', 'ADMIN_ONLY');
  }
  const pack = getPack(packId);
  if (!pack) throw new PurchaseError(400, 'Choose a valid plan pack.', 'INVALID_PACK');

  const receipt = `cpf_${String(user._id).slice(-8)}_${Date.now().toString(36)}`; // <= 40 chars
  let order;
  try {
    order = await rzp.getClient().orders.create({
      amount: pack.amountPaise,
      currency: pack.currency,
      receipt,
      notes: { packId: pack.id, workspace: workspaceKeyFor(user).slice(0, 200) }
    });
  } catch (err) {
    const status = err && err.statusCode;
    console.error('Razorpay order creation failed:', status, err && err.error && err.error.description);
    throw new PurchaseError(502, 'Could not start the payment. Please try again.', 'ORDER_CREATE_FAILED');
  }
  if (!order || !order.id || order.amount !== pack.amountPaise || order.currency !== pack.currency) {
    throw new PurchaseError(502, 'Could not start the payment. Please try again.', 'ORDER_MISMATCH');
  }
  const purchase = await SubscriptionPurchase.create({
    workspaceKey: workspaceKeyFor(user),
    dataScope: user.dataScope,
    purchasedBy: user._id,
    packId: pack.id,
    months: pack.months,
    amountPaise: pack.amountPaise,
    currency: pack.currency,
    receipt,
    orderId: order.id
  });
  return { purchase, pack };
};

/* ---------- settlement ---------- */

const paymentTime = (payment) => {
  const t = Number(payment && payment.created_at) * 1000;
  return Number.isFinite(t) && t > 0 && t <= Date.now() + 60000 ? new Date(t) : new Date();
};

/** Does this Razorpay payment match what we quoted for this purchase? */
const paymentMatches = (purchase, payment) =>
  !!payment && payment.order_id === purchase.orderId &&
  Number(payment.amount) === purchase.amountPaise && payment.currency === purchase.currency;

/**
 * Settle a purchase from a Razorpay payment entity fetched from or delivered by Razorpay.
 * Returns { state: 'paid' | 'pending' | 'failed' | 'ignored', granted, purchase }.
 */
const settlePayment = async (purchase, payment, via, { signatureVerified = false } = {}) => {
  if (!paymentMatches(purchase, payment)) {
    throw new PurchaseError(400, 'This payment does not match your order.', 'PAYMENT_MISMATCH');
  }
  if (['refunded', 'dispute_lost'].includes(purchase.status)) return { state: 'ignored', granted: false, purchase };

  if (payment.status === 'captured' && payment.captured !== false) {
    const granted = await SubscriptionPurchase.findOneAndUpdate(
      { _id: purchase._id, status: { $in: ['created', 'failed', 'cancelled'] } },
      { $set: {
        status: 'paid', paymentId: payment.id, paidAt: paymentTime(payment), settledAt: new Date(),
        settledVia: via, failureReason: null, ...(signatureVerified ? { verifiedSignature: true } : {})
      } },
      { new: true }
    );
    if (granted) return { state: 'paid', granted: true, purchase: granted };
    const current = await SubscriptionPurchase.findById(purchase._id);
    if (signatureVerified && current.status === 'paid' && !current.verifiedSignature) {
      current.verifiedSignature = true;
      await current.save();
    }
    return { state: current.status === 'paid' ? 'paid' : 'ignored', granted: false, purchase: current };
  }

  if (payment.status === 'failed') {
    const updated = await SubscriptionPurchase.findOneAndUpdate(
      { _id: purchase._id, status: { $in: ['created', 'failed', 'cancelled'] } },
      { $set: { status: 'failed', failureReason: String(payment.error_description || payment.error_reason || 'Payment failed').slice(0, 200) } },
      { new: true }
    );
    return { state: 'failed', granted: false, purchase: updated || purchase };
  }

  // authorized, created, refunded-before-capture etc: never access.
  return { state: 'pending', granted: false, purchase };
};

/** The Checkout callback: signature first, then confirm with Razorpay itself. */
const verifyCheckout = async (user, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) => {
  if (!orderId || !paymentId || !signature || [orderId, paymentId, signature].some((v) => typeof v !== 'string')) {
    throw new PurchaseError(400, 'Payment details are missing.', 'MISSING_FIELDS');
  }
  // The order comes from our own record, scoped to this business.
  const purchase = await SubscriptionPurchase.findOne({ orderId, workspaceKey: workspaceKeyFor(user) });
  if (!purchase) throw new PurchaseError(404, 'Order not found.', 'ORDER_NOT_FOUND');
  if (!verifyCheckoutSignature(purchase.orderId, paymentId, signature)) {
    throw new PurchaseError(400, 'Payment signature is invalid.', 'INVALID_SIGNATURE');
  }
  let payment;
  try {
    payment = await rzp.getClient().payments.fetch(paymentId);
  } catch (err) {
    throw new PurchaseError(502, 'Could not confirm the payment with Razorpay yet. Your access will update automatically once it is confirmed.', 'PROVIDER_UNAVAILABLE');
  }
  return settlePayment(purchase, payment, 'checkout', { signatureVerified: true });
};

/** Reconcile a purchase against Razorpay (covers a lost callback and a lost webhook). */
/*
  Each status check is a Razorpay API call. The same order is checked at most
  once per SYNC_MIN_INTERVAL_MS (default 30 s): repeats inside the window answer
  from our record. Webhooks and the 15-minute reconciler settle orders anyway.
*/
const syncMinIntervalMs = () => Number(process.env.RAZORPAY_SYNC_MIN_INTERVAL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 30000));

const syncPurchase = async (purchase, { now = Date.now() } = {}) => {
  if (purchase.status !== 'created' && purchase.status !== 'failed' && purchase.status !== 'cancelled') return { state: purchase.status, granted: false, purchase };
  const minGap = syncMinIntervalMs();
  if (minGap > 0) {
    // Claim the check atomically, so two tabs asking at once make one call.
    const claimed = await SubscriptionPurchase.findOneAndUpdate(
      { _id: purchase._id, $or: [{ lastSyncedAt: null }, { lastSyncedAt: { $lte: new Date(now - minGap) } }] },
      { $set: { lastSyncedAt: new Date(now) } },
      { new: true }
    );
    if (!claimed) return { state: 'pending', granted: false, throttled: true, purchase };
  } else {
    await SubscriptionPurchase.updateOne({ _id: purchase._id }, { $set: { lastSyncedAt: new Date(now) } });
  }
  let list;
  try {
    list = await rzp.getClient().orders.fetchPayments(purchase.orderId);
  } catch (err) {
    throw new PurchaseError(502, 'Could not reach Razorpay. Please try again shortly.', 'PROVIDER_UNAVAILABLE');
  }
  const items = (list && list.items) || [];
  const captured = items.find((p) => p.status === 'captured' && paymentMatches(purchase, p));
  if (captured) return settlePayment(purchase, captured, 'sync');
  return { state: 'pending', granted: false, purchase };
};

/**
 * Safety net for a lost callback AND a lost webhook: ask Razorpay about orders
 * that never settled. Per-order failures are skipped so one bad order cannot
 * block the rest.
 */
const reconcileOpenPurchases = async ({ maxAgeMs = 48 * 3600 * 1000, minAgeMs = 2 * 60 * 1000, limit = 50 } = {}) => {
  const now = Date.now();
  const open = await SubscriptionPurchase.find({
    status: { $in: ['created', 'failed', 'cancelled'] },
    createdAt: { $gte: new Date(now - maxAgeMs), $lte: new Date(now - minAgeMs) }
  }).sort({ createdAt: 1 }).limit(limit);
  let settled = 0;
  for (const purchase of open) {
    try {
      const result = await syncPurchase(purchase);
      if (result.granted) settled += 1;
    } catch (err) {
      console.error('Reconcile skipped an order:', purchase.orderId, err.message);
    }
  }
  return { checked: open.length, settled };
};

const markCancelled = async (user, orderId) => {
  const purchase = await SubscriptionPurchase.findOneAndUpdate(
    { orderId, workspaceKey: workspaceKeyFor(user), status: { $in: ['created', 'failed'] } },
    { $set: { status: 'cancelled' } },
    { new: true }
  );
  if (purchase) return purchase;
  const existing = await SubscriptionPurchase.findOne({ orderId, workspaceKey: workspaceKeyFor(user) });
  if (!existing) throw new PurchaseError(404, 'Order not found.', 'ORDER_NOT_FOUND');
  return existing; // already paid/cancelled: unchanged
};

/* ---------- webhooks ---------- */

const entity = (payload, name) => payload && payload[name] && payload[name].entity;

const findPurchaseForPayment = async (payment) => {
  if (!payment) return null;
  if (payment.order_id) {
    const byOrder = await SubscriptionPurchase.findOne({ orderId: payment.order_id });
    if (byOrder) return byOrder;
  }
  return payment.id ? SubscriptionPurchase.findOne({ paymentId: payment.id }) : null;
};

const recordEventOn = (purchase, eventId) =>
  SubscriptionPurchase.updateOne({ _id: purchase._id }, { $addToSet: { webhookEventIds: eventId } });

/** Apply one verified, parsed webhook event. Idempotent. */
const applyWebhookEvent = async (event, eventId) => {
  try {
    return await applyWebhookEventUnsafe(event, eventId);
  } catch (err) {
    // A payment that does not match our quote is not ours to act on; acknowledge it
    // (retrying would never change the answer) and leave the purchase untouched.
    if (err instanceof PurchaseError && err.code === 'PAYMENT_MISMATCH') {
      console.error('Razorpay webhook payment did not match its order:', event && event.event);
      return 'mismatch';
    }
    throw err;
  }
};

const applyWebhookEventUnsafe = async (event, eventId) => {
  const payload = event.payload || {};
  const payment = entity(payload, 'payment');
  const type = event.event;

  if (type === 'order.paid') {
    const order = entity(payload, 'order');
    const purchase = order && await SubscriptionPurchase.findOne({ orderId: order.id });
    if (!purchase || !payment) return 'unknown_order';
    const result = await settlePayment(purchase, payment, 'webhook');
    await recordEventOn(purchase, eventId);
    return result.state;
  }

  const purchase = await findPurchaseForPayment(payment);
  if (!purchase) return 'unknown_order'; // not one of ours (e.g. another product on the same account)
  await recordEventOn(purchase, eventId);

  switch (type) {
    case 'payment.captured':
    case 'payment.authorized':
    case 'payment.failed':
      return (await settlePayment(purchase, payment, 'webhook')).state;

    case 'refund.processed':
    case 'refund.created': {
      if (type === 'refund.created') return 'noted';
      if (!paymentMatches(purchase, payment)) return 'mismatch';
      const refunded = Number(payment.amount_refunded) || 0;
      const update = { refundedPaise: refunded };
      if (refunded >= purchase.amountPaise) update.status = 'refunded';
      // Fully refunded access stops counting; a partial refund leaves access (owner decision).
      await SubscriptionPurchase.updateOne({ _id: purchase._id }, { $set: update });
      return refunded >= purchase.amountPaise ? 'refunded' : 'partial_refund';
    }

    case 'payment.dispute.created':
    case 'payment.dispute.under_review':
    case 'payment.dispute.action_required':
      await SubscriptionPurchase.updateOne({ _id: purchase._id, disputeStatus: { $nin: ['won', 'lost'] } }, { $set: { disputeStatus: 'open' } });
      return 'dispute_open';

    case 'payment.dispute.won':
      await SubscriptionPurchase.updateOne({ _id: purchase._id }, { $set: { disputeStatus: 'won' } });
      return 'dispute_won';

    case 'payment.dispute.lost':
      await SubscriptionPurchase.updateOne({ _id: purchase._id }, { $set: { disputeStatus: 'lost', status: 'dispute_lost' } });
      return 'dispute_lost';

    case 'payment.dispute.closed': {
      const dispute = entity(payload, 'dispute');
      if (dispute && dispute.status === 'lost') {
        await SubscriptionPurchase.updateOne({ _id: purchase._id }, { $set: { disputeStatus: 'lost', status: 'dispute_lost' } });
        return 'dispute_lost';
      }
      if (dispute && dispute.status === 'won') {
        await SubscriptionPurchase.updateOne({ _id: purchase._id }, { $set: { disputeStatus: 'won' } });
        return 'dispute_won';
      }
      return 'noted';
    }

    default:
      return 'ignored';
  }
};

module.exports = {
  PurchaseError, workspaceKeyFor, publicPurchase, getEntitlement, attachEntitlement, invalidateEntitlements, foldPaid,
  createOrder, verifyCheckout, syncPurchase, reconcileOpenPurchases, markCancelled, settlePayment,
  applyWebhookEvent, verifyCheckoutSignature, verifyWebhookSignature
};
