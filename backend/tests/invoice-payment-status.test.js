/**
 * An invoice's payment status follows the money recorded against it — never
 * "Paid" on creation, and never "Paid" while a balance is still due.
 *
 * Covers the lifecycle (unpaid → partial → paid, reversals, overdue, cash
 * sales), the invoice list's views and counts, the customer's outstanding
 * balance, and invoices left "paid with nothing received" by the old
 * payment-status dialog — with the reconciliation script that finds them.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Payment = require('../src/models/Payment');
const Customer = require('../src/models/Customer');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const { analyse, applyRepairs } = require('../scripts/reconcileInvoicePayments');

let org;
let cust;
let admin;
let keyCount = 0;
const newKey = () => `ips-key-${Date.now()}-${++keyCount}`;

const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(token)).send(body),
  delete: (url) => request(app).delete(url).set(auth(token))
});

const pay = (invoice, amount, extra = {}) =>
  admin.post('/api/payments', { customerId: String(cust._id), invoiceId: String(invoice._id), amount, paymentMethod: 'upi', idempotencyKey: newKey(), ...extra });

const state = async (invoice) => {
  const i = await Invoice.findById(invoice._id);
  return { paidAmount: i.paidAmount, balanceAmount: i.balanceAmount, paymentStatus: i.paymentStatus, status: i.status };
};

const inView = async (view, invoice) => {
  const res = await admin.get(`/api/invoices?view=${view}&limit=100&customerId=${cust._id}`);
  expect(res.status).toBe(200);
  return res.body.data.invoices.some((i) => String(i._id) === String(invoice._id));
};

/** An invoice as the old "Payment status" dialog left it: marked paid, nothing received. */
const legacyMarkedPaid = async (amount = 500, extra = {}) => {
  const inv = await make.invoice(org.admin, cust, { lines: [{ amount, rate: 0 }], ...extra });
  await Invoice.collection.updateOne({ _id: inv._id }, { $set: { paymentStatus: 'paid', status: 'paid', paidAmount: 0, balanceAmount: amount } });
  return inv;
};

beforeAll(async () => {
  await connectTestDb('invoice_payment_status');
  await Payment.init();
  org = await createOrg('ips');
  admin = as(org.tokens.admin);
  cust = await make.customer(org.admin, { name: 'Meera Offset' });
});
afterAll(disconnectTestDb);

describe('a new invoice', () => {
  test('is unpaid when created through the API, with the whole total outstanding', async () => {
    const res = await admin.post('/api/invoices', {
      customerId: String(cust._id),
      status: 'sent',
      items: [{ itemName: 'Visiting cards', quantity: 2, unitPrice: 250, gstRate: 18 }]
    });
    expect(res.status).toBe(201);
    const inv = res.body.data.invoice;
    expect(inv.totalAmount).toBe(590);
    expect(inv.paidAmount).toBe(0);
    expect(inv.balanceAmount).toBe(590);
    expect(inv.paymentStatus).toBe('pending');
    expect(inv.status).toBe('sent');
    expect(await Payment.countDocuments({ 'allocations.invoiceId': inv._id })).toBe(0);
    expect(await inView('unpaid', inv)).toBe(true);
    expect(await inView('paid', inv)).toBe(false);
  });

  test('cannot be created as paid, and payment fields in the request are ignored', async () => {
    const asPaid = await admin.post('/api/invoices', {
      customerId: String(cust._id), status: 'paid', items: [{ itemName: 'Flyers', quantity: 1, unitPrice: 100 }]
    });
    expect(asPaid.status).toBe(400);

    const smuggled = await admin.post('/api/invoices', {
      customerId: String(cust._id), status: 'sent', paymentStatus: 'paid', paidAmount: 100, manualPaidAmount: 100,
      items: [{ itemName: 'Flyers', quantity: 1, unitPrice: 100 }]
    });
    expect(smuggled.status).toBe(201);
    expect(smuggled.body.data.invoice).toMatchObject({ paymentStatus: 'pending', paidAmount: 0, balanceAmount: 100, status: 'sent' });
  });

  test('a draft stays a draft and is neither unpaid nor paid', async () => {
    const res = await admin.post('/api/invoices', { customerId: String(cust._id), status: 'draft', items: [{ itemName: 'Banner', quantity: 1, unitPrice: 300 }] });
    expect(res.body.data.invoice).toMatchObject({ status: 'draft', paymentStatus: 'pending', balanceAmount: 300 });
    expect(await inView('draft', res.body.data.invoice)).toBe(true);
    expect(await inView('unpaid', res.body.data.invoice)).toBe(false);
    expect(await inView('paid', res.body.data.invoice)).toBe(false);
  });

  test('a ₹0 invoice is never paid by itself', () => {
    expect(Invoice.paymentStateFor({ totalAmount: 0, status: 'sent', paymentStatus: 'pending' }, 0)).toMatchObject({ paymentStatus: 'pending', status: 'sent' });
  });
});

