/**
 * Customer payments and invoice balances (services/paymentLedger.js): every
 * receipt is a Payment, invoices move with their payments in one step, and
 * advances stay on account until they are applied.
 *
 * Runs against whatever MONGODB_TEST_URI points at: a standalone MongoDB
 * exercises the step-by-step fallback, a replica set the transactions.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Payment = require('../src/models/Payment');
const ActivityLog = require('../src/models/ActivityLog');
const User = require('../src/models/User');
const transactions = require('../src/utils/transactions');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
let keyCount = 0;
const newKey = () => `test-key-${Date.now()}-${++keyCount}`;

const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(token)).send(body),
  delete: (url) => request(app).delete(url).set(auth(token))
});
let admin;

/** An issued invoice for `amount` with no GST, so totals are easy to read. */
const invoiceFor = (amount, customer = cust, extra = {}) => make.invoice(org.admin, customer, { lines: [{ amount, rate: 0 }], ...extra });

const pay = (body) => admin.post('/api/payments', { customerId: String(cust._id), paymentMethod: 'upi', idempotencyKey: newKey(), ...body });
const state = async (invoice) => {
  const i = await Invoice.findById(invoice._id);
  return { paidAmount: i.paidAmount, balanceAmount: i.balanceAmount, paymentStatus: i.paymentStatus, status: i.status };
};
const details = async (invoice) => (await admin.get(`/api/invoices/${invoice._id}`)).body.data;

/**
 * The books agree: every invoice's paid amount is its completed allocations
 * plus what was recorded on it directly, its balance is total − paid, and
 * every received rupee is either applied to an invoice or on account.
 */
async function expectConsistent() {
  const invoices = await Invoice.find({ dataScope: org.dataScope });
  const payments = await Payment.find({ dataScope: org.dataScope });
  const applied = new Map();
  let allocatedTotal = 0;
  let receivedTotal = 0;
  let onAccountTotal = 0;
  for (const p of payments) {
    const allocations = p.allocations?.length ? p.allocations : p.invoiceId ? [{ invoiceId: p.invoiceId, amount: p.amount }] : [];
    const sum = allocations.reduce((s, a) => s + a.amount, 0);
    expect(sum).toBeLessThanOrEqual(p.amount + 0.005);
    if (p.status !== 'completed') continue;
    receivedTotal += p.amount;
    allocatedTotal += sum;
    onAccountTotal += p.amount - sum;
    for (const a of allocations) applied.set(String(a.invoiceId), (applied.get(String(a.invoiceId)) || 0) + a.amount);
  }
  for (const inv of invoices) {
    const manual = inv.manualPaidAmount || 0;
    expect(inv.paidAmount).toBeCloseTo((applied.get(String(inv._id)) || 0) + manual, 2);
    expect(inv.balanceAmount).toBeCloseTo(inv.totalAmount - inv.paidAmount, 2);
    expect(inv.paidAmount).toBeLessThanOrEqual(inv.totalAmount + 0.005);
    expect(inv.paidAmount).toBeGreaterThanOrEqual(0);
  }
  const summary = (await admin.get('/api/payments?limit=1')).body.data.summary;
  expect(summary.completed.amount).toBeCloseTo(receivedTotal, 2);
  expect(summary.onAccount.amount).toBeCloseTo(onAccountTotal, 2);
  const stats = (await admin.get('/api/payments/stats/summary')).body.data.stats;
  expect(stats.totalAmount).toBeCloseTo(receivedTotal, 2);
  return { receivedTotal, allocatedTotal, onAccountTotal };
}

beforeAll(async () => {
  await connectTestDb('ledger');
  // The idempotency key's unique index must exist before concurrent submissions.
  await Payment.init();
  org = await createOrg('pl');
  other = await createOrg('po');
  admin = as(org.tokens.admin);
  cust = await make.customer(org.admin, { name: 'Lotus Publications' });
});
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

test('the suite knows which write path it is exercising', async () => {
  const supported = await transactions.supportsTransactions();
  // EXPECT_TRANSACTIONS=true|false pins it, so a run meant for one path cannot silently test the other.
  if (process.env.EXPECT_TRANSACTIONS) expect(String(supported)).toBe(process.env.EXPECT_TRANSACTIONS);
  const startSession = jest.spyOn(require('mongoose'), 'startSession');
  const inv = await invoiceFor(100);
  expect((await pay({ invoiceId: String(inv._id), amount: 10 })).status).toBe(201);
  expect(startSession).toHaveBeenCalledTimes(supported ? 1 : 0);
});

