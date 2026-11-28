/**
 * Cross-tenant ID tests. Business A owns a record of each kind; business B's
 * admin (full permissions) names that record's id in every read and mutation
 * route. Each must answer 403/404 and leave A's record exactly as it was.
 * Raw minimal documents are inserted so the test does not depend on each
 * model's required fields: a correct handler never finds another tenant's row.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const { EXPLICIT_ONLY_ACTIONS, userCan } = require('../src/middleware/requirePermission');

let a;
let b;
const ids = {};
const COLLECTIONS = {
  customer: 'customers', invoice: 'invoices', quotation: 'quotations', payment: 'payments', job: 'jobs', inventory: 'inventories',
  purchaseOrder: 'purchaseorders', purchaseBill: 'purchasebills', vendor: 'vendors', delivery: 'deliveries', payroll: 'payrolls',
  creditNote: 'creditnotes', proof: 'proofs', accessRole: 'accessroles', employee: 'employees', walkIn: 'walkinjobs', task: 'tasks'
};

beforeAll(async () => {
  await connectTestDb('tenant_isolation');
  a = await createOrg('tenant_a');
  b = await createOrg('tenant_b');
  for (const [key, coll] of Object.entries(COLLECTIONS)) {
    const _id = new mongoose.Types.ObjectId();
    ids[key] = String(_id);
    await mongoose.connection.collection(coll).insertOne({
      _id, marker: 'untouched', name: `A ${key}`, status: 'draft', dataScope: a.dataScope, userId: a.admin._id, createdBy: a.admin._id,
      paymentStatus: 'pending', totalAmount: 100, balanceAmount: 100, quantity: 10, createdAt: new Date(), updatedAt: new Date()
    });
  }
});
afterAll(disconnectTestDb);

const hit = (method, url, body) => request(app)[method](url).set(auth(b.tokens.admin)).send(body);

const ATTACKS = [
  // [kind, method, path template, body]
  ['customer', 'get', '/api/customers/:id'], ['customer', 'put', '/api/customers/:id', { name: 'hacked', phone: '9811111111' }], ['customer', 'delete', '/api/customers/:id'],
  ['customer', 'post', '/api/customers/:id/update-stats'], ['customer', 'get', '/api/customers/:id/jobs'],
  ['invoice', 'get', '/api/invoices/:id'], ['invoice', 'put', '/api/invoices/:id', { notes: 'hacked' }], ['invoice', 'delete', '/api/invoices/:id'],
  ['invoice', 'patch', '/api/invoices/:id/cancel', { reason: 'x' }], ['invoice', 'patch', '/api/invoices/:id/issue'], ['invoice', 'patch', '/api/invoices/:id/payment-status', { manualPaidAmount: 100, reason: 'x' }],
  ['quotation', 'get', '/api/quotations/:id'], ['quotation', 'put', '/api/quotations/:id', { notes: 'hacked' }], ['quotation', 'patch', '/api/quotations/:id/status', { status: 'accepted' }],
  ['quotation', 'post', '/api/quotations/:id/convert-to-invoice'], ['quotation', 'delete', '/api/quotations/:id'],
  ['payment', 'get', '/api/payments/:id'], ['payment', 'put', '/api/payments/:id', { status: 'refunded' }], ['payment', 'delete', '/api/payments/:id'], ['payment', 'put', '/api/payments/:id/allocations', { allocations: [] }],
  ['creditNote', 'get', '/api/credit-notes/:id'], ['creditNote', 'patch', '/api/credit-notes/:id/issue'], ['creditNote', 'patch', '/api/credit-notes/:id/cancel'], ['creditNote', 'delete', '/api/credit-notes/:id'],
  ['purchaseOrder', 'get', '/api/purchase-orders/:id'], ['purchaseOrder', 'put', '/api/purchase-orders/:id', { notes: 'hacked' }], ['purchaseOrder', 'patch', '/api/purchase-orders/:id/status', { status: 'sent' }],
  ['purchaseOrder', 'post', '/api/purchase-orders/:id/receive', { lines: [{ inventoryId: '000000000000000000000001', quantity: 1 }] }], ['purchaseOrder', 'delete', '/api/purchase-orders/:id'],
  ['purchaseBill', 'get', '/api/purchase-bills/:id'], ['purchaseBill', 'put', '/api/purchase-bills/:id', { notes: 'hacked' }], ['purchaseBill', 'delete', '/api/purchase-bills/:id'],
  ['vendor', 'get', '/api/vendors/:id'], ['vendor', 'put', '/api/vendors/:id', { name: 'hacked' }], ['vendor', 'delete', '/api/vendors/:id'], ['vendor', 'post', '/api/vendors/:id/payment', { amount: 1 }],
  ['inventory', 'get', '/api/inventory/:id'], ['inventory', 'put', '/api/inventory/:id', { name: 'hacked' }], ['inventory', 'post', '/api/inventory/:id/adjust', { quantity: 0, reason: 'steal' }], ['inventory', 'delete', '/api/inventory/:id'],
  ['job', 'get', '/api/jobs/:id'], ['job', 'put', '/api/jobs/:id', { title: 'hacked' }], ['job', 'post', '/api/jobs/:id/update-status', { status: 'completed' }], ['job', 'post', '/api/jobs/:id/assign', { assignedTo: '000000000000000000000001' }], ['job', 'post', '/api/jobs/:id/update-flow-stage', { stage: 'printing' }], ['job', 'delete', '/api/jobs/:id'],
  ['delivery', 'get', '/api/deliveries/:id'], ['delivery', 'put', '/api/deliveries/:id/status', { status: 'delivered' }], ['delivery', 'put', '/api/deliveries/:id', { notes: 'hacked' }], ['delivery', 'delete', '/api/deliveries/:id'],
  ['payroll', 'get', '/api/hr/payroll/:id/payslip'], ['payroll', 'put', '/api/hr/payroll/:id', { notes: 'hacked' }], ['payroll', 'patch', '/api/hr/payroll/:id/pay', {}], ['payroll', 'delete', '/api/hr/payroll/:id'],
  ['employee', 'get', '/api/hr/employees/:id'], ['employee', 'put', '/api/hr/employees/:id', { name: 'hacked' }], ['employee', 'delete', '/api/hr/employees/:id'],
  ['proof', 'put', '/api/proofs/:id/approve', {}], ['proof', 'put', '/api/proofs/:id/reject', { reason: 'x' }], ['proof', 'delete', '/api/proofs/:id'],
  ['accessRole', 'put', '/api/access-roles/:id', { name: 'hacked', permissions: ['Dashboard'] }], ['accessRole', 'delete', '/api/access-roles/:id'],
  ['walkIn', 'put', '/api/walk-in-jobs/:id/status', { status: 'completed' }], ['walkIn', 'delete', '/api/walk-in-jobs/:id'],
  ['task', 'delete', '/api/tasks/:id'], ['task', 'put', '/api/tasks/:id/progress', { progress: 100 }]
];

test.each(ATTACKS.map(([k, m, t, body]) => [k, m, t, body || {}]))('%s: %s %s from another business is refused', async (kind, method, template, body) => {
  const res = await hit(method, template.replace(':id', ids[kind]), body);
  expect([400, 403, 404, 405]).toContain(res.status);
  expect(res.status).not.toBeLessThan(400);
});

test('after every attack, no other tenant record was changed or removed', async () => {
  for (const [kind, coll] of Object.entries(COLLECTIONS)) {
    const doc = await mongoose.connection.collection(coll).findOne({ _id: new mongoose.Types.ObjectId(ids[kind]) });
    expect([kind, Boolean(doc)]).toEqual([kind, true]);
    expect([kind, doc.marker, doc.name, doc.status, doc.dataScope]).toEqual([kind, 'untouched', `A ${kind}`, 'draft', a.dataScope]);
  }
});

test('lists never include another business\'s rows', async () => {
  for (const url of ['/api/customers?status=all', '/api/invoices', '/api/quotations', '/api/payments', '/api/jobs', '/api/inventory', '/api/purchase-orders', '/api/purchase-bills', '/api/vendors', '/api/deliveries', '/api/hr/payroll', '/api/hr/employees']) {
    const res = await request(app).get(url).set(auth(b.tokens.admin));
    expect([url, res.status]).toEqual([url, 200]);
    expect([url, JSON.stringify(res.body).includes(a.dataScope)]).toEqual([url, false]);
    expect([url, JSON.stringify(res.body).includes('"A ')]).toEqual([url, false]);
  }
});

test('sensitive exports and user management are scoped to the caller\'s business', async () => {
  const month = new Date().toISOString().slice(0, 7);
  for (const url of [`/api/reports/monthly?month=${month}`, `/api/reports/customers?month=${month}`, '/api/activity-log/export']) {
    const res = await request(app).get(url).set(auth(b.tokens.admin));
    expect([url, res.status < 500]).toEqual([url, true]);
    expect(JSON.stringify(res.body || '').includes(a.dataScope)).toBe(false);
  }
  const users = await request(app).get('/api/users').set(auth(b.tokens.admin));
  expect(JSON.stringify(users.body)).not.toMatch(new RegExp(a.admin.email));
  const toggle = await request(app).put(`/api/users/${a.staff1._id}/toggle-status`).set(auth(b.tokens.admin));
  expect([403, 404]).toContain(toggle.status);
  const edit = await request(app).put(`/api/users/${a.staff1._id}`).set(auth(b.tokens.admin)).send({ fullName: 'hacked', role: 'admin' });
  expect([403, 404]).toContain(edit.status);
  const del = await request(app).delete(`/api/users/${a.staff1._id}`).set(auth(b.tokens.admin));
  expect([403, 404]).toContain(del.status);
});

describe('legacy module-only grants never carry destructive or privilege actions', () => {
  const legacy = { role: 'staff', permissions: ['Customers', 'Payments', 'Invoicing', 'Inventory', 'Payroll', 'User Management', 'Human Resources'] };
  test.each([...EXPLICIT_ONLY_ACTIONS].flatMap((action) =>
    ['Customers', 'Payments', 'Invoicing', 'Inventory', 'Payroll', 'User Management', 'Human Resources'].map((m) => [m, action])
  ))('%s: %s', (module, action) => {
    expect(userCan(legacy, `${module}: ${action}`)).toBe(false);
    expect(userCan({ ...legacy, permissions: [...legacy.permissions, `${module}: ${action}`] }, `${module}: ${action}`)).toBe(true);
  });
  test('routine actions still work for a legacy grant', () => {
    expect(userCan(legacy, 'Customers: Create & Edit')).toBe(true);
    expect(userCan(legacy, 'Payments: Record Payment')).toBe(true);
  });
});

describe('staff without the action cannot mutate financial records of their own business', () => {
  test.each([
    ['post', '/api/payments', 'Payments: Record Payment'],
    ['delete', '/api/payments/:payment', 'Payments: Delete'],
    ['patch', '/api/invoices/:invoice/cancel', 'Invoicing: Delete'],
    ['patch', '/api/invoices/:invoice/payment-status', 'Invoicing: Correct Balance'],
    ['post', '/api/inventory/:inventory/adjust', 'Inventory: Adjust Stock'],
    ['patch', '/api/hr/payroll/:payroll/pay', 'Payroll: Process Payroll'],
    ['delete', '/api/purchase-bills/:purchaseBill', 'Purchase Bills: Delete'],
    ['put', '/api/access-roles/:accessRole', 'User Management: Edit Permissions']
  ])('%s %s needs %s', async (method, template, permission) => {
    const module = permission.split(': ')[0];
    const User = require('../src/models/User');
    await User.updateOne({ _id: a.staff1._id }, { $set: { permissions: ['Dashboard', module, `${module}: View`] } });
    const url = template.replace(/:(\w+)/g, (_, k) => ids[k] || ':' + k);
    const res = await request(app)[method](url).set(auth(a.tokens.staff1)).send({});
    expect([url, res.status]).toEqual([url, 403]);
  });
});