describe('recording payments', () => {
  test('partial, then several payments up to the total, then paid', async () => {
    const inv = await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 0 }] });
    expect((await pay(inv, 300)).status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 300, balanceAmount: 700, paymentStatus: 'partial', status: 'sent' });
    expect(await inView('unpaid', inv)).toBe(true);

    expect((await pay(inv, 200, { paymentMethod: 'cash' })).status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 500, balanceAmount: 500, paymentStatus: 'partial', status: 'sent' });

    expect((await pay(inv, 500)).status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 1000, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
    expect(await inView('paid', inv)).toBe(true);
    expect(await inView('unpaid', inv)).toBe(false);

    // Nothing more can be taken against a settled invoice.
    expect((await pay(inv, 1)).body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });

  test('one full payment settles it at once (cash sale)', async () => {
    const res = await admin.post('/api/invoices', { customerId: String(cust._id), status: 'sent', items: [{ itemName: 'Photocopies', quantity: 40, unitPrice: 2 }] });
    const inv = res.body.data.invoice;
    expect((await pay(inv, 80, { paymentMethod: 'cash' })).status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 80, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
  });

  test('a repeated submission records one payment, not two', async () => {
    const inv = await make.invoice(org.admin, cust, { lines: [{ amount: 400, rate: 0 }] });
    const body = { customerId: String(cust._id), invoiceId: String(inv._id), amount: 100, paymentMethod: 'upi', idempotencyKey: newKey() };
    expect((await admin.post('/api/payments', body)).status).toBe(201);
    const again = await admin.post('/api/payments', body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await state(inv)).toMatchObject({ paidAmount: 100, paymentStatus: 'partial' });
  });

  test('a pending (uncleared) payment does not count as received', async () => {
    const inv = await make.invoice(org.admin, cust, { lines: [{ amount: 250, rate: 0 }] });
    expect((await pay(inv, 250, { paymentMethod: 'cheque', status: 'pending' })).status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 0, balanceAmount: 250, paymentStatus: 'pending', status: 'sent' });
  });
});

