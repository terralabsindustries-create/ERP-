/** Bulk issue: each draft checked on its own, numbers in order, failures reported, other businesses untouched. */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org; let other;
beforeAll(async () => { await connectTestDb('bulkinv'); org = await createOrg('bi'); other = await createOrg('bio'); });
afterAll(disconnectTestDb);

test('issues selected drafts in order and reports each failure', async () => {
  const cust = await make.customer(org.admin);
  const a = (u, b) => request(app).post(u).set(auth(org.tokens.admin)).send(b);
  const drafts = [];
  for (let i = 0; i < 3; i += 1) drafts.push((await a('/api/invoices', { customerId: cust._id, items: [{ itemName: 'X', quantity: 1, unitPrice: 10, gstRate: 18 }] })).body.data.invoice);
  const issued = (await a('/api/invoices', { customerId: cust._id, status: 'sent', items: [{ itemName: 'Y', quantity: 1, unitPrice: 10, gstRate: 18 }] })).body.data.invoice;
  const theirs = await make.invoice(other.admin, await make.customer(other.admin), { status: 'draft', invoiceNumber: 'DRAFT-99999' });
  const res = await a('/api/invoices-bulk/issue', { ids: [drafts[0]._id, drafts[1]._id, issued._id, theirs._id, drafts[2]._id] });
  expect(res.status).toBe(200);
  const nums = res.body.data.succeeded.map((s) => s.invoiceNumber);
  expect(nums).toHaveLength(3);
  expect([...nums].sort()).toEqual(nums);
  expect(res.body.data.failed.map((f) => f.reason)).toEqual(['Only a draft invoice can be issued.', 'Invoice not found']);
  expect((await Invoice.findById(theirs._id)).status).toBe('draft');
  expect((await request(app).post('/api/invoices-bulk/issue').set(auth(org.tokens.staff1)).send({ ids: [drafts[0]._id] })).status).toBe(403);
});
