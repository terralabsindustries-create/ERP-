/**
 * Carbon Print Flow plan purchases via Razorpay (prepaid 1/3/6/12-month packs),
 * with a mocked Razorpay client. Nothing here talks to Razorpay.
 */
const crypto = require('crypto');
const request = require('supertest');

process.env.RAZORPAY_KEY_ID = 'rzp_test_unit_key';
process.env.RAZORPAY_KEY_SECRET = 'unit_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'unit_webhook_secret';

const app = require('../src/app');
const rzpClient = require('../src/services/razorpayClient');
const svc = require('../src/services/subscriptionService');
const { addCalendarMonthsIST, listPacks } = require('../src/config/subscriptionPlans');
const SubscriptionPurchase = require('../src/models/SubscriptionPurchase');
const User = require('../src/models/User');
const RazorpayWebhookEvent = require('../src/models/RazorpayWebhookEvent');
const Payment = require('../src/models/Payment');
const AccountTransaction = require('../src/models/AccountTransaction');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let other;
let seq = 0;
const payments = new Map(); // payment id -> entity the mocked Razorpay returns
const mock = {
  orders: { create: jest.fn(), fetchPayments: jest.fn() },
  payments: { fetch: jest.fn(async (id) => { if (!payments.has(id)) throw new Error('not found'); return payments.get(id); }) }
};

const post = (url, token, body) => request(app).post(url).set(auth(token)).send(body);
const get = (url, token) => request(app).get(url).set(auth(token));
const sign = (orderId, paymentId) => crypto.createHmac('sha256', 'unit_key_secret').update(`${orderId}|${paymentId}`).digest('hex');

const buyOrder = async (token, packId) => {
  const res = await post('/api/razorpay/create-order', token, { packId });
  return res;
};

/** Register a Razorpay payment for an order and return the Checkout callback body. */
const makePayment = (order, overrides = {}) => {
  const id = `pay_${++seq}`;
  payments.set(id, {
    id, order_id: order.id, amount: order.amount, currency: order.currency,
    status: 'captured', captured: true, created_at: Math.floor(Date.now() / 1000), ...overrides
  });
  return { razorpay_order_id: order.id, razorpay_payment_id: id, razorpay_signature: sign(order.id, id) };
};

const webhook = (event, { eventId = `evt_${++seq}`, secret = 'unit_webhook_secret', signature } = {}) => {
  const raw = JSON.stringify(event);
  const sig = signature || crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return request(app).post('/api/razorpay/webhook').set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', eventId).send(raw);
};
const paymentEvent = (type, payment, extra = {}) => ({ event: type, payload: { payment: { entity: payment }, ...extra } });

const entitlement = async (user) => svc.getEntitlement(user);
const monthsFromNow = (m) => addCalendarMonthsIST(new Date(), m);

beforeAll(async () => {
  await connectTestDb('subscription');
  rzpClient.setClientForTests(mock);
  await Promise.all([SubscriptionPurchase.init(), RazorpayWebhookEvent.init()]); // unique indexes ready
  org = await createOrg('sub');
  other = await createOrg('subother');
});
afterAll(async () => { rzpClient.setClientForTests(null); await disconnectTestDb(); });
beforeEach(async () => {
  seq += 0;
  mock.orders.create.mockReset();
  mock.orders.create.mockImplementation(async (o) => ({ id: `order_${++seq}`, amount: o.amount, currency: o.currency }));
  mock.orders.fetchPayments.mockReset();
  await SubscriptionPurchase.deleteMany({});
  await RazorpayWebhookEvent.deleteMany({});
});

