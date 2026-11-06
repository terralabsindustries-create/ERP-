/**
 * Monthly report built from real invoices (GST figures come from invoices
 * issued before GST was removed), the accountant email, and payments recorded
 * against invoices.
 */
const request = require('supertest');
const app = require('../src/app');
const mailer = require('../src/utils/mailer');
const Invoice = require('../src/models/Invoice');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
const month = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

beforeAll(async () => {
  await connectTestDb('reports');
  org = await createOrg('r');
  other = await createOrg('x');
  cust = await make.customer(org.admin, { name: 'Lotus Publications' });
  // Counted: two GST invoices, one interstate.
  await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 18 }, { amount: 500, rate: 5 }] });
  await make.invoice(org.manager, cust, { lines: [{ amount: 2000, rate: 18 }], interState: true, discountAmount: 0 });
  // Not counted: draft, cancelled, No GST, last month, another business.
  await make.invoice(org.admin, cust, { status: 'draft', lines: [{ amount: 9999, rate: 18 }] });
  await make.invoice(org.admin, cust, { status: 'cancelled', lines: [{ amount: 9999, rate: 18 }] });
  await make.invoice(org.admin, cust, { noGst: true, lines: [{ amount: 300, rate: 0 }] });
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  await make.invoice(org.admin, cust, { invoiceDate: lastMonth, lines: [{ amount: 9999, rate: 18 }] });
  const otherCust = await make.customer(other.admin);
  await make.invoice(other.admin, otherCust, { lines: [{ amount: 9999, rate: 18 }] });
});
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

describe('monthly GST report', () => {
  test('totals come from the issued GST invoices of the month', async () => {
    const res = await request(app).get(`/api/reports/revenue?month=${month}`).set(auth(org.tokens.admin));
    expect(res.status).toBe(200);
    const r = res.body.data;
    // 1000@18% + 500@5% + 2000@18% IGST
    expect(r.totalInvoices).toBe(2);
    expect(r.taxableAmount).toBe(3500);
    expect(r.totalTaxPayable).toBe(180 + 25 + 360);
    expect(r.cgstAmount).toBe(102.5);
    expect(r.sgstAmount).toBe(102.5);
    expect(r.igstAmount).toBe(360);
    expect(r.totalRevenue).toBe(3500 + 565);
    expect(r.gstBreakdown.gst18).toEqual({ count: 2, amount: 3000, tax: 540 });
    expect(r.gstBreakdown.gst5).toEqual({ count: 1, amount: 500, tax: 25 });
    expect(r.gstBreakdown.gst12).toEqual({ count: 0, amount: 0, tax: 0 });
    expect(r.excludedNoGst).toEqual({ count: 1, amount: 300 });
  });

  test('a login without "view all staff data" reports only the invoices it created', async () => {
    await User.updateOne({ _id: org.manager._id }, { canViewAllData: false });
    const res = await request(app).get(`/api/reports/revenue?month=${month}`).set(auth(org.tokens.manager));
    expect(res.body.data.totalInvoices).toBe(1);
    expect(res.body.data.igstAmount).toBe(360);
    await User.updateOne({ _id: org.manager._id }, { canViewAllData: true });
  });

  test('rejects a malformed month', async () => {
    expect((await request(app).get('/api/reports/revenue?month=2026-13').set(auth(org.tokens.admin))).status).toBe(400);
  });
});

describe('Email to Accountant', () => {
  test('sends the server-built report with a CSV attached', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'test-message' });
    jest.spyOn(mailer, 'createTransporter').mockReturnValue({ sendMail });

    const res = await request(app)
      .post('/api/reports/revenue/email')
      .set(auth(org.tokens.admin))
      .send({ month, email: 'accounts@example.test', notes: 'Two interstate jobs this month', totalRevenue: 1 });
    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('accounts@example.test');
    expect(mail.text).toMatch(/GST: ₹565\.00/);
    expect(mail.attachments[0].filename).toBe(`monthly-report-${month}.csv`);
    expect(mail.attachments[0].content).toMatch(/18%,2,3000,540/);
    expect(mail.attachments[0].content).toMatch(/Two interstate jobs this month/);
  });

  test('says so when email is not configured', async () => {
    const res = await request(app).post('/api/reports/revenue/email').set(auth(org.tokens.admin)).send({ month, email: 'accounts@example.test' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_NOT_CONFIGURED');
  });

  test('needs Reports: Export', async () => {
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Reports', 'Reports: View'] });
    expect((await request(app).get(`/api/reports/revenue?month=${month}`).set(auth(org.tokens.staff1))).status).toBe(200);
    expect((await request(app).post('/api/reports/revenue/email').set(auth(org.tokens.staff1)).send({ month, email: 'a@example.test' })).status).toBe(403);
  });
});

