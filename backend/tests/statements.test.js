/**
 * Customer statements reconcile with the documents. (Payment receipts are
 * covered by payment-receipts.test.js.)
 */
const request = require('supertest');
const app = require('../src/app');
const Settings = require('../src/models/Settings');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
const today = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
const api = (token) => ({
  get: (u) => request(app).get(u).set(auth(token)),
  post: (u, b) => request(app).post(u).set(auth(token)).send(b),
  patch: (u, b) => request(app).patch(u).set(auth(token)).send(b || {})
});
let a;
const bin = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

beforeAll(async () => {
  await connectTestDb('statements');
  org = await createOrg('st');
  other = await createOrg('sto');
  const s = await Settings.getOrCreateSettings(org.admin._id);
  s.companyName = 'Statement Printers';
  await s.save();
  a = api(org.tokens.admin);
  cust = await make.customer(org.admin, { name: 'Ledger Customer' });
  // Opening balance: an invoice dated long ago.
  await make.invoice(org.admin, cust, { invoiceNumber: 'INV-OLD-1', invoiceDate: new Date('2026-01-10'), dueDate: new Date('2026-02-10'), lines: [{ amount: 1000, rate: 0 }], balanceAmount: 1000 });
  const issue = async (amount) => (await a.post('/api/invoices', { customerId: cust._id, status: 'sent', items: [{ itemName: 'Print', quantity: 1, unitPrice: amount, gstRate: 18 }] })).body.data.invoice;
  const i1 = await issue(1000); // 1180
  const i2 = await issue(500); // 590
  const cancelled = await issue(200);
  await a.patch(`/api/invoices/${cancelled._id}/cancel`, { reason: 'duplicate' });
  expect((await a.post('/api/payments', { customerId: cust._id, invoiceId: i1._id, amount: 1180, paymentMethod: 'upi', referenceNumber: 'UPI123' })).status).toBe(201);
  expect((await a.post('/api/payments', { customerId: cust._id, amount: 100, paymentMethod: 'cash' })).status).toBe(201); // on account
  const cn = await a.post('/api/credit-notes', { noteType: 'credit', invoiceId: i2._id, reason: 'post_sale_discount', items: [{ invoiceLineRef: String(i2.items[0]._id), taxableValue: 100 }] });
  await a.patch(`/api/credit-notes/${cn.body.data.note._id}/issue`);
}, 60000);
afterAll(disconnectTestDb);

test('opening, period lines, running and closing balance', async () => {
  const res = await a.get(`/api/statements/customer/${cust._id}?from=2026-06-01&to=${today()}`);
  expect(res.status).toBe(200);
  const st = res.body.data;
  expect(st.opening).toBe(1000);
  expect(st.lines.map((l) => l.type)).toEqual(expect.arrayContaining(['Invoice', 'Payment', 'Credit note']));
  expect(st.lines.filter((l) => l.type === 'Invoice')).toHaveLength(2); // cancelled one is not in the balance
  expect(st.debits).toBe(1770);
  expect(st.credits).toBe(1180 + 100 + 118);
  expect(st.closing).toBe(1000 + 1770 - 1398);
  expect(st.lines[st.lines.length - 1].balance).toBe(st.closing);
  expect(st.voided).toEqual([expect.objectContaining({ type: 'Cancelled invoice', amount: 236, reason: 'duplicate' })]);
});

test('the statement balance reconciles with invoice balances, money on account and unapplied credit', async () => {
  const st = (await a.get(`/api/statements/customer/${cust._id}?from=2026-01-01&to=${today()}`)).body.data;
  expect(st.reconciliation).toMatchObject({ balanced: true, onAccount: 100 });
  expect(st.reconciliation.statementBalance).toBe(st.closing);
});

test('ageing groups what is still due', async () => {
  const st = (await a.get(`/api/statements/customer/${cust._id}?from=2026-01-01&to=${today()}`)).body.data;
  expect(st.ageing.d90plus).toBe(1000);
  expect(st.ageing.current).toBe(472);
});

test('PDF and Excel exports', async () => {
  const pdf = await a.get(`/api/statements/customer/${cust._id}?format=pdf`).buffer(true).parse(bin);
  expect(pdf.status).toBe(200);
  expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
  const xlsx = await a.get(`/api/statements/customer/${cust._id}?format=xlsx`).buffer(true).parse(bin);
  expect(xlsx.body.slice(0, 2).toString()).toBe('PK');
});

test('another business cannot read this customer\'s statement', async () => {
  expect((await api(other.tokens.admin).get(`/api/statements/customer/${cust._id}`)).status).toBe(404);
});