describe('plan catalog and orders', () => {
  test('an expired business cannot use ERP APIs but can read billing and buy a plan', async () => {
    await User.updateOne({ _id: org.admin._id }, { $set: {
      'subscription.isActive': false,
      'subscription.endDate': new Date(Date.now() - 1000)
    } });
    const denied = await get('/api/dashboard/stats', org.tokens.admin);
    expect(denied.status).toBe(402);
    expect(denied.body.code).toBe('SUBSCRIPTION_EXPIRED');
    expect((await get('/api/dashboard/stats', org.tokens.staff1)).status).toBe(402);
    expect((await get('/api/razorpay/plans', org.tokens.admin)).status).toBe(200);
    expect((await get('/api/razorpay/subscription', org.tokens.admin)).status).toBe(200);
    expect((await get('/api/auth/me', org.tokens.admin)).body.data.user.subscription.status).toBe('expired');
    expect((await buyOrder(org.tokens.admin, 'M1')).status).toBe(200);
    await User.updateOne({ _id: org.admin._id }, { $set: {
      'subscription.isActive': true,
      'subscription.endDate': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    } });
  });

  test('the plan and subscription routes used by the dashboard are available', async () => {
    const [plans, subscription] = await Promise.all([
      get('/api/razorpay/plans', org.tokens.admin),
      get('/api/razorpay/subscription', org.tokens.admin)
    ]);
    expect(plans.status).toBe(200);
    expect(plans.body).toMatchObject({ success: true, canPurchase: true });
    expect(plans.body.packs).toHaveLength(4);
    expect(subscription.status).toBe(200);
    expect(subscription.body).toMatchObject({ success: true, canPurchase: true, purchases: [] });
    expect(subscription.body.subscription).toEqual(expect.objectContaining({ isActive: expect.any(Boolean) }));
  });

  test.each([['M1', 199900, 1], ['M3', 539700, 3], ['M6', 959400, 6], ['M12', 1678800, 12]])(
    '%s is charged %i paise for %i month(s), calculated by the server', async (packId, amount, months) => {
      const res = await buyOrder(org.tokens.admin, packId);
      expect(res.status).toBe(200);
      expect(mock.orders.create).toHaveBeenCalledWith(expect.objectContaining({ amount, currency: 'INR' }));
      expect(res.body.order.amount).toBe(amount);
      expect(res.body.keyId).toBe('rzp_test_unit_key');
      expect(JSON.stringify(res.body)).not.toContain('unit_key_secret');
      const stored = await SubscriptionPurchase.findOne({ orderId: res.body.order.id });
      expect(stored).toMatchObject({ packId, amountPaise: amount, months, currency: 'INR', status: 'created' });
    });

  test('catalog matches the product table', () => {
    const p = Object.fromEntries(listPacks().map((x) => [x.id, x]));
    expect(p.M3).toMatchObject({ perMonthPaise: 179900, savingsPaise: 60000, savingsPercent: 10 });
    expect(p.M6).toMatchObject({ savingsPaise: 240000, savingsPercent: 20, tag: 'Recommended' });
    expect(p.M12).toMatchObject({ savingsPaise: 720000, savingsPercent: 30, tag: 'Best value' });
    expect(p.M1).toMatchObject({ savingsPaise: 0, tag: 'Start here' });
  });

  test('ignores a browser-supplied amount, duration, discount or old plan name', async () => {
    const res = await post('/api/razorpay/create-order', org.tokens.admin, { packId: 'M12', amount: 1, amountPaise: 100, months: 1, discount: 99, planName: 'STARTER' });
    expect(res.status).toBe(200);
    expect(res.body.order.amount).toBe(1678800);
    const stored = await SubscriptionPurchase.findOne({ orderId: res.body.order.id });
    expect(stored.months).toBe(12);
  });

  test('rejects unknown packs and the removed plan names', async () => {
    expect((await buyOrder(org.tokens.admin, 'M2')).status).toBe(400);
    expect((await post('/api/razorpay/create-order', org.tokens.admin, { planName: 'GROWTH' })).status).toBe(400);
    expect(mock.orders.create).not.toHaveBeenCalled();
  });

  test('staff and managers cannot buy a plan', async () => {
    expect((await buyOrder(org.tokens.staff1, 'M1')).status).toBe(403);
    expect((await buyOrder(org.tokens.manager, 'M1')).status).toBe(403);
    expect(mock.orders.create).not.toHaveBeenCalled();
  });
});