describe('payments', () => {
  let inv;
  let paymentId;

  beforeAll(async () => {
    inv = await make.invoice(org.admin, cust, { invoiceNumber: 'INV-PAY-1', lines: [{ amount: 1000, rate: 18 }] });
  });

  test('recording a payment against an invoice updates its paid amount, balance and status', async () => {
    const res = await request(app).post('/api/payments').set(auth(org.tokens.admin)).send({
      customerId: String(cust._id),
      invoiceId: String(inv._id),
      amount: 500,
      paymentMethod: 'upi',
      referenceNumber: 'UPI-778899'
    });
    expect(res.status).toBe(201);
    paymentId = res.body.data.payment._id;
    expect(res.body.data.payment).toMatchObject({ invoiceNumber: 'INV-PAY-1', customerName: 'Lotus Publications', status: 'completed' });
    const after = await Invoice.findById(inv._id);
    expect(after.paidAmount).toBe(500);
    expect(after.balanceAmount).toBe(680);
    expect(after.paymentStatus).toBe('partial');
  });

  test('refuses more than the invoice balance', async () => {
    const res = await request(app).post('/api/payments').set(auth(org.tokens.admin)).send({ customerId: String(cust._id), invoiceId: String(inv._id), amount: 681, paymentMethod: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });

  test('refuses an invoice that belongs to another customer', async () => {
    const someoneElse = await make.customer(org.admin);
    const res = await request(app).post('/api/payments').set(auth(org.tokens.admin)).send({ customerId: String(someoneElse._id), invoiceId: String(inv._id), amount: 10, paymentMethod: 'cash' });
    expect(res.status).toBe(400);
  });

  test('the list supports search, status filter and totals over the same filters', async () => {
    await make.payment(org.admin, cust, { status: 'pending', amount: 200, dataScope: org.dataScope, paymentMethod: 'cheque' });
    const all = await request(app).get('/api/payments').set(auth(org.tokens.admin));
    expect(all.status).toBe(200);
    expect(all.body.data.summary.completed).toEqual({ count: 1, amount: 500 });
    expect(all.body.data.summary.pending).toEqual({ count: 1, amount: 200 });

    const pending = await request(app).get('/api/payments?status=pending').set(auth(org.tokens.admin));
    expect(pending.body.data.payments).toHaveLength(1);
    // Totals ignore the status filter so every card stays filled in.
    expect(pending.body.data.summary.completed.amount).toBe(500);

    const search = await request(app).get('/api/payments?search=UPI-778').set(auth(org.tokens.admin));
    expect(search.body.data.payments.map((p) => p._id)).toEqual([paymentId]);
  });

  test('staff see only the payments they recorded', async () => {
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Payments', 'Payments: View', 'Payments: Record Payment'] });
    const res = await request(app).get('/api/payments').set(auth(org.tokens.staff1));
    expect(res.status).toBe(200);
    expect(res.body.data.payments).toHaveLength(0);
  });

  test('cancelling and deleting a payment take it back off the invoice', async () => {
    await request(app).put(`/api/payments/${paymentId}`).set(auth(org.tokens.admin)).send({ status: 'cancelled' });
    expect((await Invoice.findById(inv._id)).paidAmount).toBe(0);
    await request(app).put(`/api/payments/${paymentId}`).set(auth(org.tokens.admin)).send({ status: 'completed' });
    expect((await Invoice.findById(inv._id)).paidAmount).toBe(500);
    expect((await request(app).delete(`/api/payments/${paymentId}`).set(auth(org.tokens.admin))).status).toBe(200);
    const after = await Invoice.findById(inv._id);
    expect(after.paidAmount).toBe(0);
    expect(after.paymentStatus).toBe('pending');
  });

  test('stats summary responds (it used to be shadowed by /:id and crash on ObjectId)', async () => {
    const res = await request(app).get('/api/payments/stats/summary').set(auth(org.tokens.admin));
    expect(res.status).toBe(200);
    expect(typeof res.body.data.stats.totalAmount).toBe('number');
  });

  test('partial, full, on-account allocation and reversal stay in sync with invoice details', async () => {
    const invoice = await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 0 }] });
    const post = (amount, invoiceId) => request(app).post('/api/payments').set(auth(org.tokens.admin)).send({
      customerId: String(cust._id), amount, paymentMethod: 'upi', referenceNumber: `REF-${amount}`, ...(invoiceId ? { invoiceId } : {})
    });
    const details = () => request(app).get(`/api/invoices/${invoice._id}`).set(auth(org.tokens.admin));

    let view = await details();
    expect(view.body.data.invoice).toMatchObject({ paidAmount: 0, balanceAmount: 1000, paymentStatus: 'pending' });
    expect(view.body.data.paymentHistory).toHaveLength(0);

    const first = await post(300, String(invoice._id));
    expect(first.status).toBe(201);
    view = await details();
    expect(view.body.data.invoice).toMatchObject({ paidAmount: 300, balanceAmount: 700, paymentStatus: 'partial' });
    expect(view.body.data.paymentHistory[0]).toMatchObject({ amount: 300, paymentMethod: 'upi', referenceNumber: 'REF-300' });
    expect((await request(app).put(`/api/payments/${first.body.data.payment._id}`).set(auth(org.tokens.admin)).send({ amount: 1100 })).status).toBe(400);
    expect((await details()).body.data.invoice.paidAmount).toBe(300);

    const advance = await post(200);
    expect(advance.status).toBe(201);
    expect(advance.body.data.payment.invoiceId).toBeFalsy();
    expect((await details()).body.data.invoice.balanceAmount).toBe(700);
    expect((await request(app).put(`/api/payments/${advance.body.data.payment._id}`).set(auth(org.tokens.admin)).send({ invoiceId: String(invoice._id) })).status).toBe(200);
    view = await details();
    expect(view.body.data.invoice).toMatchObject({ paidAmount: 500, balanceAmount: 500, paymentStatus: 'partial' });
    expect(view.body.data.paymentHistory).toHaveLength(2);
    expect((await request(app).put(`/api/payments/${advance.body.data.payment._id}`).set(auth(org.tokens.admin)).send({ invoiceId: String(invoice._id) })).status).toBe(200);
    expect((await details()).body.data.invoice.paidAmount).toBe(500);
    const otherInvoice = await make.invoice(org.admin, cust, { lines: [{ amount: 500, rate: 0 }] });
    expect((await request(app).put(`/api/payments/${advance.body.data.payment._id}`).set(auth(org.tokens.admin)).send({ invoiceId: String(otherInvoice._id) })).status).toBe(400);
    expect((await Invoice.findById(otherInvoice._id)).paidAmount).toBe(0);

    expect((await post(501, String(invoice._id))).status).toBe(400);
    const final = await post(500, String(invoice._id));
    expect(final.status).toBe(201);
    view = await details();
    expect(view.body.data.invoice).toMatchObject({ paidAmount: 1000, balanceAmount: 0, paymentStatus: 'paid' });
    expect(view.body.data.paymentHistory).toHaveLength(3);

    expect((await request(app).put(`/api/payments/${final.body.data.payment._id}`).set(auth(org.tokens.admin)).send({ status: 'refunded' })).status).toBe(200);
    view = await details();
    expect(view.body.data.invoice).toMatchObject({ paidAmount: 500, balanceAmount: 500, paymentStatus: 'partial' });
    expect(view.body.data.paymentHistory.find((p) => p._id === final.body.data.payment._id).status).toBe('refunded');

    expect((await request(app).delete(`/api/payments/${first.body.data.payment._id}`).set(auth(org.tokens.admin))).status).toBe(200);
    expect((await details()).body.data.invoice).toMatchObject({ paidAmount: 200, balanceAmount: 800, paymentStatus: 'partial' });
    // Setting the paid total directly is gone: receipts are payments, and a
    // balance correction only changes the amount recorded outside them.
    const legacy = await request(app).patch(`/api/invoices/${invoice._id}/payment-status`).set(auth(org.tokens.admin)).send({ paymentStatus: 'paid', amountPaid: 1000 });
    expect(legacy.status).toBe(400);
    expect(legacy.body.code).toBe('USE_PAYMENTS');
    const corrected = await request(app).patch(`/api/invoices/${invoice._id}/payment-status`).set(auth(org.tokens.admin)).send({ manualPaidAmount: 0, reason: 'No cash taken outside Carbon' });
    expect(corrected.status).toBe(200);
    expect((await details()).body.data.invoice).toMatchObject({ paidAmount: 200, balanceAmount: 800, paymentStatus: 'partial' });
  });
});
