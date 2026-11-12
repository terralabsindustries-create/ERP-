const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let firstCustomer;
let month;

beforeAll(async () => {
  await connectTestDb('customer_report');
  org = await createOrg('customer_report');
  const other = await createOrg('customer_report_other');
  firstCustomer = await make.customer(org.admin, { name: 'First Press' });
  const secondCustomer = await make.customer(org.admin, { name: 'Second Press' });
  const foreignCustomer = await make.customer(other.admin);
  month = new Date().toISOString().slice(0, 7);

  await make.invoice(org.admin, firstCustomer, { lines: [{ amount: 1000, rate: 18 }], paidAmount: 200 });
  await make.invoice(org.manager, firstCustomer, { lines: [{ amount: 2000, rate: 0 }] });
  await make.invoice(org.admin, secondCustomer, { lines: [{ amount: 500, rate: 0 }] });
  await make.invoice(org.admin, firstCustomer, { status: 'draft', lines: [{ amount: 9999, rate: 0 }] });
  await make.invoice(org.admin, secondCustomer, { status: 'cancelled', lines: [{ amount: 9999, rate: 0 }] });
  await make.invoice(org.admin, firstCustomer, { noGst: true, lines: [{ amount: 300, rate: 0 }] });
  await make.invoice(other.admin, foreignCustomer, { lines: [{ amount: 9999, rate: 0 }] });
});

afterAll(disconnectTestDb);

test('customer totals reconcile with issued monthly invoices and expose their invoice detail', async () => {
  const response = await request(app).get(`/api/reports/customers?month=${month}`).set(auth(org.tokens.admin));
  expect(response.status).toBe(200);
  const report = response.body.data;
  expect(report.draftCount).toBe(1);
  expect(report.customers).toHaveLength(2);
  expect(report.totals).toEqual({ invoiceCount: 3, draftCount: 1, totalInvoiced: 3680, paidToDate: 200, outstanding: 3480 });
  expect(report.customers.find((row) => row.customerId === String(firstCustomer._id))).toMatchObject({
    invoiceCount: 2, draftCount: 1, totalInvoiced: 3180, paidToDate: 200, outstanding: 2980
  });

  const detail = await request(app).get(`/api/reports/customers/${firstCustomer._id}/invoices?month=${month}`).set(auth(org.tokens.admin));
  expect(detail.status).toBe(200);
  expect(detail.body.data.pagination.total).toBe(3);
  expect(detail.body.data.invoices.map((invoice) => invoice.status).sort()).toEqual(['draft', 'sent', 'sent']);
});

test('customer report respects staff invoice visibility', async () => {
  await User.updateOne({ _id: org.manager._id }, { canViewAllData: false });
  const response = await request(app).get(`/api/reports/customers?month=${month}`).set(auth(org.tokens.manager));
  expect(response.status).toBe(200);
  expect(response.body.data.totals).toMatchObject({ invoiceCount: 1, totalInvoiced: 2000 });
  const detail = await request(app).get(`/api/reports/customers/${firstCustomer._id}/invoices?month=${month}`).set(auth(org.tokens.manager));
  expect(detail.body.data.pagination.total).toBe(1);
});
