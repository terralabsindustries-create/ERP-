/**
 * Global search: a customer's name finds their jobs, quotations and invoices,
 * never another business's records, and each section follows permissions.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a;
let b;
beforeAll(async () => {
  await connectTestDb('globalsearch');
  a = await createOrg('gsa');
  b = await createOrg('gsb');
  const ravi = await make.customer(a.admin, { name: 'Ravi Offset Prints', company: 'Ravi Group', phone: '98470 12345' });
  await make.job(a.admin, ravi, { title: 'Annual report 2026' });
  await make.invoice(a.admin, ravi, { jobTitle: 'Annual report 2026' });
  // Same name in another business: must never appear.
  const other = await make.customer(b.admin, { name: 'Ravi Offset Prints' });
  await make.job(b.admin, other, { title: 'Secret job' });
  await make.invoice(b.admin, other, {});
});
afterAll(disconnectTestDb);

const search = (token, q) => request(app).get(`/api/search?q=${encodeURIComponent(q)}`).set(auth(token));

test('a customer name finds the customer and their jobs and invoices', async () => {
  const res = await search(a.tokens.admin, 'ravi offset');
  expect(res.status).toBe(200);
  const d = res.body.data;
  expect(d.customers.map((c) => c.name)).toEqual(['Ravi Offset Prints']);
  expect(d.jobs.map((j) => j.title)).toEqual(['Annual report 2026']);
  expect(d.jobs[0].customerId.name).toBe('Ravi Offset Prints');
  expect(d.invoices).toHaveLength(1);
});

test('company and phone digits match too', async () => {
  expect((await search(a.tokens.admin, 'Ravi Group')).body.data.jobs).toHaveLength(1);
  expect((await search(a.tokens.admin, '9847012345')).body.data.customers).toHaveLength(1);
});

test('stays inside the business', async () => {
  const res = await search(a.tokens.admin, 'Secret');
  expect(res.body.data.jobs).toHaveLength(0);
  const theirs = await search(b.tokens.admin, 'ravi offset');
  expect(theirs.body.data.jobs.map((j) => j.title)).toEqual(['Secret job']);
});

test('text is matched literally, not as a regex', async () => {
  const res = await search(a.tokens.admin, '.*');
  expect(res.status).toBe(200);
  expect(res.body.data.customers).toHaveLength(0);
});

test('sections follow permissions', async () => {
  await User.updateOne({ _id: a.staff1._id }, { permissions: ['Dashboard', 'Customers', 'Customers: View'] });
  const res = await search(a.tokens.staff1, 'ravi');
  expect(res.body.data.customers).toHaveLength(1);
  expect(res.body.data.jobs).toHaveLength(0);
  expect(res.body.data.invoices).toHaveLength(0);
});

test('the job list search also finds a customer\'s jobs', async () => {
  const res = await request(app).get('/api/jobs?search=Ravi%20Offset').set(auth(a.tokens.admin));
  expect(res.body.data.jobs.map((j) => j.title)).toEqual(['Annual report 2026']);
});
