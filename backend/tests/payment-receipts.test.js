/** Payment receipts: the document content for partial, full, split, on-account and cancelled payments, and the PDF route. */
const request = require('supertest');
const app = require('../src/app');
const Settings = require('../src/models/Settings');
const Invoice = require('../src/models/Invoice');
const Customer = require('../src/models/Customer');
const User = require('../src/models/User');
const PDFService = require('../src/services/PDFService');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
let n = 0;
const api = (m, url, body, o = org) => request(app)[m](url).set(auth(o.tokens.admin)).send(body);
const invoiceFor = (amount) => make.invoice(org.admin, cust, { lines: [{ amount, rate: 0 }] });
const pay = async (body) => (await api('post', '/api/payments', { customerId: String(cust._id), paymentMethod: 'upi', referenceNumber: 'UTR123', idempotencyKey: `rc-${Date.now()}-${(n += 1)}`, ...body })).body.data.payment;
const company = { name: 'Receipt Printers', currency: 'INR' };
const rows = (d) => Object.fromEntries(d.summary.map((r) => [r.label, r.value]));

async function documentFor(paymentId) {
  const { Types } = require('mongoose');
  const Payment = require('../src/models/Payment');
  const ledger = require('../src/services/paymentLedger');
  const payment = await Payment.findById(paymentId).lean();
  const allocations = ledger.allocationsOf(payment);
  const found = await Invoice.find({ _id: { $in: allocations.map((a) => a.invoiceId) } }).lean();
  const invoices = Object.fromEntries(found.map((i) => [String(i._id), i]));
  const customer = await Customer.findById(payment.customerId).lean();
  return PDFService.paymentReceiptDocument(payment, invoices, customer, company, allocations);
}

beforeAll(async () => {
  await connectTestDb('receipts');
  org = await createOrg('rcp');
  other = await createOrg('rcpx');
  const settings = await Settings.getOrCreateSettings(org.admin._id);
  settings.companyName = 'Receipt Printers';
  await settings.save();
  cust = await make.customer(org.admin, { name: 'Receipt Customer' });
});
afterAll(disconnectTestDb);

test('a partial payment shows what was received and what is still due', async () => {
  const inv = await invoiceFor(1000);
  const p = await pay({ invoiceId: String(inv._id), amount: 400 });
  const d = await documentFor(p._id);
  expect(d).toMatchObject({ type: 'PAYMENT RECEIPT', number: p.paymentId, badge: null });
  expect(d.customer.name).toBe('Receipt Customer');
  expect(d.meta.map((m) => m.label)).toEqual(expect.arrayContaining(['Receipt Date', 'Payment Method', 'Reference']));
  expect(rows(d)).toMatchObject({ 'Amount Received': 'INR 400.00', 'Applied to Invoices': 'INR 400.00', 'Balance Still Due on These Invoices': 'INR 600.00' });
  expect(d.items).toHaveLength(1);
});

test('a second payment on the same invoice, and a full settlement', async () => {
  const inv = await invoiceFor(500);
  await pay({ invoiceId: String(inv._id), amount: 200 });
  const second = await pay({ invoiceId: String(inv._id), amount: 300 });
  const d = await documentFor(second._id);
  expect(rows(d)['Balance Still Due on These Invoices']).toBe('INR 0.00');
});

test('one payment across two invoices lists both; an advance says held on account', async () => {
  const a = await invoiceFor(300);
  const b = await invoiceFor(300);
  const split = await pay({ amount: 500, allocations: [{ invoiceId: String(a._id), amount: 300 }, { invoiceId: String(b._id), amount: 150 }] });
  const d = await documentFor(split._id);
  expect(d.items).toHaveLength(2);
  expect(rows(d)).toMatchObject({ 'Amount Received': 'INR 500.00', 'Applied to Invoices': 'INR 450.00', 'Held on Account': 'INR 50.00', 'Balance Still Due on These Invoices': 'INR 150.00' });

  const advance = await pay({ amount: 250 });
  const adv = await documentFor(advance._id);
  expect(rows(adv)).toMatchObject({ 'Amount Received': 'INR 250.00', 'Held on Account': 'INR 250.00' });
});

test('a cancelled or refunded payment is marked, not presented as a valid receipt', async () => {
  const inv = await invoiceFor(100);
  const p = await pay({ invoiceId: String(inv._id), amount: 100 });
  expect((await api('put', `/api/payments/${p._id}`, { status: 'refunded' })).status).toBe(200);
  const d = await documentFor(p._id);
  expect(d.badge.text).toBe('REFUNDED');
  expect(d.footerNote).toMatch(/not valid proof/);
});

test('the route serves the PDF inline, downloads only on request, and is org-scoped', async () => {
  const inv = await invoiceFor(100);
  const p = await pay({ invoiceId: String(inv._id), amount: 60 });
  const get = (url, token = org.tokens.admin) => request(app).get(url).set(auth(token)).buffer().parse((r, cb) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
  const inline = await get(`/api/payments/${p._id}/receipt`);
  expect(inline.status).toBe(200);
  expect(inline.headers['content-disposition']).toMatch(/^inline/);
  expect(inline.body.subarray(0, 4).toString()).toBe('%PDF');
  expect((await get(`/api/payments/${p._id}/receipt?download=1`)).headers['content-disposition']).toMatch(/^attachment/);
  expect((await get(`/api/payments/${p._id}/receipt`, other.tokens.admin)).status).toBe(404);
});

test('an invoice clerk can print the receipt they recorded, without Payments access', async () => {
  await User.updateOne({ _id: org.staff1._id }, { permissions: ['Invoicing', 'Invoicing: Record Payment'] });
  await User.updateOne({ _id: org.staff2._id }, { permissions: ['Invoicing', 'Invoicing: Record Payment'] });
  const inv = await make.invoice(org.staff1, cust, { lines: [{ amount: 120, rate: 0 }] });
  const recorded = await request(app).post('/api/payments').set(auth(org.tokens.staff1)).send({
    customerId: String(cust._id), invoiceId: String(inv._id), amount: 50,
    paymentMethod: 'cash', idempotencyKey: `clerk-receipt-${Date.now()}`
  });
  expect(recorded.status).toBe(201);
  const id = recorded.body.data.payment._id;
  expect((await request(app).get('/api/payments').set(auth(org.tokens.staff1))).status).toBe(403);
  const own = await request(app).get(`/api/payments/${id}/receipt`).set(auth(org.tokens.staff1)).buffer(true);
  expect(own.status).toBe(200);
  expect(own.headers['content-type']).toMatch(/application\/pdf/);
  expect((await request(app).get(`/api/payments/${id}/receipt`).set(auth(org.tokens.staff2))).status).toBe(404);
});
