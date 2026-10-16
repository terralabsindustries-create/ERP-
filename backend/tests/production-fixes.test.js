/**
 * Fixes from the production audit: stock bookkeeping stays inside a business,
 * stock movements and purchase orders, costs and profit, discounts, business-wide
 * settings, secret redaction and input validation.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Inventory = require('../src/models/Inventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const Vendor = require('../src/models/Vendor');
const Settings = require('../src/models/Settings');
const Job = require('../src/models/Job');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a;
let b;
const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(token)).send(body),
  del: (url) => request(app).delete(url).set(auth(token))
});

const invoiceBody = (customerId, itemName, quantity) => ({
  customerId: String(customerId),
  dueDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
  items: [{ itemName, quantity, unitPrice: 100, gstRate: 18 }]
});

beforeAll(async () => {
  await connectTestDb('prodfixes');
  a = await createOrg('pa', { managerPermissions: ['Dashboard', 'Jobs', 'Customers', 'Invoicing', 'Inventory', 'Purchase Bills', 'Vendors', 'Settings', 'Cost & Profit', 'Discounts'] });
  b = await createOrg('pb');
});
afterAll(disconnectTestDb);

describe('stock bookkeeping stays inside the business', () => {
  test("an invoice never checks or deducts another business's item with the same name", async () => {
    const custA = await make.customer(a.admin);
    await make.stockItem(b.admin, { name: 'Maplitho 70gsm', quantity: 3 });
    const mine = await make.stockItem(a.admin, { name: 'Maplitho 70gsm', quantity: 50 });

    const res = await as(a.tokens.admin).post('/api/invoices', invoiceBody(custA._id, 'Maplitho 70gsm', 10));
    expect(res.status).toBe(201);
    expect((await Inventory.findById(mine._id)).quantity).toBe(40);
    expect((await Inventory.findOne({ name: 'Maplitho 70gsm', dataScope: b.dataScope })).quantity).toBe(3);
  });

  test('stock errors never reveal another business', async () => {
    const custA = await make.customer(a.admin);
    await make.stockItem(b.admin, { name: 'B Only Board', quantity: 1 });
    const res = await as(a.tokens.admin).post('/api/invoices', invoiceBody(custA._id, 'B Only Board', 5));
    expect(res.status).toBe(201); // not a stock item of this business: a plain line
    expect(JSON.stringify(res.body)).not.toMatch(/Available: 1/);
  });

  test('movement history only lists the business own movements', async () => {
    const res = await as(a.tokens.admin).get('/api/inventory/movements');
    expect(res.status).toBe(200);
    const names = res.body.data.movements.map((m) => m.itemName);
    expect(names).toContain('Maplitho 70gsm');
    const other = await as(b.tokens.admin).get('/api/inventory/movements');
    expect(other.body.data.movements).toHaveLength(0);
  });
});

describe('stock movements', () => {
  test('stock in and out are recorded; going below zero is refused', async () => {
    const item = await make.stockItem(a.admin, { name: 'Lamination film', quantity: 5, unit: 'rolls' });
    const api = as(a.tokens.admin);
    expect((await api.post(`/api/inventory/${item._id}/adjust`, { change: 10, type: 'purchase', reference: 'BILL-77' })).status).toBe(200);
    expect((await api.post(`/api/inventory/${item._id}/adjust`, { change: -3, type: 'damage' })).status).toBe(200);
    const tooMany = await api.post(`/api/inventory/${item._id}/adjust`, { change: -100 });
    expect(tooMany.status).toBe(400);
    expect((await Inventory.findById(item._id)).quantity).toBe(12);
    const moves = await InventoryMovement.find({ inventoryItem: item._id }).sort({ createdAt: 1 });
    expect(moves.map((m) => [m.movementType, m.previousQuantity, m.newQuantity])).toEqual([
      ['purchase', 5, 15],
      ['damage', 15, 12]
    ]);
    expect(moves[0].referenceNumber).toBe('BILL-77');
  });

  test('a stock count sets the quantity', async () => {
    const item = await make.stockItem(a.admin, { quantity: 9 });
    const res = await as(a.tokens.admin).post(`/api/inventory/${item._id}/adjust`, { quantity: 4, reason: 'Stock count' });
    expect(res.status).toBe(200);
    expect((await Inventory.findById(item._id)).quantity).toBe(4);
  });
});

describe('"Inventory: View Cost"', () => {
  test('is required to see purchase costs on Paper & stock', async () => {
    await make.stockItem(a.admin, { name: 'Costed paper', unitCost: 321 });
    await User.updateOne({ _id: a.staff1._id }, { permissions: ['Inventory', 'Inventory: View'] });
    const res = await as(a.tokens.staff1).get('/api/inventory');
    expect(res.status).toBe(200);
    expect(res.body.data.find((item) => item.name === 'Costed paper')).not.toHaveProperty('unitCost');
    await User.updateOne({ _id: a.staff1._id }, { permissions: ['Inventory', 'Inventory: View', 'Inventory: View Cost'] });
    const allowed = await as(a.tokens.staff1).get('/api/inventory');
    expect(allowed.body.data.find((item) => item.name === 'Costed paper').unitCost).toBe(321);
  });
});

describe('purchase orders', () => {
  let vendor;
  let paper;
  beforeAll(async () => {
    vendor = await Vendor.create({ name: 'PA Paper Mart', vendorType: 'Supplier', userId: a.admin._id, createdBy: a.admin._id, dataScope: a.dataScope });
    paper = await make.stockItem(a.admin, { name: 'PO paper', quantity: 0, unitCost: 250 });
  });

  test("a manager can order from the owner's supplier, and receiving adds the stock", async () => {
    const api = as(a.tokens.manager);
    const created = await api.post('/api/purchase-orders', { vendorId: String(vendor._id), send: true, items: [{ inventoryId: String(paper._id), quantity: 10, unitCost: 240 }] });
    expect(created.status).toBe(201);
    const po = created.body.data.purchaseOrder;
    expect(po.status).toBe('sent');
    expect(po.totalAmount).toBe(2400);

    const part = await api.post(`/api/purchase-orders/${po._id}/receive`, { lines: [{ inventoryId: String(paper._id), quantity: 4 }], reference: 'CH-1' });
    expect(part.status).toBe(200);
    expect(part.body.data.purchaseOrder.status).toBe('partial');
    const over = await api.post(`/api/purchase-orders/${po._id}/receive`, { lines: [{ inventoryId: String(paper._id), quantity: 7 }] });
    expect(over.status).toBe(400);
    const rest = await api.post(`/api/purchase-orders/${po._id}/receive`, { lines: [{ inventoryId: String(paper._id), quantity: 6 }] });
    expect(rest.body.data.purchaseOrder.status).toBe('completed');
    expect((await Inventory.findById(paper._id)).quantity).toBe(10);
    expect(await InventoryMovement.countDocuments({ inventoryItem: paper._id, referenceType: 'purchase_order' })).toBe(2);
  });

  test('numbers stay unique across businesses and lists stay separate', async () => {
    const bVendor = await Vendor.create({ name: 'PB Supplier', vendorType: 'Supplier', userId: b.admin._id, createdBy: b.admin._id, dataScope: b.dataScope });
    const bItem = await make.stockItem(b.admin, { name: 'PB ink' });
    const res = await as(b.tokens.admin).post('/api/purchase-orders', { vendorId: String(bVendor._id), items: [{ inventoryId: String(bItem._id), quantity: 1, unitCost: 10 }] });
    expect(res.status).toBe(201);
    const listB = await as(b.tokens.admin).get('/api/purchase-orders?status=all');
    expect(listB.body.data.purchaseOrders.map((p) => p.vendorName)).toEqual(['PB Supplier']);
    const listA = await as(a.tokens.admin).get('/api/purchase-orders?status=all');
    expect(listA.body.data.purchaseOrders.some((p) => p.vendorName === 'PB Supplier')).toBe(false);
  });

  test("another business's supplier or items are refused", async () => {
    const bVendor = await Vendor.findOne({ name: 'PB Supplier' });
    const res = await as(a.tokens.admin).post('/api/purchase-orders', { vendorId: String(bVendor._id), items: [{ inventoryId: String(paper._id), quantity: 1, unitCost: 1 }] });
    expect(res.status).toBe(404);
  });
});

describe('cost & profit', () => {
  test('job profit is revenue (excl. GST) minus recorded costs', async () => {
    const cust = await make.customer(a.admin);
    const job = await make.job(a.admin, cust, { title: 'PA Brochure run' });
    await make.invoice(a.admin, cust, { jobId: job._id, lines: [{ amount: 10000, rate: 18 }], dataScope: a.dataScope });
    const api = as(a.tokens.manager);
    const c1 = await api.post('/api/costs', { jobId: String(job._id), category: 'Materials', description: 'Art paper', amount: 3000 });
    expect(c1.status).toBe(201);
    expect((await api.post('/api/costs', { jobId: String(job._id), category: 'Labor', description: 'Binding', amount: 1500 })).status).toBe(201);
    expect((await Job.findById(job._id)).actualCost).toBe(4500);

    const res = await api.get('/api/costs/jobs');
    const row = res.body.data.jobs.find((j) => j.title === 'PA Brochure run');
    expect(row.revenue).toBe(10000);
    expect(row.cost).toBe(4500);
    expect(row.profit).toBe(5500);
    expect(Math.round(row.margin)).toBe(55);

    await api.del(`/api/costs/${c1.body.data.cost._id}`);
    expect((await Job.findById(job._id)).actualCost).toBe(1500);
  });

  test('costs cannot be added to another business job and are invisible to it', async () => {
    const bCust = await make.customer(b.admin);
    const bJob = await make.job(b.admin, bCust);
    const res = await as(a.tokens.admin).post('/api/costs', { jobId: String(bJob._id), category: 'Other', description: 'x', amount: 10 });
    expect(res.status).toBe(404);
    const list = await as(b.tokens.admin).get('/api/costs');
    expect(list.body.data.costs).toHaveLength(0);
  });

  test('invalid input is a 400', async () => {
    const res = await as(a.tokens.admin).post('/api/costs', { category: 'Nope', amount: -1 });
    expect(res.status).toBe(400);
  });
});

describe('discounts', () => {
  test('the best offer wins: customer rate vs. rules, with caps, minimums and chosen customers', async () => {
    const api = as(a.tokens.admin);
    const vip = await make.customer(a.admin, { name: 'PA VIP' });
    const other = await make.customer(a.admin, { name: 'PA Other' });
    expect((await api.post('/api/discounts/rules', { name: 'Big order 10%', type: 'percentage', value: 10, minimumAmount: 5000, maximumAmount: 800 })).status).toBe(201);
    expect((await api.post('/api/discounts/rules', { name: 'VIP 15%', type: 'percentage', value: 15, customerType: 'specific', customerIds: [String(vip._id)] })).status).toBe(201);
    expect((await api.post('/api/discounts/customer-pricing', { customerId: String(other._id), discountPercentage: 5 })).status).toBe(201);

    const small = await api.post('/api/discounts/calculate', { customerId: String(other._id), amount: 1000 });
    expect(small.body.data.discountAmount).toBe(50); // only the 5% customer rate applies
    const big = await api.post('/api/discounts/calculate', { customerId: String(other._id), amount: 20000 });
    expect(big.body.data.discountAmount).toBe(1000); // 5% rate beats the capped 10% rule (₹800)
    const vipCalc = await api.post('/api/discounts/calculate', { customerId: String(vip._id), amount: 2000 });
    expect(vipCalc.body.data.discountAmount).toBe(300);
    expect(vipCalc.body.data.appliedRule.name).toBe('VIP 15%');
  });

  test("another business's customer cannot be given a rate", async () => {
    const bCust = await make.customer(b.admin);
    const res = await as(a.tokens.admin).post('/api/discounts/customer-pricing', { customerId: String(bCust._id), discountPercentage: 5 });
    expect(res.status).toBe(404);
  });

  test('a percentage over 100 is refused', async () => {
    const res = await as(a.tokens.admin).post('/api/discounts/rules', { name: 'Too much', type: 'percentage', value: 150 });
    expect(res.status).toBe(400);
  });
});

describe('business settings', () => {
  beforeAll(async () => {
    await Settings.create({ userId: a.admin._id, companyName: 'PA Printers Pvt Ltd', gstNumber: '32ABCDE1234F1Z5', whatsappIntegration: { enabled: true, wabaId: 'W1', phoneNumberId: 'P1', accessToken: 'SECRET-TOKEN' } });
  });

  test("everyone in the business reads the owner's settings, without secrets", async () => {
    for (const token of [a.tokens.admin, a.tokens.manager, a.tokens.staff1]) {
      const res = await as(token).get('/api/settings');
      expect(res.status).toBe(200);
      expect(res.body.data.settings.companyName).toBe('PA Printers Pvt Ltd');
      expect(JSON.stringify(res.body)).not.toMatch(/SECRET-TOKEN/);
      expect(res.body.data.settings.whatsappIntegration.hasAccessToken).toBe(true);
    }
  });

  test('saving keeps the saved WhatsApp token when none is sent', async () => {
    const res = await as(a.tokens.manager).post('/api/whatsapp/settings', { enabled: true, wabaId: 'W2', phoneNumberId: 'P2', accessToken: '' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET-TOKEN/);
    const owner = await Settings.findOne({ userId: a.admin._id });
    expect(owner.whatsappIntegration.accessToken).toBe('SECRET-TOKEN');
    expect(owner.whatsappIntegration.wabaId).toBe('W2');
  });
});

describe('input checks', () => {
  test('changing a password with an empty form is a 400, not a 500', async () => {
    const res = await as(a.tokens.staff2).put('/api/auth/password', {});
    expect(res.status).toBe(400);
  });

  test('activity log search with regex characters works', async () => {
    const res = await as(a.tokens.admin).get('/api/activity-log?search=' + encodeURIComponent('(['));
    expect(res.status).toBe(200);
  });

  test('a bad id in the activity log is a 404', async () => {
    const res = await as(a.tokens.admin).get('/api/activity-log/not-an-id');
    expect(res.status).toBe(404);
  });

  test('a customer opens by id', async () => {
    const cust = await make.customer(a.admin);
    const res = await as(a.tokens.admin).get(`/api/customers/${cust._id}`);
    expect(res.status).toBe(200);
  });
});