describe('recording receipts against invoices', () => {
  test('unpaid → partial → full, with the history on the invoice', async () => {
    const inv = await invoiceFor(1000);
    expect(await state(inv)).toEqual({ paidAmount: 0, balanceAmount: 1000, paymentStatus: 'pending', status: 'sent' });

    const first = await pay({ invoiceId: String(inv._id), amount: 400, referenceNumber: 'UPI-1', paymentDate: '2026-11-01' });
    expect(first.status).toBe(201);
    expect(first.body.data.payment).toMatchObject({ invoiceNumber: inv.invoiceNumber, allocatedAmount: 400, unallocatedAmount: 0 });
    expect(first.body.data.payment.allocations).toEqual([expect.objectContaining({ invoiceId: String(inv._id), amount: 400 })]);
    expect(await state(inv)).toEqual({ paidAmount: 400, balanceAmount: 600, paymentStatus: 'partial', status: 'sent' });

    const second = await pay({ invoiceId: String(inv._id), amount: 600, paymentMethod: 'cash' });
    expect(second.status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 1000, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });

    const view = await details(inv);
    expect(view.paymentHistory.map((p) => [p.appliedAmount, p.paymentMethod])).toEqual(expect.arrayContaining([[400, 'upi'], [600, 'cash']]));
    expect(view.paymentSummary).toEqual({ recordedAmount: 1000, manualPaidAmount: 0 });
    await expectConsistent();
  });

  test('one payment split across several invoices of the customer', async () => {
    const a = await invoiceFor(500);
    const b = await invoiceFor(800);
    const res = await pay({ amount: 1000, allocations: [{ invoiceId: String(a._id), amount: 500 }, { invoiceId: String(b._id), amount: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ allocatedAmount: 1000, unallocatedAmount: 0 });
    // Split across two, so no single invoice is named on the payment.
    expect(res.body.data.payment.invoiceId).toBeFalsy();
    expect(await state(a)).toMatchObject({ paidAmount: 500, paymentStatus: 'paid' });
    expect(await state(b)).toMatchObject({ paidAmount: 500, balanceAmount: 300, paymentStatus: 'partial' });
    expect((await details(b)).paymentHistory[0]).toMatchObject({ amount: 1000, appliedAmount: 500 });
    // Found by either invoice number.
    const found = await admin.get(`/api/payments?search=${b.invoiceNumber}`);
    expect(found.body.data.payments.map((p) => p._id)).toContain(res.body.data.payment._id);
    await expectConsistent();
  });

  test('refuses more than an invoice still owes, and allocations above the payment', async () => {
    const inv = await invoiceFor(300);
    const over = await pay({ invoiceId: String(inv._id), amount: 301 });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    const tooMuch = await pay({ amount: 100, allocations: [{ invoiceId: String(inv._id), amount: 150 }] });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.code).toBe('ALLOCATION_EXCEEDS_PAYMENT');
    const twice = await pay({ amount: 100, allocations: [{ invoiceId: String(inv._id), amount: 50 }, { invoiceId: String(inv._id), amount: 50 }] });
    expect(twice.status).toBe(400);
    expect(twice.body.code).toBe('DUPLICATE_ALLOCATION');
    expect(await state(inv)).toMatchObject({ paidAmount: 0 });
    expect(await Payment.countDocuments({ 'allocations.invoiceId': inv._id })).toBe(0);
  });

  test('refuses drafts, cancelled invoices and another customer\'s invoice', async () => {
    const draft = await invoiceFor(100, cust, { status: 'draft' });
    const cancelled = await invoiceFor(100, cust, { status: 'cancelled' });
    const someoneElse = await make.customer(org.admin);
    const theirs = await invoiceFor(100, someoneElse);
    expect((await pay({ invoiceId: String(draft._id), amount: 50 })).status).toBe(400);
    expect((await pay({ invoiceId: String(cancelled._id), amount: 50 })).status).toBe(400);
    expect((await pay({ invoiceId: String(theirs._id), amount: 50 })).body.code).toBe('WRONG_CUSTOMER');
    const foreign = await make.invoice(other.admin, await make.customer(other.admin), { lines: [{ amount: 100, rate: 0 }] });
    expect((await pay({ invoiceId: String(foreign._id), amount: 50 })).status).toBe(404);
  });
});

