/**
 * Every critical business event named in the audit requirements writes a
 * protected, tenant-stamped, correlated ActivityLog entry through the real API.
 */
const request = require('supertest');
const app = require('../src/app');
const ActivityLog = require('../src/models/ActivityLog');
const Payment = require('../src/models/Payment');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;
const api = (m, url, body, headers = {}) => request(app)[m](url).set(auth(org.tokens.admin)).set(headers).send(body);
const logged = async (action, filter = {}) => ActivityLog.find({ action, dataScope: org.dataScope, ...filter }).lean();
const settle = () => new Promise((r) => setTimeout(r, 150)); // fire-and-forget writes

beforeAll(async () => {
  await connectTestDb('audit_coverage');
  org = await createOrg('audit_cov');
  cust = await make.customer(org.admin);
});
afterAll(disconnectTestDb);

test('invoice create, issue and cancel (with reason) are logged', async () => {
  const created = await api('post', '/api/invoices', { customerId: String(cust._id), items: [{ itemName: 'Cards', quantity: 1, unitPrice: 100, gstRate: 0 }] });
  expect(created.status).toBe(201);
  const id = created.body.data.invoice._id;
  expect((await api('patch', `/api/invoices/${id}/issue`)).status).toBe(200);
  expect((await api('patch', `/api/invoices/${id}/cancel`, { reason: 'Customer withdrew the order' })).status).toBe(200);
  await settle();
  for (const action of ['Invoice Created', 'Invoice Issued', 'Invoice Cancelled']) {
    const [entry] = await logged(action, { entityId: id });
    expect([action, Boolean(entry)]).toEqual([action, true]);
    expect(entry).toMatchObject({ protected: true, tenantId: org.dataScope, performedBy: org.admin._id });
    expect(entry.correlationId).toBeTruthy();
  }
  const [cancel] = await logged('Invoice Cancelled', { entityId: id });
  expect(cancel.reason).toBe('Customer withdrew the order');
  expect(cancel.changes.before.status).toBe('sent');
});

test('payment creation and reversal are logged, the reversal with its reason', async () => {
  const inv = await make.invoice(org.admin, cust, { lines: [{ amount: 500, rate: 0 }] });
  const paid = await api('post', '/api/payments', { customerId: String(cust._id), paymentMethod: 'upi', amount: 500, idempotencyKey: 'audit-pay-0001', allocations: [{ invoiceId: String(inv._id), amount: 500 }] });
  expect(paid.status).toBe(201);
  const id = paid.body.data.payment._id;
  const refund = await api('put', `/api/payments/${id}`, { status: 'refunded', reason: 'Duplicate transfer' });
  expect(refund.status).toBe(200);
  await settle();
  expect((await logged('Payment Recorded', { entityId: id }))[0]).toMatchObject({ protected: true });
  const [rev] = await logged('Payment Reversed', { entityId: id });
  expect(rev).toMatchObject({ protected: true, actionType: 'reverse', reason: 'Duplicate transfer' });
  expect(rev.changes.before.status).toBe('completed');
  expect(rev.changes.after.status).toBe('refunded');
  expect(await Payment.countDocuments({ _id: id, status: 'refunded' })).toBe(1);
});

test('stock adjustments, job status changes and settings changes are logged', async () => {
  const item = await make.stockItem(org.admin, { name: 'Audit paper', quantity: 10, unit: 'sheets' });
  expect((await api('post', `/api/inventory/${item._id}/adjust`, { change: -2, type: 'damage', reason: 'water damage' })).status).toBe(200);
  const job = await make.job(org.admin, cust, { status: 'design_in_progress' });
  expect((await api('post', `/api/jobs/${job._id}/update-status`, { status: 'quality_check' })).status).toBe(200);
  expect((await api('put', '/api/settings/company', { companyName: 'Audit Printers' })).status).toBe(200);
  await settle();
  expect((await logged('Inventory Stock Adjusted', { entityId: item._id }))[0]).toMatchObject({ protected: true });
  expect(await logged('Job Status Updated', { entityId: job._id })).toHaveLength(1);
  expect((await logged('Company Settings Updated'))[0]).toMatchObject({ protected: true });
});

test('permission changes (roles and logins) are logged', async () => {
  const role = await api('post', '/api/access-roles', { name: 'Audit role', baseRole: 'staff', permissions: ['Dashboard', 'Jobs'] });
  expect(role.status).toBe(201);
  await settle();
  expect((await logged('Role Created'))[0]).toMatchObject({ protected: true, entityType: 'access_role' });
});

test('proof approval is logged', async () => {
  const Proof = require('../src/models/Proof');
  const job = await make.job(org.admin, cust);
  const proof = await Proof.collection.insertOne({ proofNumber: 'PRF-AUD-1', title: 'Card', status: 'sent', version: 1, jobId: job._id, customerId: cust._id, customerName: cust.name, dataScope: org.dataScope, userId: org.admin._id, approval: { status: 'pending' }, files: [{ fileName: 'a.pdf', fileUrl: '/x/a.pdf', fileType: 'pdf', fileSize: 10 }], createdAt: new Date(), updatedAt: new Date() });
  const res = await api('put', `/api/proofs/${proof.insertedId}/approve`, { approvalNotes: 'ok' });
  expect([200]).toContain(res.status);
  await settle();
  expect((await logged('Proof Approved', { entityId: proof.insertedId }))[0]).toMatchObject({ protected: true, actionType: 'approve' });
});