describe('Checkout verification', () => {
  const start = async (packId = 'M3') => (await buyOrder(org.tokens.admin, packId)).body.order;

  test('a captured, matching payment grants access to every login in the business', async () => {
    const order = await start('M3');
    const res = await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(order));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'paid', granted: true });
    const ent = await entitlement(org.staff1);
    expect(ent).toMatchObject({ isActive: true, status: 'paid', plan: 'prepaid', autoRenew: false, packId: 'M3' });
    expect(Math.abs(ent.endDate - monthsFromNow(3))).toBeLessThan(60000);
    // The staff member's own profile shows it.
    const me = await get('/api/auth/me', org.tokens.staff2);
    expect(me.body.data.user.subscription).toMatchObject({ status: 'paid', autoRenew: false });
    // Another business is unaffected.
    expect((await entitlement(other.admin)).status).not.toBe('paid');
  });

  test('does not touch the ERP payments or ledger', async () => {
    const before = [await Payment.countDocuments(), await AccountTransaction.countDocuments()];
    await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(await start()));
    expect([await Payment.countDocuments(), await AccountTransaction.countDocuments()]).toEqual(before);
  });

  test('invalid signature is rejected and grants nothing', async () => {
    const order = await start();
    const body = makePayment(order);
    const res = await post('/api/razorpay/verify-payment', org.tokens.admin, { ...body, razorpay_signature: 'f'.repeat(64) });
    expect(res.status).toBe(400);
    expect((await entitlement(org.admin)).status).not.toBe('paid');
  });

  test('another business cannot verify or read this order', async () => {
    const order = await start();
    const body = makePayment(order);
    expect((await post('/api/razorpay/verify-payment', other.tokens.admin, body)).status).toBe(404);
    expect((await get(`/api/razorpay/order/${order.id}`, other.tokens.admin)).status).toBe(404);
    expect((await get(`/api/razorpay/order/${order.id}`, org.tokens.staff1)).status).toBe(200);
  });

  test('an unknown order id is rejected', async () => {
    const body = makePayment({ id: 'order_nope', amount: 1, currency: 'INR' });
    expect((await post('/api/razorpay/verify-payment', org.tokens.admin, body)).status).toBe(404);
  });

  test.each([
    ['amount', { amount: 100 }],
    ['currency', { currency: 'USD' }],
    ['order', { order_id: 'order_other' }]
  ])('rejects a payment with the wrong %s', async (_n, override) => {
    const order = await start();
    const res = await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(order, override));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYMENT_MISMATCH');
    expect((await SubscriptionPurchase.findOne({ orderId: order.id })).status).toBe('created');
  });

  test('authorised-only payment is pending and grants nothing', async () => {
    const order = await start();
    const res = await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(order, { status: 'authorized', captured: false }));
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('pending');
    expect((await entitlement(org.admin)).status).not.toBe('paid');
  });

  test('a failed payment is recorded, grants nothing, and the order can still be paid on retry', async () => {
    const order = await start();
    const res = await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(order, { status: 'failed', captured: false, error_description: 'Card declined' }));
    expect(res.body.state).toBe('failed');
    expect((await SubscriptionPurchase.findOne({ orderId: order.id })).status).toBe('failed');
    expect((await entitlement(org.admin)).status).not.toBe('paid');
    const retry = await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(order));
    expect(retry.body.state).toBe('paid');
  });

  test('cancelled checkout is recorded and later payment still works; paid orders are not cancelled', async () => {
    const order = await start();
    expect((await post(`/api/razorpay/order/${order.id}/cancel`, org.tokens.admin)).body.purchase.status).toBe('cancelled');
    expect((await entitlement(org.admin)).status).not.toBe('paid');
    await post('/api/razorpay/verify-payment', org.tokens.admin, makePayment(order));
    expect((await post(`/api/razorpay/order/${order.id}/cancel`, org.tokens.admin)).body.purchase.status).toBe('paid');
  });

  test('duplicate verification grants access once', async () => {
    const order = await start('M1');
    const body = makePayment(order);
    const a = await post('/api/razorpay/verify-payment', org.tokens.admin, body);
    const b = await post('/api/razorpay/verify-payment', org.tokens.admin, body);
    expect([a.body.granted, b.body.granted]).toEqual([true, false]);
    expect(Math.abs((await entitlement(org.admin)).endDate - monthsFromNow(1))).toBeLessThan(60000);
  });

  test('callback and webhook racing grant access once', async () => {
    const order = await start('M6');
    const body = makePayment(order);
    const payment = payments.get(body.razorpay_payment_id);
    const results = await Promise.all([
      post('/api/razorpay/verify-payment', org.tokens.admin, body),
      webhook(paymentEvent('payment.captured', payment)),
      webhook(paymentEvent('payment.captured', payment)),
      post('/api/razorpay/verify-payment', org.tokens.admin, body)
    ]);
    results.forEach((r) => expect(r.status).toBeLessThan(300));
    expect(await SubscriptionPurchase.countDocuments({ status: 'paid' })).toBe(1);
    expect(Math.abs((await entitlement(org.admin)).endDate - monthsFromNow(6))).toBeLessThan(60000);
  });

  test('sync finds a captured payment when neither callback nor webhook arrived', async () => {
    const order = await start('M1');
    const body = makePayment(order);
    mock.orders.fetchPayments.mockResolvedValue({ items: [payments.get(body.razorpay_payment_id)] });
    const res = await post(`/api/razorpay/order/${order.id}/sync`, org.tokens.admin);
    expect(res.body).toMatchObject({ state: 'paid', granted: true });
    expect((await entitlement(org.staff1)).status).toBe('paid');
  });
});

