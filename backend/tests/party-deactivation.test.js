/** Customers and suppliers are deactivated, not destroyed, once they have history. */
const request = require('supertest');
const app = require('../src/app');
const Customer = require('../src/models/Customer');
const Vendor = require('../src/models/Vendor');
const PurchaseOrder = require('../src/models/PurchaseOrder');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
const api = (m, url, body) => request(app)[m](url).set(auth(org.tokens.admin)).send(body);

beforeAll(async () => {
  await connectTestDb('parties');
  org = await createOrg('pty');
});
afterAll(disconnectTestDb);

describe('customers', () => {
  test('DELETE deactivates (with an honest message) and reactivate restores', async () => {
    const c = await make.customer(org.admin, { name: 'Soft Cust' });
    const del = await api('delete', `/api/customers/${c._id}`);
    expect(del.status).toBe(200);
    expect(del.body.message).toMatch(/deactivated/i);
    expect(del.body.message).not.toMatch(/deleted successfully/i);
    expect((await Customer.findById(c._id)).status).toBe('inactive');
    const re = await api('patch', `/api/customers/${c._id}/reactivate`);
    expect(re.status).toBe(200);
    const after = await Customer.findById(c._id);
    expect(after.status).toBe('active');
  });

  test('permanent delete is allowed with no history, refused with an invoice', async () => {
    const clean = await make.customer(org.admin, { name: 'Clean Cust' });
    expect((await api('delete', `/api/customers/${clean._id}?permanent=true`)).status).toBe(200);
    expect(await Customer.findById(clean._id)).toBeNull();

    const busy = await make.customer(org.admin, { name: 'Busy Cust' });
    await make.invoice(org.admin, busy, { lines: [{ amount: 100, rate: 0 }] });
    const res = await api('delete', `/api/customers/${busy._id}?permanent=true`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_HAS_HISTORY');
    expect(await Customer.findById(busy._id)).not.toBeNull();
  });
});

describe('suppliers', () => {
  test('deactivate/reactivate; delete refused once a purchase order exists', async () => {
    const v = await Vendor.create({ name: 'Paper Co', userId: org.admin._id, dataScope: org.admin.dataScope });
    const off = await api('patch', `/api/vendors/${v._id}/deactivate`);
    expect(off.status).toBe(200);
    expect((await Vendor.findById(v._id)).status).toBe('inactive');

    // An inactive supplier is not offered for new orders.
    const po = await api('post', '/api/purchase-orders', { vendorId: String(v._id), items: [{ inventoryId: String(org.admin._id), quantity: 1, unitCost: 1 }] });
    expect(po.status).toBe(400);
    expect(po.body.code).toBe('VENDOR_INACTIVE');

    expect((await api('patch', `/api/vendors/${v._id}/reactivate`)).status).toBe(200);
    expect((await Vendor.findById(v._id)).status).toBe('active');

    await PurchaseOrder.collection.insertOne({ poNumber: `PO-T-${Date.now()}`, vendorId: v._id, vendorName: v.name, userId: org.admin._id, status: 'draft' });
    const del = await api('delete', `/api/vendors/${v._id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('VENDOR_HAS_HISTORY');
    expect(await Vendor.findById(v._id)).not.toBeNull();
  });

  test('a supplier with no history can still be deleted', async () => {
    const v = await Vendor.create({ name: 'Nobody Ltd', userId: org.admin._id, dataScope: org.admin.dataScope });
    expect((await api('delete', `/api/vendors/${v._id}`)).status).toBe(200);
  });
});
