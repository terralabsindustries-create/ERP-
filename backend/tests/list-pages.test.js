/**
 * The figures behind the redesigned list pages: invoice view counts, customer
 * and supplier totals, purchase bill scope and the task date filters. Each one
 * must respect the same visibility rules as the lists themselves.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');
const PurchaseBill = require('../src/models/PurchaseBill');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

const DAY = 864e5;
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

let a;
let cust;

beforeAll(async () => {
  await connectTestDb('listpages');
  a = await createOrg('lp', { staffPermissions: ['Customers', 'Staff & Tasks', 'Purchase Bills'] });
  cust = await make.customer(a.admin, { name: 'LP Customer' });
  // Issued and unpaid, due yesterday: overdue.
  await make.invoice(a.admin, cust, { dueDate: new Date(startOfToday().getTime() - DAY), balanceAmount: 1180, paymentStatus: 'pending' });
  // Issued and unpaid, due later today: not overdue yet.
  await make.invoice(a.admin, cust, { dueDate: new Date(startOfToday().getTime() + DAY - 60e3), balanceAmount: 1180, paymentStatus: 'pending' });
  // A draft is never owed.
  await make.invoice(a.admin, cust, { status: 'draft', balanceAmount: 1180, paymentStatus: 'pending' });
  // A No GST bill, only for logins allowed to see them.
  await make.invoice(a.admin, cust, { noGst: true, lines: [{ amount: 5000, rate: 0 }], balanceAmount: 5000, paymentStatus: 'pending' });
});
afterAll(disconnectTestDb);

const get = (token, url) => request(app).get(url).set(auth(token));

describe('invoice view counts', () => {
  test('owner counts every invoice, including No GST', async () => {
    const res = await get(a.tokens.admin, '/api/invoices/stats/views');
    expect(res.status).toBe(200);
    const s = res.body.data.stats;
    expect(s.all).toBe(4);
    expect(s.draft).toBe(1);
    expect(s.unpaid).toBe(3);
    expect(s.invoiced).toBe(1180 * 2 + 5000);
  });

  test('a due date is overdue only once its day has ended', async () => {
    const { stats } = (await get(a.tokens.admin, '/api/invoices/stats/views')).body.data;
    expect(stats.overdue).toBe(1);
    expect(stats.overdueAmount).toBe(1180);
    const list = await get(a.tokens.admin, '/api/invoices?view=overdue');
    expect(list.body.data.invoices).toHaveLength(1);
  });

  test('a login without "Invoicing (View No GST)" never sees No GST totals', async () => {
    const res = await get(a.tokens.manager, '/api/invoices/stats/views');
    expect(res.status).toBe(200);
    expect(res.body.data.stats.all).toBe(3);
    expect(res.body.data.stats.invoiced).toBe(1180 * 2);
    // One invoice list now; asking for the old No GST filter changes nothing.
    const asked = await get(a.tokens.manager, '/api/invoices/stats/views?noGst=true');
    expect(asked.body.data.stats.all).toBe(3);
    const list = await get(a.tokens.manager, '/api/invoices?noGst=true');
    expect(list.body.data.invoices).toHaveLength(3);
    const summary = await get(a.tokens.manager, '/api/invoices/stats/summary');
    expect(JSON.stringify(summary.body)).not.toMatch(/7360|5000/);
  });
});

describe('customer billing totals', () => {
  test('come with the list for logins that can see invoices, without No GST bills', async () => {
    const res = await get(a.tokens.manager, '/api/customers?limit=50');
    expect(res.status).toBe(200);
    const c = res.body.data.customers.find((x) => x.name === 'LP Customer');
    expect(c.billing.invoices).toBe(2);
    expect(c.billing.invoiced).toBe(1180 * 2);
  });

  test('include No GST bills for the owner', async () => {
    const res = await get(a.tokens.admin, '/api/customers?limit=50');
    const c = res.body.data.customers.find((x) => x.name === 'LP Customer');
    expect(c.billing.invoiced).toBe(1180 * 2 + 5000);
  });

  test('are left out for logins without Invoicing', async () => {
    await User.updateOne({ _id: a.staff1._id }, { canViewAllData: true });
    const res = await get(a.tokens.staff1, '/api/customers?limit=50');
    expect(res.status).toBe(200);
    const c = res.body.data.customers.find((x) => x.name === 'LP Customer');
    expect(c.billing).toBeNull();
    await User.updateOne({ _id: a.staff1._id }, { canViewAllData: false });
  });
});

describe('purchase bills', () => {
  let vendor;
  beforeAll(async () => {
    const owned = (u) => ({ userId: u._id, createdBy: u._id, dataScope: u.dataScope });
    vendor = await Vendor.create({ name: 'LP Paper Mart', vendorType: 'Supplier', ...owned(a.admin) });
    const bill = (u, billNumber, extra) =>
      PurchaseBill.create({
        billNumber,
        vendorId: vendor._id,
        vendorName: vendor.name,
        billDate: new Date(),
        items: [{ description: 'Maplitho 70gsm', rate: 1000, quantity: 1, gstRate: 12 }],
        ...owned(u),
        ...extra
      });
    await bill(a.admin, 'LP-1', { dueDate: new Date(startOfToday().getTime() - 2 * DAY) });
    await bill(a.staff1, 'LP-2', { dueDate: new Date(Date.now() + 5 * DAY) });
  });

  test('a view-all login sees every bill in the business; staff see their own', async () => {
    await User.updateOne({ _id: a.manager._id }, { $addToSet: { permissions: 'Purchase Bills' } });
    const mgr = await get(a.tokens.manager, '/api/purchase-bills?limit=50');
    expect(mgr.status).toBe(200);
    expect(mgr.body.data.bills.map((b) => b.billNumber).sort()).toEqual(['LP-1', 'LP-2']);
    const staff = await get(a.tokens.staff1, '/api/purchase-bills?limit=50');
    expect(staff.body.data.bills.map((b) => b.billNumber)).toEqual(['LP-2']);
  });

  test('overdue filter and counts', async () => {
    const res = await get(a.tokens.manager, '/api/purchase-bills?paymentStatus=overdue');
    expect(res.body.data.bills.map((b) => b.billNumber)).toEqual(['LP-1']);
    const stats = await get(a.tokens.manager, '/api/purchase-bills/stats/summary');
    expect(stats.status).toBe(200);
    expect(stats.body.data.stats.counts.overdue).toBe(1);
  });

  test('supplier totals come with the supplier list', async () => {
    await User.updateOne({ _id: a.manager._id }, { $addToSet: { permissions: 'Suppliers' } });
    const res = await get(a.tokens.manager, '/api/vendors?limit=50');
    expect(res.status).toBe(200);
    const v = res.body.data.vendors.find((x) => x.name === 'LP Paper Mart');
    expect(v.purchases.bills).toBe(2);
  });
});

describe('task date filters', () => {
  beforeAll(async () => {
    await make.task(a.admin, a.staff1, { title: 'LP due yesterday', dueDate: new Date(startOfToday().getTime() - DAY + 3600e3), status: 'pending' });
    await make.task(a.admin, a.staff1, { title: 'LP due later today', dueDate: new Date(startOfToday().getTime() + DAY - 60e3), status: 'pending' });
    await make.task(a.admin, a.staff1, { title: 'LP due next month', dueDate: new Date(Date.now() + 40 * DAY), status: 'pending' });
  });

  test('overdue means the due day has ended', async () => {
    const res = await get(a.tokens.admin, '/api/tasks?overdue=true&limit=100');
    const titles = res.body.data.map((t) => t.title);
    expect(titles).toContain('LP due yesterday');
    expect(titles).not.toContain('LP due later today');
    const stats = await get(a.tokens.admin, '/api/tasks/stats');
    expect(stats.body.data.overdueTasks).toBe(1);
  });

  test('dueFrom/dueTo return the tasks due inside a window', async () => {
    const from = startOfToday();
    const to = new Date(from.getTime() + 7 * DAY);
    const res = await get(a.tokens.admin, `/api/tasks?dueFrom=${from.toISOString()}&dueTo=${to.toISOString()}&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((t) => t.title)).toEqual(['LP due later today']);
  });

  test('a bad date is rejected', async () => {
    const res = await get(a.tokens.admin, '/api/tasks?dueFrom=yesterday');
    expect(res.status).toBe(400);
  });
});
