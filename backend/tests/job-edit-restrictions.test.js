/** Editing a job ticket: free while open, restricted once billed/finished, closed when cancelled. */
const request = require('supertest');
const app = require('../src/app');
const Inventory = require('../src/models/Inventory');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;
let other;
const api = (m, url, body) => request(app)[m](url).set(auth(org.tokens.admin)).send(body);

beforeAll(async () => {
  await connectTestDb('jobedit');
  org = await createOrg('jed');
  cust = await make.customer(org.admin, { name: 'Edit Cust' });
  other = await make.customer(org.admin, { name: 'Other Cust' });
});
afterAll(disconnectTestDb);

const base = (extra = {}) => ({
  title: 'Brochure', customerId: String(cust._id), priority: 'medium', estimatedCost: 500,
  items: [{ itemName: 'Brochure', quantity: 100, unitPrice: 5, gstRate: 12, unit: 'pieces', itemType: 'Numbers' }], ...extra
});
const newJob = async (extra) => (await api('post', '/api/jobs', base(extra))).body.data.job;
const put = (job, patch) => api('put', `/api/jobs/${job._id}`, { ...base(), ...patch });

test('an open job can change customer, cost, items, priority, date and instructions', async () => {
  const job = await newJob();
  const res = await put(job, { customerId: String(other._id), estimatedCost: 900, priority: 'high', dueDate: '2026-12-31', specialInstructions: 'Fold twice',
    items: [{ itemName: 'Brochure', quantity: 200, unitPrice: 5, gstRate: 12, unit: 'pieces', itemType: 'Numbers' }] });
  expect(res.status).toBe(200);
  expect(res.body.data.job).toMatchObject({ priority: 'high', estimatedCost: 900, specialInstructions: 'Fold twice' });
  expect(res.body.data.job.items[0].quantity).toBe(200);
  expect(String(res.body.data.job.customerId._id || res.body.data.job.customerId)).toBe(String(other._id));
});

test('once invoiced, billed fields are locked but priority, date and instructions are not', async () => {
  const job = await newJob();
  const inv = await api('post', '/api/invoices', { customerId: String(cust._id), jobId: job._id, status: 'sent',
    items: job.items.map(({ itemName, quantity, unitPrice, gstRate, unit, itemType }) => ({ itemName, quantity, unitPrice, gstRate, unit, itemType })) });
  expect(inv.status).toBe(201);

  const locked = await put(job, { estimatedCost: 999 });
  expect(locked.status).toBe(409);
  expect(locked.body.code).toBe('JOB_INVOICED');
  expect((await put(job, { customerId: String(other._id) })).status).toBe(409);
  expect((await put(job, { items: [{ itemName: 'Brochure', quantity: 1, unitPrice: 5, gstRate: 12, unit: 'pieces', itemType: 'Numbers' }] })).status).toBe(409);

  const ok = await put(job, { priority: 'urgent', dueDate: '2027-01-15', specialInstructions: 'Rush' });
  expect(ok.status).toBe(200);
  expect(ok.body.data.job.priority).toBe('urgent');

  // Cancelling the invoice frees the job for billing edits again.
  await api('patch', `/api/invoices/${inv.body.data.invoice._id}/cancel`, { reason: 'redo' });
  expect((await put(job, { estimatedCost: 999 })).status).toBe(200);
});

test('a cancelled job cannot be edited', async () => {
  const job = await newJob();
  await api('put', `/api/jobs/${job._id}`, { ...base(), status: 'cancelled' });
  const res = await put(job, { priority: 'low' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('JOB_CANCELLED');
});

test('a completed job locks billed fields', async () => {
  const job = await newJob();
  await api('put', `/api/jobs/${job._id}`, { ...base(), status: 'completed' });
  const res = await put(job, { estimatedCost: 1 });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('JOB_FINISHED');
  expect((await put(job, { priority: 'low' })).status).toBe(200);
});
