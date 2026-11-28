/**
 * The production pipeline numbers (one rule for the board and the dashboard),
 * the light board endpoint, the cached plan entitlement and the throttled
 * Razorpay status check.
 */
const request = require('supertest');
const app = require('../src/app');
const Job = require('../src/models/Job');
const SubscriptionPurchase = require('../src/models/SubscriptionPurchase');
const svc = require('../src/services/subscriptionService');
const rzp = require('../src/services/razorpayClient');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;

beforeAll(async () => {
  await connectTestDb('perfpipe');
  org = await createOrg('pp', { staffPermissions: ['Dashboard'] });
  cust = await make.customer(org.admin);
  const day = 864e5;
  const statuses = ['inquiry', 'inquiry', 'quotation_sent', 'quotation_approved', 'design_in_progress', 'ready_for_print', 'quality_check', 'completed', 'delivered', 'cancelled'];
  for (const [i, status] of statuses.entries()) {
    await make.job(org.admin, cust, { status, priority: i === 4 ? 'urgent' : 'medium', dueDate: new Date(Date.now() + (i % 2 ? -2 : 3) * day) });
  }
  // A delivery scheduled for a job that is still in production must not count as "awaiting dispatch".
  const inProd = await Job.findOne({ dataScope: org.dataScope, status: 'design_in_progress' });
  await make.delivery(org.admin, cust, inProd);
});
afterAll(disconnectTestDb);

const get = (url, token = org.tokens.admin) => request(app).get(url).set(auth(token));

describe('pipeline counts', () => {
  test('the board counts every stage, enquiries included, from one rule', async () => {
    const res = await get('/api/jobs/board');
    expect(res.status).toBe(200);
    const { counts, totals, jobs } = res.body.data;
    expect(counts).toMatchObject({ inquiry: 2, quotation_sent: 1, quotation_approved: 1, completed: 1, delivered: 1, cancelled: 1 });
    expect(totals).toMatchObject({ all: 10, open: 8, preProduction: 3, inProduction: 4, readyForDispatch: 1, delivered: 1, cancelled: 1, rush: 1 });
    // Open jobs plus recent deliveries; cancelled jobs are not cards.
    expect(jobs.map((j) => j.status).sort()).not.toContain('cancelled');
    expect(jobs.filter((j) => j.status === 'inquiry')).toHaveLength(2);
    // Cards are light: no invoices or line items.
    expect(jobs[0].items).toBeUndefined();
    expect(jobs[0].customerId.name).toBeTruthy();
  });

  test('awaiting dispatch on the dashboard equals the board\'s Ready to Dispatch stage', async () => {
    const [dash, board] = await Promise.all([get('/api/dashboard/stats'), get('/api/jobs/board')]);
    expect(dash.body.stats.readyForDispatch).toBe(board.body.data.totals.readyForDispatch);
    expect(dash.body.stats.readyForDispatch).toBe(1);
    // Deliveries in progress are reported separately.
    expect(dash.body.stats.pendingDeliveries).toBe(1);
  });

  test('another business sees none of these jobs', async () => {
    const other = await createOrg('ppo');
    const res = await get('/api/jobs/board', other.tokens.admin);
    expect(res.body.data.totals.all).toBe(0);
    expect(res.body.data.jobs).toHaveLength(0);
  });

  test('a login without Jobs cannot read the board', async () => {
    expect((await get('/api/jobs/board', org.tokens.staff1)).status).toBe(403);
  });
});

describe('job list', () => {
  test('pages and counts together, with an invoice summary but no invoice lines', async () => {
    const job = await Job.findOne({ dataScope: org.dataScope, status: 'completed' });
    const inv = await make.invoice(org.admin, cust, { jobId: job._id });
    const res = await get('/api/jobs?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toHaveLength(3);
    expect(res.body.data.pagination).toMatchObject({ totalJobs: 10, total: 4 });
    const all = await get('/api/jobs?limit=50');
    const withInvoice = all.body.data.jobs.find((j) => j._id === String(job._id));
    expect(withInvoice.invoices[0].invoiceNumber).toBe(inv.invoiceNumber);
    expect(withInvoice.invoices[0].items).toBeUndefined();
  });
});

describe('plan entitlement cache', () => {
  const saved = process.env.ENTITLEMENT_CACHE_MS;
  afterEach(() => { process.env.ENTITLEMENT_CACHE_MS = saved; svc.invalidateEntitlements(); });

  test('is reused between requests and cleared when a purchase changes', async () => {
    process.env.ENTITLEMENT_CACHE_MS = '60000';
    const o = await createOrg('ppc');
    const first = await svc.getEntitlement(o.admin);
    expect(first.status).toBe('trial');
    const spy = jest.spyOn(SubscriptionPurchase, 'find');
    await svc.getEntitlement(o.admin);
    await Promise.all([svc.getEntitlement(o.admin), svc.getEntitlement(o.manager)]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // A paid purchase lands: the cache is dropped at once.
    await SubscriptionPurchase.create({
      workspaceKey: svc.workspaceKeyFor(o.admin), dataScope: o.dataScope, purchasedBy: o.admin._id, packId: 'm1', months: 1,
      amountPaise: 100, currency: 'INR', receipt: 'r1', orderId: `order_${Date.now()}`, status: 'paid', paidAt: new Date()
    });
    expect((await svc.getEntitlement(o.admin)).status).toBe('paid');
  });

  test('never outlives the plan\'s end date', async () => {
    process.env.ENTITLEMENT_CACHE_MS = '60000';
    const o = await createOrg('ppe');
    const User = require('../src/models/User');
    await User.updateOne({ _id: o.admin._id }, { 'subscription.endDate': new Date(Date.now() + 300) });
    expect((await svc.getEntitlement(o.admin)).isActive).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect((await svc.getEntitlement(o.admin)).isActive).toBe(false);
  });
});

describe('Razorpay order status checks', () => {
  test('the same order is asked about at most once per interval', async () => {
    const saved = process.env.RAZORPAY_SYNC_MIN_INTERVAL_MS;
    process.env.RAZORPAY_SYNC_MIN_INTERVAL_MS = '30000';
    const fetchPayments = jest.fn().mockResolvedValue({ items: [] });
    const client = jest.spyOn(rzp, 'getClient').mockReturnValue({ orders: { fetchPayments } });
    try {
      const o = await createOrg('ppr');
      const purchase = await SubscriptionPurchase.create({
        workspaceKey: svc.workspaceKeyFor(o.admin), dataScope: o.dataScope, purchasedBy: o.admin._id, packId: 'm1', months: 1,
        amountPaise: 100, currency: 'INR', receipt: 'r2', orderId: `order_t_${Date.now()}`
      });
      const results = await Promise.all([svc.syncPurchase(purchase), svc.syncPurchase(purchase), svc.syncPurchase(purchase)]);
      expect(fetchPayments).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.throttled)).toHaveLength(2);
      expect(results.every((r) => r.granted === false)).toBe(true);
    } finally {
      client.mockRestore();
      process.env.RAZORPAY_SYNC_MIN_INTERVAL_MS = saved;
    }
  });
});

describe('request timing', () => {
  test('every API response carries Server-Timing', async () => {
    const res = await get('/api/auth/me');
    expect(res.headers['server-timing']).toMatch(/^app;dur=\d+(\.\d+)?$/);
  });
});