describe('webhooks', () => {
  const start = async (packId = 'M1') => (await buyOrder(org.tokens.admin, packId)).body.order;

  test('rejects missing or invalid signatures, including one made with the key secret', async () => {
    const order = await start();
    const event = paymentEvent('payment.captured', payments.get(makePayment(order).razorpay_payment_id));
    expect((await webhook(event, { signature: 'bad' })).status).toBe(400);
    expect((await webhook(event, { secret: 'unit_key_secret' })).status).toBe(400);
    const raw = await request(app).post('/api/razorpay/webhook').set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect(raw.status).toBe(400);
    expect((await entitlement(org.admin)).status).not.toBe('paid');
  });

  test('a captured webhook grants access with no browser callback', async () => {
    const order = await start('M12');
    const { razorpay_payment_id: id } = makePayment(order);
    const res = await webhook(paymentEvent('payment.captured', payments.get(id)));
    expect(res.status).toBe(200);
    const p = await SubscriptionPurchase.findOne({ orderId: order.id });
    expect(p).toMatchObject({ status: 'paid', paymentId: id, settledVia: 'webhook' });
    expect(Math.abs((await entitlement(org.staff2)).endDate - monthsFromNow(12))).toBeLessThan(60000);
  });

  test('duplicate event ids are processed once; a failed event is retried', async () => {
    const order = await start();
    const { razorpay_payment_id: id } = makePayment(order);
    const ev = paymentEvent('payment.captured', payments.get(id));
    expect((await webhook(ev, { eventId: 'evt_dup' })).body.outcome).toBe('paid');
    expect((await webhook(ev, { eventId: 'evt_dup' })).body.duplicate).toBe(true);
    expect(await RazorpayWebhookEvent.countDocuments({ eventId: 'evt_dup' })).toBe(1);
    await RazorpayWebhookEvent.updateOne({ eventId: 'evt_dup' }, { $set: { status: 'failed' } });
    expect((await webhook(ev, { eventId: 'evt_dup' })).status).toBe(200);
    expect((await RazorpayWebhookEvent.findOne({ eventId: 'evt_dup' })).status).toBe('done');
  });

  test('authorised, failed and mismatched-amount webhooks never grant access', async () => {
    const order = await start();
    for (const [type, over] of [['payment.authorized', { status: 'authorized', captured: false }], ['payment.failed', { status: 'failed', captured: false }]]) {
      const { razorpay_payment_id: id } = makePayment(order, over);
      await webhook(paymentEvent(type, payments.get(id)));
    }
    const bad = makePayment(order, { amount: 100 });
    expect((await webhook(paymentEvent('payment.captured', payments.get(bad.razorpay_payment_id)))).status).toBe(200);
    expect((await SubscriptionPurchase.findOne({ orderId: order.id })).status).toBe('failed');
    expect((await entitlement(org.admin)).status).not.toBe('paid');
  });

  test('a late failure event for a different attempt does not undo a paid order', async () => {
    const order = await start();
    const ok = makePayment(order);
    await post('/api/razorpay/verify-payment', org.tokens.admin, ok);
    const failed = makePayment(order, { status: 'failed', captured: false });
    await webhook(paymentEvent('payment.failed', payments.get(failed.razorpay_payment_id)));
    expect((await SubscriptionPurchase.findOne({ orderId: order.id })).status).toBe('paid');
  });

  test('a full refund removes the access; a partial refund does not; refund-before-capture blocks the grant', async () => {
    const o1 = await start('M1');
    const p1 = makePayment(o1);
    await post('/api/razorpay/verify-payment', org.tokens.admin, p1);
    const pay1 = payments.get(p1.razorpay_payment_id);
    await webhook(paymentEvent('refund.processed', { ...pay1, amount_refunded: 50000 }));
    expect((await entitlement(org.admin)).status).toBe('paid');
    await webhook(paymentEvent('refund.processed', { ...pay1, amount_refunded: pay1.amount }));
    expect((await SubscriptionPurchase.findOne({ orderId: o1.id })).status).toBe('refunded');
    expect((await entitlement(org.admin)).status).not.toBe('paid');

    const o2 = await start('M1');
    const p2 = makePayment(o2);
    const pay2 = payments.get(p2.razorpay_payment_id);
    await webhook(paymentEvent('refund.processed', { ...pay2, amount_refunded: pay2.amount }));
    await webhook(paymentEvent('payment.captured', pay2)); // out of order
    expect((await SubscriptionPurchase.findOne({ orderId: o2.id })).status).toBe('refunded');
  });

  test('a lost dispute removes access; an open or won dispute keeps it', async () => {
    const order = await start('M1');
    const p = makePayment(order);
    await post('/api/razorpay/verify-payment', org.tokens.admin, p);
    const pay = payments.get(p.razorpay_payment_id);
    await webhook(paymentEvent('payment.dispute.created', pay));
    expect((await SubscriptionPurchase.findOne({ orderId: order.id })).disputeStatus).toBe('open');
    expect((await entitlement(org.admin)).status).toBe('paid');
    await webhook(paymentEvent('payment.dispute.won', pay));
    expect((await entitlement(org.admin)).status).toBe('paid');
    await webhook(paymentEvent('payment.dispute.lost', pay));
    expect((await entitlement(org.admin)).status).not.toBe('paid');
  });

  test('events for orders that are not ours are acknowledged and ignored', async () => {
    const res = await webhook(paymentEvent('payment.captured', { id: 'pay_x', order_id: 'order_foreign', amount: 1, currency: 'INR', status: 'captured' }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unknown_order');
  });
});

describe('renewal and calendar months', () => {
  /** Create and settle a purchase as if it was paid at `paidAt`. */
  const settleAt = async (packId, paidAt) => {
    const { purchase } = await svc.createOrder(org.admin, packId);
    await svc.settlePayment(purchase, {
      id: `pay_${++seq}`, order_id: purchase.orderId, amount: purchase.amountPaise, currency: 'INR',
      status: 'captured', captured: true, created_at: Math.floor(new Date(paidAt).getTime() / 1000)
    }, 'webhook');
  };
  const ist = (s) => new Date(`${s}+05:30`);

  test('month-end handling uses IST and clamps to the last day', () => {
    expect(addCalendarMonthsIST(ist('2026-01-31T10:00:00'), 1)).toEqual(ist('2026-02-28T10:00:00'));
    expect(addCalendarMonthsIST(ist('2028-01-31T10:00:00'), 1)).toEqual(ist('2028-02-29T10:00:00'));
    expect(addCalendarMonthsIST(ist('2026-08-31T10:00:00'), 3)).toEqual(ist('2026-11-30T10:00:00'));
    expect(addCalendarMonthsIST(ist('2026-03-15T10:00:00'), 12)).toEqual(ist('2027-03-15T10:00:00'));
    // 00:30 IST on the 1st is still the previous day in UTC; the IST day must win.
    expect(addCalendarMonthsIST(ist('2026-03-01T00:30:00'), 1)).toEqual(ist('2026-04-01T00:30:00'));
  });

  test('renewing before expiry extends from the current expiry', async () => {
    const t = Date.now() - 5 * 86400000; // first pack bought 5 days ago
    await settleAt('M1', t);
    const first = (await entitlement(org.admin)).endDate;
    await settleAt('M3', Date.now());
    const second = (await entitlement(org.admin)).endDate;
    expect(second).toEqual(addCalendarMonthsIST(first, 3));
  });

  test('renewing after expiry starts from the payment time and never shortens access', async () => {
    // An unexpired free trial would correctly remain active between the two
    // historical purchases; this case isolates paid renewal after a lapse.
    await User.updateOne({ _id: org.admin._id }, { $set: { 'subscription.isActive': false } });
    await settleAt('M1', ist('2026-01-31T10:00:00'));
    expect((await entitlement(org.admin)).endDate).toEqual(ist('2026-02-28T10:00:00'));
    const paid = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
    await settleAt('M1', paid);
    const ent = await entitlement(org.admin);
    expect(ent.endDate).toEqual(addCalendarMonthsIST(paid, 1));
    expect(ent.startDate).toEqual(paid);
    await User.updateOne({ _id: org.admin._id }, { $set: { 'subscription.isActive': true } });
  });

  test('a late webhook for an earlier payment lands in order and gives the same expiry', async () => {
    const early = Math.floor((Date.now() - 10 * 86400000) / 1000) * 1000;
    await settleAt('M1', Date.now());
    await settleAt('M1', early); // arrives second but was paid first
    const ent = await entitlement(org.admin);
    expect(ent.endDate).toEqual(addCalendarMonthsIST(addCalendarMonthsIST(early, 1), 1));
  });
});

describe('scheduled reconciliation', () => {
  test('settles an old open order whose callback and webhook never arrived, once', async () => {
    const { body: { order } } = await buyOrder(org.tokens.admin, 'M1');
    const body = makePayment(order);
    mock.orders.fetchPayments.mockResolvedValue({ items: [payments.get(body.razorpay_payment_id)] });
    // Too fresh: left for the callback/webhook.
    expect(await svc.reconcileOpenPurchases()).toEqual({ checked: 0, settled: 0 });
    // createdAt is immutable through Mongoose, so age the order in the raw collection.
    await SubscriptionPurchase.collection.updateOne({ orderId: order.id }, { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } });
    expect(await svc.reconcileOpenPurchases()).toEqual({ checked: 1, settled: 1 });
    expect(await svc.reconcileOpenPurchases()).toEqual({ checked: 0, settled: 0 });
    expect((await entitlement(org.staff1)).status).toBe('paid');
  });

  test('an order with no captured payment stays open and one provider error does not stop the sweep', async () => {
    const a = (await buyOrder(org.tokens.admin, 'M1')).body.order;
    const b = (await buyOrder(org.tokens.admin, 'M1')).body.order;
    await SubscriptionPurchase.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } });
    const pay = makePayment(b);
    mock.orders.fetchPayments.mockImplementation(async (id) => {
      if (id === a.id) throw new Error('provider down');
      return { items: [payments.get(pay.razorpay_payment_id)] };
    });
    expect(await svc.reconcileOpenPurchases()).toEqual({ checked: 2, settled: 1 });
    expect((await SubscriptionPurchase.findOne({ orderId: a.id })).status).toBe('created');
  });
});