describe('reversals', () => {
  test('refunding, bouncing or deleting a payment puts the balance back', async () => {
    const inv = await make.invoice(org.admin, cust, { lines: [{ amount: 600, rate: 0 }] });
    const first = (await pay(inv, 400)).body.data.payment;
    const second = (await pay(inv, 200)).body.data.payment;
    expect(await state(inv)).toMatchObject({ paymentStatus: 'paid', status: 'paid' });

    expect((await admin.put(`/api/payments/${second._id}`, { status: 'refunded' })).status).toBe(200);
    expect(await state(inv)).toEqual({ paidAmount: 400, balanceAmount: 200, paymentStatus: 'partial', status: 'sent' });

    expect((await admin.put(`/api/payments/${first._id}`, { status: 'failed' })).status).toBe(200);
    expect(await state(inv)).toEqual({ paidAmount: 0, balanceAmount: 600, paymentStatus: 'pending', status: 'sent' });

    expect((await admin.put(`/api/payments/${first._id}`, { status: 'completed' })).status).toBe(200);
    expect(await state(inv)).toMatchObject({ paidAmount: 400, paymentStatus: 'partial' });
    expect((await admin.delete(`/api/payments/${first._id}`)).status).toBe(200);
    expect(await state(inv)).toEqual({ paidAmount: 0, balanceAmount: 600, paymentStatus: 'pending', status: 'sent' });
  });

  test('a debit note on a settled invoice makes it part paid again; a credit note down to what was paid settles it', async () => {
    const res = await admin.post('/api/invoices', { customerId: String(cust._id), status: 'sent', items: [{ itemName: 'Stickers', quantity: 1, unitPrice: 500 }] });
    const inv = res.body.data.invoice;
    await pay(inv, 500);
    expect(await state(inv)).toMatchObject({ paymentStatus: 'paid', status: 'paid' });

    // An issued invoice's amounts are corrected with notes, not by editing it.
    expect((await admin.put(`/api/invoices/${inv._id}`, { items: [{ itemName: 'Stickers', quantity: 2, unitPrice: 500 }] })).status).toBe(409);
    const ref = String(inv.items[0]._id);
    const debit = await admin.post('/api/credit-notes', { noteType: 'debit', invoiceId: inv._id, reason: 'price_revision', items: [{ invoiceLineRef: ref, quantity: 1, taxableValue: 500 }] });
    expect((await admin.patch(`/api/credit-notes/${debit.body.data.note._id}/issue`, {})).status).toBe(200);
    expect(await state(inv)).toEqual({ paidAmount: 500, balanceAmount: 500, paymentStatus: 'partial', status: 'sent' });

    const credit = await admin.post('/api/credit-notes', { noteType: 'credit', invoiceId: inv._id, reason: 'price_revision', items: [{ invoiceLineRef: ref, taxableValue: 500 }] });
    expect((await admin.patch(`/api/credit-notes/${credit.body.data.note._id}/issue`, {})).status).toBe(200);
    expect(await state(inv)).toEqual({ paidAmount: 500, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
  });
});

describe('overdue', () => {
  test('an unpaid or part-paid invoice past its due date is overdue; a paid one is not', async () => {
    const past = new Date(Date.now() - 10 * 864e5);
    const unpaid = await make.invoice(org.admin, cust, { lines: [{ amount: 100, rate: 0 }], dueDate: past });
    const part = await make.invoice(org.admin, cust, { lines: [{ amount: 100, rate: 0 }], dueDate: past });
    const paid = await make.invoice(org.admin, cust, { lines: [{ amount: 100, rate: 0 }], dueDate: past });
    await pay(part, 40);
    await pay(paid, 100);
    expect(await inView('overdue', unpaid)).toBe(true);
    expect(await inView('overdue', part)).toBe(true);
    expect(await inView('overdue', paid)).toBe(false);
  });

  test('"overdue" set by payment reminders survives a save, and gives way to a payment', async () => {
    const inv = await make.invoice(org.admin, cust, { lines: [{ amount: 100, rate: 0 }], dueDate: new Date(Date.now() - 864e5) });
    const doc = await Invoice.findById(inv._id);
    doc.paymentStatus = 'overdue';
    await doc.save();
    expect((await state(inv)).paymentStatus).toBe('overdue');
    await pay(inv, 30);
    expect((await state(inv)).paymentStatus).toBe('partial');
  });
});

describe('invoices marked paid by the old payment-status dialog with nothing received', () => {
  test('count as unpaid and outstanding in the invoice list and its totals', async () => {
    const before = (await admin.get('/api/invoices/stats/views')).body.data.stats;
    const inv = await legacyMarkedPaid(700);
    expect(await inView('paid', inv)).toBe(false);
    expect(await inView('unpaid', inv)).toBe(true);
    const after = (await admin.get('/api/invoices/stats/views')).body.data.stats;
    expect(after.unpaid - before.unpaid).toBe(1);
    expect(after.paid - before.paid).toBe(0);
    expect(after.outstanding - before.outstanding).toBeCloseTo(700, 2);
  });

  test('are put right the next time they are saved', async () => {
    const inv = await legacyMarkedPaid(320);
    expect((await admin.put(`/api/invoices/${inv._id}`, { notes: 'Called the customer' })).status).toBe(200);
    expect(await state(inv)).toEqual({ paidAmount: 0, balanceAmount: 320, paymentStatus: 'pending', status: 'sent' });
  });

  test('can then be paid in the normal way', async () => {
    const inv = await legacyMarkedPaid(150);
    expect((await pay(inv, 150)).status).toBe(201);
    expect(await state(inv)).toEqual({ paidAmount: 150, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
  });
});

describe('customer ledger', () => {
  test('the customer\'s outstanding balance is what their issued invoices still owe', async () => {
    const buyer = await make.customer(org.admin, { name: 'Sunrise Traders' });
    const a = await make.invoice(org.admin, buyer, { lines: [{ amount: 1000, rate: 0 }] });
    await make.invoice(org.admin, buyer, { lines: [{ amount: 500, rate: 0 }] });
    await make.invoice(org.admin, buyer, { lines: [{ amount: 900, rate: 0 }], status: 'draft' });
    const outstanding = async () => {
      const c = await Customer.findById(buyer._id);
      await c.updateStats();
      return (await Customer.findById(buyer._id)).outstandingBalance;
    };
    expect(await outstanding()).toBe(1500);
    await admin.post('/api/payments', { customerId: String(buyer._id), invoiceId: String(a._id), amount: 400, paymentMethod: 'cash', idempotencyKey: newKey() });
    expect(await outstanding()).toBe(1100);
    // An advance on account lowers what they owe overall.
    await admin.post('/api/payments', { customerId: String(buyer._id), amount: 100, paymentMethod: 'cash', idempotencyKey: newKey() });
    expect(await outstanding()).toBe(1000);

    const list = await admin.get(`/api/invoices?customerId=${buyer._id}&view=unpaid`);
    const owed = list.body.data.invoices.reduce((s, i) => s + i.balanceAmount, 0);
    expect(owed).toBe(1100);
  });
});

describe('reconciliation script', () => {
  test('finds invoices marked paid without the money, and repairs only their status', async () => {
    const scoped = await createOrg('ipsr');
    const buyer = await make.customer(scoped.admin, { name: 'Kaveri Prints' });
    const falsePaid = await make.invoice(scoped.admin, buyer, { lines: [{ amount: 800, rate: 0 }] });
    await Invoice.collection.updateOne({ _id: falsePaid._id }, { $set: { paymentStatus: 'paid', status: 'paid', paidAmount: 0, balanceAmount: 800 } });
    const manualOnly = await make.invoice(scoped.admin, buyer, { lines: [{ amount: 200, rate: 0 }] });
    await Invoice.collection.updateOne({ _id: manualOnly._id }, { $set: { paymentStatus: 'paid', status: 'paid', paidAmount: 200, balanceAmount: 0 } });
    const fine = await make.invoice(scoped.admin, buyer, { lines: [{ amount: 300, rate: 0 }] });

    const invoices = await Invoice.collection.find({ dataScope: scoped.dataScope }).toArray();
    const payments = await Payment.collection.find({ dataScope: scoped.dataScope }).toArray();
    const { rows, repairs, summary } = analyse(invoices, payments, (i, p) => Invoice.paymentStateFor(i, p));

    const row = (inv) => rows.find((r) => r.invoiceNumber === inv.invoiceNumber);
    expect(row(falsePaid)).toMatchObject({
      customer: 'Kaveri Prints', invoiceTotal: 800, receivedViaPayments: 0, outstandingBalance: 800,
      currentStatus: 'Paid', expectedStatus: 'Unpaid', statusAfterRepair: 'Unpaid'
    });
    expect(row(falsePaid).issues).toContain('MARKED_PAID_WITH_BALANCE_DUE');
    // Paid only by an entry on the invoice: flagged for review, not changed.
    expect(row(manualOnly)).toMatchObject({ currentStatus: 'Paid', expectedStatus: 'Unpaid', statusAfterRepair: 'Paid', recordedOutsidePayments: 200 });
    expect(row(manualOnly).issues).toContain('PAID_BY_MANUAL_ENTRY_ONLY');
    expect(row(fine)).toBeUndefined();
    expect(summary.hiddenReceivables).toBe(800);
    expect(repairs.map((r) => r.invoiceNumber)).toEqual([falsePaid.invoiceNumber]);

    const { applied } = await applyRepairs(Invoice.collection, repairs);
    expect(applied).toBe(1);
    expect(await state(falsePaid)).toEqual({ paidAmount: 0, balanceAmount: 800, paymentStatus: 'pending', status: 'sent' });
    expect(await state(manualOnly)).toMatchObject({ paidAmount: 200, paymentStatus: 'paid' });
    // Run again: nothing left to repair.
    const again = analyse(await Invoice.collection.find({ dataScope: scoped.dataScope }).toArray(), payments, (i, p) => Invoice.paymentStateFor(i, p));
    expect(again.repairs).toEqual([]);
  });

  test('a repair does not overwrite an invoice that changed after it was read', async () => {
    const inv = await legacyMarkedPaid(90);
    const invoices = await Invoice.collection.find({ _id: inv._id }).toArray();
    const { repairs } = analyse(invoices, [], (i, p) => Invoice.paymentStateFor(i, p));
    await pay(inv, 90); // lands between the read and the repair
    const { applied, skipped } = await applyRepairs(Invoice.collection, repairs);
    expect(applied).toBe(0);
    expect(skipped).toEqual([inv.invoiceNumber]);
    expect(await state(inv)).toEqual({ paidAmount: 90, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
  });
});