describe('advances on account', () => {
  test('stays unallocated until applied; part to one invoice, the rest to another', async () => {
    const a = await invoiceFor(600);
    const b = await invoiceFor(900);
    const advance = await pay({ amount: 1000, referenceNumber: 'ADV-1' });
    expect(advance.status).toBe(201);
    const id = advance.body.data.payment._id;
    expect(advance.body.data.payment).toMatchObject({ allocatedAmount: 0, unallocatedAmount: 1000, allocations: [] });
    expect(await state(a)).toMatchObject({ paidAmount: 0 });
    let summary = (await admin.get('/api/payments?limit=1')).body.data.summary;
    expect(summary.onAccount.amount).toBeGreaterThanOrEqual(1000);

    // 400 to the first invoice.
    let res = await admin.put(`/api/payments/${id}/allocations`, { allocations: [{ invoiceId: String(a._id), amount: 400 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.payment).toMatchObject({ allocatedAmount: 400, unallocatedAmount: 600, invoiceNumber: a.invoiceNumber });
    expect(await state(a)).toMatchObject({ paidAmount: 400, paymentStatus: 'partial' });

    // The remaining 600 to the second, keeping the first.
    const both = [{ invoiceId: String(a._id), amount: 400 }, { invoiceId: String(b._id), amount: 600 }];
    res = await admin.put(`/api/payments/${id}/allocations`, { allocations: both, version: res.body.data.payment.__v });
    expect(res.status).toBe(200);
    expect(res.body.data.payment).toMatchObject({ allocatedAmount: 1000, unallocatedAmount: 0 });
    expect(res.body.data.payment.invoiceId).toBeFalsy();
    expect(await state(b)).toMatchObject({ paidAmount: 600, balanceAmount: 300 });

    // Sending the same allocations again changes nothing.
    res = await admin.put(`/api/payments/${id}/allocations`, { allocations: both });
    expect(res.status).toBe(200);
    expect(await state(a)).toMatchObject({ paidAmount: 400 });
    expect(await state(b)).toMatchObject({ paidAmount: 600 });

    // Beyond the advance, or beyond an invoice's balance: refused, nothing moves.
    const more = await admin.put(`/api/payments/${id}/allocations`, { allocations: [{ invoiceId: String(a._id), amount: 500 }, { invoiceId: String(b._id), amount: 600 }] });
    expect(more.status).toBe(400);
    expect(more.body.code).toBe('ALLOCATION_EXCEEDS_PAYMENT');
    const bigAdvance = (await pay({ amount: 5000 })).body.data.payment._id;
    const pastBalance = await admin.put(`/api/payments/${bigAdvance}/allocations`, { allocations: [{ invoiceId: String(b._id), amount: 301 }] });
    expect(pastBalance.status).toBe(400);
    expect(pastBalance.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(await state(b)).toMatchObject({ paidAmount: 600 });

    // A stale version is refused.
    const stale = await admin.put(`/api/payments/${id}/allocations`, { allocations: [], version: 0 });
    expect(stale.status).toBe(409);

    // Taking the first invoice off puts its 400 back on account.
    res = await admin.put(`/api/payments/${id}/allocations`, { allocations: [{ invoiceId: String(b._id), amount: 600 }] });
    expect(res.body.data.payment).toMatchObject({ unallocatedAmount: 400, invoiceNumber: b.invoiceNumber });
    expect(await state(a)).toMatchObject({ paidAmount: 0, paymentStatus: 'pending' });
    summary = (await admin.get('/api/payments?limit=1')).body.data.summary;
    expect(summary.onAccount.amount).toBeGreaterThanOrEqual(400);
    await expectConsistent();
  });

  test('an advance cannot be applied to another customer\'s invoice', async () => {
    const someoneElse = await make.customer(org.admin);
    const theirs = await invoiceFor(500, someoneElse);
    const advance = (await pay({ amount: 200 })).body.data.payment._id;
    const res = await admin.put(`/api/payments/${advance}/allocations`, { allocations: [{ invoiceId: String(theirs._id), amount: 200 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WRONG_CUSTOMER');
  });
});

describe('reversals, edits and deletion', () => {
  test('refunding or bouncing a split payment takes it off every invoice; receiving it again puts it back', async () => {
    const a = await invoiceFor(500);
    const b = await invoiceFor(500);
    const id = (await pay({ amount: 700, allocations: [{ invoiceId: String(a._id), amount: 500 }, { invoiceId: String(b._id), amount: 200 }] })).body.data.payment._id;
    expect(await state(a)).toMatchObject({ paidAmount: 500, status: 'paid' });

    expect((await admin.put(`/api/payments/${id}`, { status: 'refunded' })).status).toBe(200);
    expect(await state(a)).toEqual({ paidAmount: 0, balanceAmount: 500, paymentStatus: 'pending', status: 'sent' });
    expect(await state(b)).toMatchObject({ paidAmount: 0 });
    const refunded = await Payment.findById(id);
    expect(refunded.refundDetails.refundAmount).toBe(700);
    // Its allocations stay on the record, so the history still shows what it paid.
    expect(refunded.allocations).toHaveLength(2);
    expect((await details(a)).paymentHistory[0]).toMatchObject({ status: 'refunded', appliedAmount: 500 });

    expect((await admin.put(`/api/payments/${id}`, { status: 'completed' })).status).toBe(200);
    expect(await state(a)).toMatchObject({ paidAmount: 500 });
    expect(await state(b)).toMatchObject({ paidAmount: 200 });

    expect((await admin.put(`/api/payments/${id}`, { status: 'failed' })).status).toBe(200);
    expect(await state(b)).toMatchObject({ paidAmount: 0 });
    await expectConsistent();
  });

  test('a payment against one invoice follows its amount; a split one must still fit', async () => {
    const inv = await invoiceFor(1000);
    const single = (await pay({ invoiceId: String(inv._id), amount: 300 })).body.data.payment._id;
    expect((await admin.put(`/api/payments/${single}`, { amount: 350 })).status).toBe(200);
    expect(await state(inv)).toMatchObject({ paidAmount: 350 });
    const over = await admin.put(`/api/payments/${single}`, { amount: 1001 });
    expect(over.status).toBe(400);
    expect(await state(inv)).toMatchObject({ paidAmount: 350 });

    const other1 = await invoiceFor(100);
    const split = (await pay({ amount: 500, allocations: [{ invoiceId: String(inv._id), amount: 200 }, { invoiceId: String(other1._id), amount: 100 }] })).body.data.payment._id;
    // Raising it leaves the extra on account; lowering below what is applied is refused.
    const raised = await admin.put(`/api/payments/${split}`, { amount: 600 });
    expect(raised.body.data.payment).toMatchObject({ allocatedAmount: 300, unallocatedAmount: 300 });
    const lowered = await admin.put(`/api/payments/${split}`, { amount: 250 });
    expect(lowered.status).toBe(400);
    expect(lowered.body.code).toBe('ALLOCATION_EXCEEDS_PAYMENT');
    await expectConsistent();
  });

  test('deleting a payment takes it off every invoice it paid', async () => {
    const a = await invoiceFor(400);
    const b = await invoiceFor(400);
    const id = (await pay({ amount: 600, allocations: [{ invoiceId: String(a._id), amount: 400 }, { invoiceId: String(b._id), amount: 200 }] })).body.data.payment._id;
    expect((await admin.delete(`/api/payments/${id}`)).status).toBe(200);
    expect(await Payment.findById(id)).toBeNull();
    expect(await state(a)).toMatchObject({ paidAmount: 0, paymentStatus: 'pending', status: 'sent' });
    expect(await state(b)).toMatchObject({ paidAmount: 0 });
    const logged = await ActivityLog.findOne({ action: 'Payment Deleted', entityId: id }).lean();
    expect(logged.severity).toBe('high');
    expect(logged.changes.before).toMatchObject({ amount: 600, status: 'completed' });
    expect(logged.changes.before.allocations).toHaveLength(2);
    await expectConsistent();
  });

  test('an invoice with payments applied cannot be deleted or cancelled until they are taken off', async () => {
    const inv = await invoiceFor(500);
    const id = (await pay({ invoiceId: String(inv._id), amount: 200 })).body.data.payment._id;
    const del = await admin.delete(`/api/invoices/${inv._id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('INVOICE_HAS_PAYMENTS');
    const cancel = await admin.patch(`/api/invoices/${inv._id}/cancel`, { reason: 'Wrong customer' });
    expect(cancel.status).toBe(409);
    expect((await Invoice.findById(inv._id)).status).toBe('sent');

    // Taken off: the money stays on account and the invoice can go.
    await admin.put(`/api/payments/${id}/allocations`, { allocations: [] });
    expect((await admin.delete(`/api/invoices/${inv._id}`)).status).toBe(200);
    expect((await Payment.findById(id)).allocations).toHaveLength(0);
    await expectConsistent();
  });
});

describe('repeated and concurrent submissions', () => {
  test('the same idempotency key records one payment, even sent at once', async () => {
    const inv = await invoiceFor(1000);
    const key = newKey();
    const body = { customerId: String(cust._id), invoiceId: String(inv._id), amount: 250, paymentMethod: 'cash', idempotencyKey: key };
    const [r1, r2, r3] = await Promise.all([admin.post('/api/payments', body), admin.post('/api/payments', body), admin.post('/api/payments', body)]);
    expect([r1, r2, r3].every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set([r1, r2, r3].map((r) => r.body.data.payment._id)).size).toBe(1);
    expect([r1, r2, r3].filter((r) => r.status === 201)).toHaveLength(1);
    expect(await Payment.countDocuments({ idempotencyKey: key })).toBe(1);
    expect(await state(inv)).toMatchObject({ paidAmount: 250 });

    // A key reused for a different payment is refused.
    const reused = await admin.post('/api/payments', { ...body, amount: 999 });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await expectConsistent();
  });

  test('an identical retry returns the original payment, however its allocations and date are written', async () => {
    const a = await invoiceFor(1000);
    const b = await invoiceFor(1000);
    const key = newKey();
    const body = {
      customerId: String(cust._id),
      amount: 600,
      paymentMethod: 'cheque',
      status: 'completed',
      paymentDate: '2026-11-02',
      referenceNumber: 'CHQ-104',
      notes: 'Cheque handed over at the counter',
      allocations: [{ invoiceId: String(a._id), amount: 400 }, { invoiceId: String(b._id), amount: 200 }],
      idempotencyKey: key
    };
    const first = await admin.post('/api/payments', body);
    expect(first.status).toBe(201);
    expect(first.body.data.payment.idempotencyFingerprint).toBeUndefined();

    const retry = await admin.post('/api/payments', body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.data.payment._id).toBe(first.body.data.payment._id);

    // The same request written differently: allocations reordered, the date
    // as a full timestamp, the key in the header instead of the body.
    const { idempotencyKey, ...rest } = body;
    const reordered = await request(app).post('/api/payments').set(auth(org.tokens.admin)).set('Idempotency-Key', idempotencyKey).send({
      ...rest,
      paymentDate: '2026-11-02T00:00:00.000Z',
      allocations: [...body.allocations].reverse()
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.payment._id).toBe(first.body.data.payment._id);

    // Recording against one invoice by invoiceId is the same as one allocation of the whole amount.
    const singleKey = newKey();
    const viaInvoiceId = await admin.post('/api/payments', { customerId: String(cust._id), invoiceId: String(a._id), amount: 100, paymentMethod: 'upi', idempotencyKey: singleKey });
    expect(viaInvoiceId.status).toBe(201);
    const viaAllocations = await admin.post('/api/payments', { customerId: String(cust._id), allocations: [{ invoiceId: String(a._id), amount: 100 }], amount: 100, paymentMethod: 'upi', idempotencyKey: singleKey });
    expect(viaAllocations.status).toBe(200);
    expect(viaAllocations.body.data.payment._id).toBe(viaInvoiceId.body.data.payment._id);

    expect(await Payment.countDocuments({ idempotencyKey: { $in: [key, singleKey] } })).toBe(2);
    expect(await state(a)).toMatchObject({ paidAmount: 500 });
    expect(await state(b)).toMatchObject({ paidAmount: 200 });
    await expectConsistent();
  });

  test('the same key with the same customer and amount but a different invoice is refused, and records nothing', async () => {
    const a = await invoiceFor(1000);
    const b = await invoiceFor(1000);
    const key = newKey();
    const body = { customerId: String(cust._id), invoiceId: String(a._id), amount: 300, paymentMethod: 'upi', paymentDate: '2026-11-03', referenceNumber: 'UPI-9', idempotencyKey: key };
    const first = await admin.post('/api/payments', body);
    expect(first.status).toBe(201);

    const otherInvoice = await admin.post('/api/payments', { ...body, invoiceId: String(b._id) });
    expect(otherInvoice.status).toBe(409);
    expect(otherInvoice.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await state(b)).toMatchObject({ paidAmount: 0 });

    // Every other part of the request counts too.
    for (const change of [
      { paymentMethod: 'cash' },
      { status: 'pending' },
      { paymentDate: '2026-11-04' },
      { referenceNumber: 'UPI-10' },
      { notes: 'Different note' },
      { invoiceId: undefined },
      { invoiceId: undefined, allocations: [{ invoiceId: String(a._id), amount: 200 }] }
    ]) {
      const res = await admin.post('/api/payments', { ...body, ...change });
      expect([JSON.stringify(change), res.status, res.body.code]).toEqual([JSON.stringify(change), 409, 'IDEMPOTENCY_KEY_REUSED']);
    }
    expect(await Payment.countDocuments({ idempotencyKey: key })).toBe(1);
    expect(await state(a)).toMatchObject({ paidAmount: 300 });

    // Sent at the same moment: one is recorded, the other refused, never two.
    const raceKey = newKey();
    const race = await Promise.all([
      admin.post('/api/payments', { ...body, idempotencyKey: raceKey }),
      admin.post('/api/payments', { ...body, invoiceId: String(b._id), idempotencyKey: raceKey })
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await Payment.countDocuments({ idempotencyKey: raceKey })).toBe(1);
    expect((await state(a)).paidAmount + (await state(b)).paidAmount).toBe(600);
    await expectConsistent();
  });

  test('two payments racing for the last of a balance: one lands, the invoice is never overpaid', async () => {
    const inv = await invoiceFor(1000);
    const results = await Promise.all([700, 700, 700].map((amount) => pay({ invoiceId: String(inv._id), amount })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => [400, 409].includes(r.status))).toBe(true);
    expect(await state(inv)).toMatchObject({ paidAmount: 700, balanceAmount: 300 });
    expect(await Payment.countDocuments({ 'allocations.invoiceId': inv._id })).toBe(1);
    await expectConsistent();
  });

  test('allocating one advance to two invoices at once never allocates more than it holds', async () => {
    const a = await invoiceFor(1000);
    const b = await invoiceFor(1000);
    const id = (await pay({ amount: 600 })).body.data.payment._id;
    const [ra, rb] = await Promise.all([
      admin.put(`/api/payments/${id}/allocations`, { allocations: [{ invoiceId: String(a._id), amount: 600 }], version: 0 }),
      admin.put(`/api/payments/${id}/allocations`, { allocations: [{ invoiceId: String(b._id), amount: 600 }], version: 0 })
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const paidA = (await state(a)).paidAmount;
    const paidB = (await state(b)).paidAmount;
    expect(paidA + paidB).toBe(600);
    await expectConsistent();
  });

  test('a failure part-way leaves neither the payment nor the invoice change behind', async () => {
    const inv = await invoiceFor(1000);
    jest.spyOn(Payment, 'create').mockRejectedValueOnce(new Error('disk full'));
    const res = await pay({ invoiceId: String(inv._id), amount: 400 });
    expect(res.status).toBe(500);
    expect(await state(inv)).toMatchObject({ paidAmount: 0, balanceAmount: 1000 });
    expect(await Payment.countDocuments({ 'allocations.invoiceId': inv._id })).toBe(0);

    // The same on an edit: the payment write fails after the invoice moved.
    const id = (await pay({ invoiceId: String(inv._id), amount: 400 })).body.data.payment._id;
    jest.spyOn(Payment, 'findOneAndUpdate').mockResolvedValueOnce(null);
    const edit = await admin.put(`/api/payments/${id}`, { amount: 600 });
    expect(edit.status).toBe(409);
    expect(await state(inv)).toMatchObject({ paidAmount: 400 });
    expect((await Payment.findById(id)).amount).toBe(400);
    await expectConsistent();
  });

  test('an invoice edited after a payment landed is refused instead of overwriting the balance', async () => {
    const inv = await invoiceFor(1000);
    const stale = await Invoice.findById(inv._id);
    await pay({ invoiceId: String(inv._id), amount: 300 });
    // Simulate an edit that read the invoice before the payment.
    stale.notes = 'Edited from an old screen';
    stale.increment();
    await expect(stale.save()).rejects.toMatchObject({ name: 'VersionError' });
    expect(await state(inv)).toMatchObject({ paidAmount: 300, balanceAmount: 700 });
    // Through the API, an edit after the payment works and keeps it.
    const edit = await admin.put(`/api/invoices/${inv._id}`, { notes: 'Deliver Friday' });
    expect(edit.status).toBe(200);
    expect(await state(inv)).toMatchObject({ paidAmount: 300, balanceAmount: 700 });
  });
});

describe('records made before allocations existed', () => {
  test('an old payment naming an invoice reads as applied in full, and can be reversed or moved', async () => {
    const inv = await invoiceFor(1000);
    // As older code stored it: invoiceId, no allocations, invoice moved by hand.
    const old = await make.payment(org.admin, cust, { invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, amount: 300 });
    await Invoice.updateOne({ _id: inv._id }, { paidAmount: 300, balanceAmount: 700, paymentStatus: 'partial' });

    const listed = (await admin.get('/api/payments?limit=100')).body.data.payments.find((p) => p._id === String(old._id));
    expect(listed).toMatchObject({ allocatedAmount: 300, unallocatedAmount: 0, allocations: [expect.objectContaining({ invoiceId: String(inv._id), amount: 300 })] });
    expect((await details(inv)).paymentHistory[0]).toMatchObject({ appliedAmount: 300 });

    expect((await admin.put(`/api/payments/${old._id}`, { status: 'refunded' })).status).toBe(200);
    expect(await state(inv)).toMatchObject({ paidAmount: 0 });
    expect((await admin.put(`/api/payments/${old._id}`, { status: 'completed' })).status).toBe(200);
    expect(await state(inv)).toMatchObject({ paidAmount: 300 });
    // Moving it back on account converts it to the new shape.
    const moved = await admin.put(`/api/payments/${old._id}/allocations`, { allocations: [] });
    expect(moved.body.data.payment).toMatchObject({ unallocatedAmount: 300, allocations: [] });
    expect(moved.body.data.payment.invoiceId).toBeFalsy();
    expect(await state(inv)).toMatchObject({ paidAmount: 0 });
    await expectConsistent();
  });

  test('an old on-account payment (no invoice) is an advance', async () => {
    const old = await make.payment(org.admin, cust, { amount: 150 });
    const listed = (await admin.get('/api/payments?limit=100')).body.data.payments.find((p) => p._id === String(old._id));
    expect(listed).toMatchObject({ allocatedAmount: 0, unallocatedAmount: 150 });
  });
});

describe('balance correction (amounts recorded outside payments)', () => {
  test('changes only the manual part, needs a reason, is logged, and cannot exceed the total', async () => {
    const inv = await invoiceFor(1000);
    await pay({ invoiceId: String(inv._id), amount: 300 });
    // An older invoice: 500 paid on it, of which 300 are payments → 200 manual.
    await Invoice.updateOne({ _id: inv._id }, { $inc: { paidAmount: 200, balanceAmount: -200 } });
    expect((await details(inv)).paymentSummary).toEqual({ recordedAmount: 300, manualPaidAmount: 200 });

    const url = `/api/invoices/${inv._id}/payment-status`;
    expect((await admin.patch(url, { manualPaidAmount: 100 })).body.code).toBe('REASON_REQUIRED');
    expect((await admin.patch(url, { paymentStatus: 'paid', amountPaid: 1000 })).body.code).toBe('USE_PAYMENTS');
    const tooMuch = await admin.patch(url, { manualPaidAmount: 701, reason: 'Cash before Carbon' });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.code).toBe('AMOUNT_EXCEEDS_TOTAL');

    const fixed = await admin.patch(url, { manualPaidAmount: 700, reason: 'Cash received in October, before Carbon' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.paymentSummary).toEqual({ recordedAmount: 300, manualPaidAmount: 700 });
    expect(await state(inv)).toMatchObject({ paidAmount: 1000, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });

    // Payments still move it as before, around the manual part.
    const p = (await Payment.findOne({ 'allocations.invoiceId': inv._id }))._id;
    await admin.put(`/api/payments/${p}`, { status: 'refunded' });
    expect(await state(inv)).toMatchObject({ paidAmount: 700, paymentStatus: 'partial', status: 'sent' });

    const logged = await ActivityLog.findOne({ action: 'Invoice Balance Corrected', entityId: inv._id }).lean();
    expect(logged).toMatchObject({ severity: 'high' });
    expect(logged.changes.before).toMatchObject({ manualPaidAmount: 200, paidAmount: 500 });
    expect(logged.changes.after).toMatchObject({ manualPaidAmount: 700, paidAmount: 1000, reason: 'Cash received in October, before Carbon' });
    expect(logged.metadata.reason).toBe('Cash received in October, before Carbon');
    await expectConsistent();
  });
});

describe('permissions', () => {
  test('recording, allocating, deleting and correcting each need their permission', async () => {
    const inv = await invoiceFor(500);
    const staff = as(org.tokens.staff1);
    const body = { customerId: String(cust._id), invoiceId: String(inv._id), amount: 100, paymentMethod: 'cash' };

    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Payments', 'Payments: View'] });
    expect((await staff.post('/api/payments', body)).status).toBe(403);

    // An invoice login may record a payment applied in full to an invoice it
    // can see, but not money on account, and cannot allocate or delete.
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Invoicing', 'Invoicing: View', 'Invoicing: Record Payment'] });
    const own = await make.invoice(org.staff1, cust, { lines: [{ amount: 500, rate: 0 }] });
    const recorded = await staff.post('/api/payments', { ...body, invoiceId: String(own._id) });
    expect(recorded.status).toBe(201);
    expect((await staff.post('/api/payments', { ...body, invoiceId: undefined })).status).toBe(403);
    expect((await staff.put(`/api/payments/${recorded.body.data.payment._id}/allocations`, { allocations: [] })).status).toBe(403);
    expect((await staff.delete(`/api/payments/${recorded.body.data.payment._id}`)).status).toBe(403);
    expect((await staff.patch(`/api/invoices/${own._id}/payment-status`, { manualPaidAmount: 0, reason: 'test reason' })).status).toBe(403);

    // Correct Balance is its own grant.
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Invoicing', 'Invoicing: View', 'Invoicing: Correct Balance'] });
    expect((await staff.patch(`/api/invoices/${own._id}/payment-status`, { manualPaidAmount: 0, reason: 'test reason' })).status).toBe(200);
  });

  test('another business cannot see or change these payments', async () => {
    const mine = (await pay({ amount: 50 })).body.data.payment._id;
    const them = as(other.tokens.admin);
    expect((await them.get(`/api/payments/${mine}`)).status).toBe(404);
    expect((await them.put(`/api/payments/${mine}/allocations`, { allocations: [] })).status).toBe(404);
    expect((await them.delete(`/api/payments/${mine}`)).status).toBe(404);
  });
});

describe('summaries agree', () => {
  test('invoice collected/outstanding, payment totals, dashboard and customer stats match the payments', async () => {
    const { receivedTotal, onAccountTotal } = await expectConsistent();
    const views = (await admin.get('/api/invoices/stats/views')).body.data.stats;
    const invoices = await Invoice.find({ dataScope: org.dataScope, status: { $nin: ['draft', 'cancelled'] } });
    const collected = invoices.reduce((s, i) => s + i.paidAmount, 0);
    const outstanding = invoices.filter((i) => i.paymentStatus !== 'paid').reduce((s, i) => s + i.balanceAmount, 0);
    expect(views.collected).toBeCloseTo(collected, 2);
    expect(views.outstanding).toBeCloseTo(outstanding, 2);

    const manual = invoices.reduce((s, i) => s + (i.manualPaidAmount || 0), 0);
    // Received = applied to issued invoices + recorded on account (+ any applied to cancelled ones, none here).
    expect(receivedTotal).toBeCloseTo(collected - manual + onAccountTotal, 2);

    const dash = (await admin.get('/api/dashboard/stats')).body.stats;
    expect(dash.receivables).toBeCloseTo(invoices.filter((i) => i.balanceAmount > 0).reduce((s, i) => s + i.balanceAmount, 0), 2);

    const customerOnAccount = (await Payment.find({ customerId: cust._id, status: 'completed' }))
      .reduce((s, p) => s + (p.amount - (p.allocations?.length ? p.allocations.reduce((t, a) => t + a.amount, 0) : p.invoiceId ? p.amount : 0)), 0);
    const owed = invoices.filter((i) => String(i.customerId) === String(cust._id)).reduce((s, i) => s + i.balanceAmount, 0);
    expect((await admin.post(`/api/customers/${cust._id}/update-stats`, {})).status).toBe(200);
    const Customer = require('../src/models/Customer');
    const refreshed = await Customer.findById(cust._id);
    expect(refreshed.outstandingBalance).toBeCloseTo(owed - customerOnAccount, 2);
    expect(refreshed.totalSpent).toBeCloseTo((await Payment.find({ customerId: cust._id, status: 'completed' })).reduce((s, p) => s + p.amount, 0), 2);
  });
});
