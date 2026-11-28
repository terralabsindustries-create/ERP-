const request = require('supertest');
const app = require('../src/app');
const Payment = require('../src/models/Payment');
const Customer = require('../src/models/Customer');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const { financialsOne } = require('../src/services/customerFinancials');

let org;
let other;
let cust;
const get = (url, token) => request(app).get(url).set(auth(token || org.tokens.admin));
const scope = () => ({ dataScope: org.admin.dataScope });

beforeAll(async () => {
  await connectTestDb('customer_financials');
  org = await createOrg('customer_financials');
  other = await createOrg('customer_financials_other');
  cust = await make.customer(org.admin, { name: 'Revenue Press' });
});
afterAll(disconnectTestDb);

test('totalRevenue is invoiced revenue, not Job.estimatedCost; cancelled, draft and foreign invoices never count', async () => {
  await make.job(org.admin, cust, { estimatedCost: 50000 });
  await make.job(org.admin, cust, { estimatedCost: 25000, status: 'cancelled' });
  await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 18 }] }); // unpaid 1180
  const partial = await make.invoice(org.admin, cust, { lines: [{ amount: 2000, rate: 0 }], paidAmount: 500, balanceAmount: 1500, paymentStatus: 'partial' });
  const paid = await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 0 }], status: 'paid', paidAmount: 1000, balanceAmount: 0, paymentStatus: 'paid' });
  await make.invoice(org.admin, cust, { lines: [{ amount: 7777, rate: 0 }], status: 'cancelled' });
  await make.invoice(org.admin, cust, { lines: [{ amount: 8888, rate: 0 }], status: 'draft' });
  const foreignCust = await make.customer(other.admin);
  await make.invoice(other.admin, foreignCust, { lines: [{ amount: 9999, rate: 0 }] });
  for (const [inv, amount] of [[partial, 500], [paid, 1000]]) {
    await Payment.create({
      paymentId: `P-${inv.invoiceNumber}`, customerId: cust._id, customerName: cust.name, invoiceId: inv._id,
      allocations: [{ invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, amount }], amount, paymentMethod: 'cash',
      status: 'completed', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.admin.dataScope
    });
  }

  const f = await financialsOne(cust._id, scope());
  expect(f).toMatchObject({
    estimatedJobValue: 50000, totalOrders: 1,
    grossInvoiced: 4180, invoicedRevenue: 4180, invoiceCount: 3,
    cancelledInvoiced: 7777, cancelledInvoiceCount: 1,
    paymentsReceived: 1500, receivables: 2680, outstanding: 2680
  });
  // revenue (billed) is not collections (received) and not the production estimate
  expect(f.invoicedRevenue).not.toBe(f.paymentsReceived);
  expect(f.invoicedRevenue).not.toBe(f.estimatedJobValue);
});

test('credit and debit notes adjust invoiced revenue and receivables', async () => {
  const c = await make.customer(org.admin);
  const inv = await make.invoice(org.admin, c, { lines: [{ amount: 1000, rate: 0 }], creditNoteApplied: 200, debitNoteTotal: 100 });
  const CreditNote = require('../src/models/CreditNote');
  const base = { invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, customerId: c._id, customerName: c.name, status: 'issued', userId: org.admin._id, dataScope: org.admin.dataScope, createdBy: org.admin._id };
  await CreditNote.collection.insertOne({ ...base, noteType: 'credit', noteNumber: 'CN-T-1', totalAmount: 200, noteDate: new Date() });
  await CreditNote.collection.insertOne({ ...base, noteType: 'credit', noteNumber: 'CN-T-2', totalAmount: 999, status: 'draft', noteDate: new Date() });
  const f = await financialsOne(c._id, scope());
  expect(f).toMatchObject({ grossInvoiced: 1000, creditNotesTotal: 200, debitNotesTotal: 100, invoicedRevenue: 900, outstanding: 900 });
});

test('an unapplied advance reduces outstanding but is not revenue', async () => {
  const c = await make.customer(org.admin);
  await make.invoice(org.admin, c, { lines: [{ amount: 1000, rate: 0 }], balanceAmount: 1000 });
  await Payment.create({ paymentId: 'ADV-1', customerId: c._id, customerName: c.name, amount: 300, paymentMethod: 'cash', status: 'completed', allocations: [], userId: org.admin._id, createdBy: org.admin._id, dataScope: org.admin.dataScope });
  const f = await financialsOne(c._id, scope());
  expect(f).toMatchObject({ invoicedRevenue: 1000, paymentsReceived: 300, onAccount: 300, outstanding: 700 });
});

test('customer record, list, update-stats and the customer report reconcile', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const detail = (await get(`/api/customers/${cust._id}`)).body.data.customer;
  const list = (await get('/api/customers?status=all&limit=100')).body.data.customers.find((c) => c._id === String(cust._id));
  expect(detail.financials.invoicedRevenue).toBe(list.billing.invoiced);
  expect(detail.financials.outstanding).toBe(list.billing.outstanding);

  const stats = await request(app).post(`/api/customers/${cust._id}/update-stats`).set(auth(org.tokens.admin));
  expect(stats.status).toBe(200);
  const stored = await Customer.findById(cust._id);
  expect(stored.totalRevenue).toBe(detail.financials.invoicedRevenue);
  expect(stored.totalSpent).toBe(detail.financials.paymentsReceived);
  expect(stored.outstandingBalance).toBe(detail.financials.outstanding);
  expect(stored.estimatedJobValue).toBe(50000);

  const report = (await get(`/api/reports/customers?month=${month}`)).body.data.customers.find((r) => r.customerId === String(cust._id));
  expect(report.totalInvoiced).toBe(detail.financials.grossInvoiced);
  expect(report.outstanding).toBe(detail.financials.receivables);
});

test('another tenant cannot read this customer or its financials', async () => {
  expect((await get(`/api/customers/${cust._id}`, other.tokens.admin)).status).toBe(404);
});
