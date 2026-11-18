/**
 * The old DELETE /invoices/clear-duplicate maintenance route (hard-coded to
 * one invoice number) is gone: the path deletes nothing.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
beforeAll(async () => {
  await connectTestDb('invoice_maintenance_route');
  org = await createOrg('clearduplicate');
});
afterAll(disconnectTestDb);

test('DELETE /invoices/clear-duplicate deletes nothing', async () => {
  const customer = await make.customer(org.admin);
  const invoice = await make.invoice(org.admin, customer, { invoiceNumber: 'INV-202603-0001' });
  const res = await request(app).delete('/api/invoices/clear-duplicate').set(auth(org.tokens.admin));
  expect(res.status).not.toBe(200);
  expect(await Invoice.exists({ _id: invoice._id })).not.toBeNull();
  const router = require('../src/routes/invoices');
  expect(router.stack.some((layer) => layer.route?.path === '/clear-duplicate')).toBe(false);
});
