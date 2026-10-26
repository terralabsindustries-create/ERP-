/**
 * Customer types and duplicate names, HSN codes and notes on lines, no zero
 * values where a positive one is needed, purchase bills generated from
 * approved purchase orders, the accountant's access and the owner-only
 * profit & loss report.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');
const Employee = require('../src/models/Employee');
const AccessRole = require('../src/models/AccessRole');
const PurchaseOrder = require('../src/models/PurchaseOrder');
const { generateToken } = require('../src/middleware/auth');
const { ROLE_PRESETS, PRESET_VERSION } = require('../src/config/rolePresets');
const { upgradePresetRoles } = require('../src/utils/upgradePresetRoles');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;
const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  delete: (url) => request(app).delete(url).set(auth(token))
});
const admin = () => as(org.tokens.admin);

/** A login of this business with exactly these permissions. */
async function loginWith(role, permissions) {
  const user = await User.create({
    email: `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
    password: 'Passw0rd!',
    fullName: `Test ${role}`,
    role,
    dataScope: org.dataScope,
    status: 'active',
    isActive: true,
    permissions,
    canViewAllData: role !== 'staff'
  });
  return { user, api: as(generateToken(user._id)) };
}

beforeAll(async () => {
  await connectTestDb('feedback');
  org = await createOrg('fb');
  cust = await make.customer(org.admin, { name: 'Sree Graphics' });
});
afterAll(disconnectTestDb);

describe('customers', () => {
  test('can be added as an agency or a walk-in customer', async () => {
    const agency = await admin().post('/api/customers', { name: 'Brandline Ads', customerType: 'Agency' });
    expect(agency.status).toBe(201);
    expect(agency.body.data.customer.customerType).toBe('Agency');
    const walkIn = await admin().post('/api/customers', { name: 'Counter customer', customerType: 'Walk-in' });
    expect(walkIn.body.data.customer.customerType).toBe('Walk-in');
    expect((await admin().post('/api/customers', { name: 'X', customerType: 'Wholesale' })).status).toBe(400);
  });

  test('two customers may share a name', async () => {
    const first = await admin().post('/api/customers', { name: 'Rahul', phone: '9811111111' });
    const second = await admin().post('/api/customers', { name: 'Rahul', phone: '9822222222' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.customer._id).not.toBe(first.body.data.customer._id);
  });
});

describe('invoice and quotation lines', () => {
  const line = { itemName: 'Letterheads', description: 'Matt finish', quantity: 500, unit: 'pieces', unitPrice: 3, hsnCode: '4817' };

  test('keep their note and HSN code', async () => {
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [line] });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.items[0]).toMatchObject({ description: 'Matt finish', hsnCode: '4817', totalAmount: 1500 });
  });

  test('refuse a zero rate, and an HSN code that is not 4 to 8 digits', async () => {
    const zero = await admin().post('/api/invoices', { customerId: String(cust._id), items: [{ ...line, unitPrice: 0 }] });
    expect(zero.status).toBe(400);
    expect((await admin().post('/api/invoices', { customerId: String(cust._id), items: [{ ...line, hsnCode: '12' }] })).status).toBe(400);
    const quote = await admin().post('/api/quotations', { customer_id: String(cust._id), items: [{ item_name: 'Cards', quantity: 100, unit_price: 0 }] });
    expect(quote.status).toBe(400);
  });

  test("a quotation's HSN codes carry onto the invoice it becomes", async () => {
    const q = await admin().post('/api/quotations', { customer_id: String(cust._id), items: [{ item_name: 'Cards', quantity: 100, unit_price: 2, hsn_code: '4911' }] });
    expect(q.status).toBe(201);
    expect(q.body.data.quotation.items[0].hsn_code).toBe('4911');
    const conv = await admin().post(`/api/quotations/${q.body.data.quotation._id}/convert-to-invoice`, {});
    expect(conv.status).toBe(201);
    expect(conv.body.data.invoice.items[0].hsnCode).toBe('4911');
  });

  test('invoice availability counts repeated lines for the same stock item together', async () => {
    await make.stockItem(org.admin, { name: 'Repeat Stock Check Paper', quantity: 10 });
    const repeated = { itemName: 'Repeat Stock Check Paper', quantity: 6, unit: 'pieces', unitPrice: 2 };
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [repeated, repeated] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Insufficient stock/);
  });
});

describe('job tickets', () => {
  const base = () => ({ title: 'Brochure', customerId: String(cust._id) });
  const item = { itemName: 'Art paper 170 GSM', quantity: 2, unitPrice: 40, itemType: 'Numbers', unit: 'reams', hsnCode: '4810' };

  test('keep a note on each item', async () => {
    const res = await admin().post('/api/jobs', { ...base(), items: [{ ...item, description: 'Cut to A4' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.job.items[0]).toMatchObject({ description: 'Cut to A4', hsnCode: '4810' });
  });

  test('refuse items worth nothing', async () => {
    expect((await admin().post('/api/jobs', { ...base(), items: [{ ...item, unitPrice: 0 }] })).status).toBe(400);
    expect((await admin().post('/api/jobs', { ...base(), items: [{ ...item, quantity: 0 }] })).status).toBe(400);
    expect((await admin().post('/api/jobs', { ...base(), items: [{ ...item, itemType: 'Square Feet', unit: 'sqft', length: 6 }] })).status).toBe(400);
    expect((await admin().post('/api/jobs', { ...base(), designCharge: { amount: 0, gstRate: 18 } })).status).toBe(400);
    // A job without items is still fine.
    expect((await admin().post('/api/jobs', base())).status).toBe(201);
  });
});

describe('zero amounts elsewhere', () => {
  test('an account entry of 0 is refused', async () => {
    const res = await admin().post('/api/accounts/transactions', {
      transactionType: 'expense', category: 'Rent', amount: 0, description: 'Rent', paymentMethod: 'cash', accountType: 'cash', accountName: 'Cash'
    });
    expect(res.status).toBe(400);
  });

  test('payroll leaves out employees with no salary instead of making ₹0 payslips', async () => {
    await Employee.create({ name: 'No Salary Yet', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
    const only = await admin().post('/api/hr/payroll/generate', { month: 3, year: 2026 });
    expect(only.status).toBe(400);
    expect(only.body.message).toMatch(/No Salary Yet/);

    await Employee.create({ name: 'Press Operator', salary: { basic: 20000 }, userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
    const res = await admin().post('/api/hr/payroll/generate', { month: 3, year: 2026 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ generated: 1, noSalary: ['No Salary Yet'] });
  });
});

describe('purchase bills from approved purchase orders', () => {
  let vendor;
  let paper;
  const order = (send, unitCost = 250) =>
    admin().post('/api/purchase-orders', { vendorId: String(vendor._id), send, terms: 'Net 15', items: [{ inventoryId: String(paper._id), quantity: 10, unitCost }] });

  beforeAll(async () => {
    vendor = await Vendor.create({ name: 'Kerala Paper House', vendorType: 'Supplier', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope });
    paper = await make.stockItem(org.admin, { name: 'Maplitho 70 GSM', hsnCode: '4802', gstRate: 12 });
  });

  test('a purchase order needs a unit cost above 0', async () => {
    expect((await order(true, 0)).status).toBe(400);
  });

  test('an approved order is billed in one click, once; a draft is not', async () => {
    const draft = (await order(false)).body.data.purchaseOrder;
    const placed = (await order(true)).body.data.purchaseOrder;
    expect(placed.approvedAt).toBeTruthy();
    expect((await admin().post(`/api/purchase-orders/${draft._id}/receive`, { lines: [{ inventoryId: String(paper._id), quantity: 1 }] })).status).toBe(409);

    const waiting = await admin().get('/api/purchase-bills/from-orders');
    expect(waiting.body.data.orders.map((o) => o._id)).toEqual([placed._id]);

    const res = await admin().post('/api/purchase-bills/generate', { purchaseOrderIds: [placed._id] });
    expect(res.status).toBe(201);
    const [bill] = res.body.data.bills;
    expect(bill).toMatchObject({ vendorName: 'Kerala Paper House', purchaseOrderNumber: placed.poNumber, taxableAmount: 2500, totalAmount: 2800 });
    expect(bill.items[0]).toMatchObject({ description: 'Maplitho 70 GSM', hsnCode: '4802', rate: 250, quantity: 10, gstRate: 12 });
    expect(Math.round((new Date(bill.dueDate) - new Date(bill.billDate)) / 864e5)).toBe(15);
    expect((await PurchaseOrder.findById(placed._id)).purchaseBillNumber).toBe(bill.billNumber);
    expect((await admin().put(`/api/purchase-orders/${placed._id}`, { vendorId: String(vendor._id), items: [{ inventoryId: String(paper._id), quantity: 10, unitCost: 300 }] })).status).toBe(409);

    expect((await admin().post('/api/purchase-bills/generate', { purchaseOrderIds: [placed._id] })).status).toBe(400);
    expect((await admin().post('/api/purchase-bills/generate', { purchaseOrderIds: [draft._id] })).status).toBe(400);

    // Deleting the bill lets the order be billed again.
    expect((await admin().delete(`/api/purchase-bills/${bill._id}`)).status).toBe(200);
    expect((await PurchaseOrder.findById(placed._id)).purchaseBillId).toBeUndefined();
  });

  test('without a list, every approved order waiting for a bill is billed', async () => {
    await order(true);
    const res = await admin().post('/api/purchase-bills/generate', {});
    expect(res.status).toBe(201);
    expect(res.body.data.generated).toBe(2);
    expect((await admin().get('/api/purchase-bills/from-orders')).body.data.count).toBe(0);
  });

  test('a bill of 0 is refused', async () => {
    const res = await admin().post('/api/purchase-bills', { vendorId: String(vendor._id), items: [{ description: 'Ink', rate: 0, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  test('only bill editors can list orders waiting for generation', async () => {
    const { api } = await loginWith('staff', ['Dashboard', 'Purchase Bills', 'Purchase Bills: View']);
    expect((await api.get('/api/purchase-bills/from-orders')).status).toBe(403);
  });
});

describe("the accountant's access", () => {
  test('the starter Accountant role covers jobs, quotations, billing, attendance and WhatsApp, not profit', () => {
    const accountant = ROLE_PRESETS.find((p) => p.name === 'Accountant');
    for (const module of ['Jobs', 'Quotations', 'Invoicing', 'Payments', 'Payment Reminders', 'Accounts', 'Reports', 'Attendance', 'WhatsApp']) {
      expect(accountant.permissions).toContain(module);
    }
    expect(accountant.permissions).not.toContain('Cost & Profit');
  });

  test('an Accountant role from the earlier presets is upgraded once, with everyone who holds it', async () => {
    const old = await AccessRole.create({
      name: 'Accountant',
      baseRole: 'accountant',
      preset: true,
      canViewAllData: true,
      permissions: ['Dashboard', 'Invoicing', 'Invoicing: View', 'Accounts', 'Accounts: View', 'Cost & Profit', 'Cost & Profit: View', 'Delivery'],
      dataScope: org.dataScope,
      userId: org.admin._id
    });
    const { user } = await loginWith('accountant', old.permissions);
    await User.updateOne({ _id: user._id }, { accessRole: old._id });

    await upgradePresetRoles();
    const role = await AccessRole.findById(old._id);
    expect(role.presetVersion).toBe(PRESET_VERSION);
    expect(role.permissions).toEqual(expect.arrayContaining(['Jobs', 'Quotations', 'Attendance', 'WhatsApp', 'Delivery']));
    expect(role.permissions).not.toContain('Cost & Profit');
    expect((await User.findById(user._id)).permissions).toEqual(role.permissions);

    // Taken off again by the owner, it stays off.
    role.permissions = role.permissions.filter((p) => !p.startsWith('WhatsApp'));
    await role.save();
    await upgradePresetRoles();
    expect((await AccessRole.findById(old._id)).permissions).not.toContain('WhatsApp');
  });

  test('Attendance alone opens the register; marking needs Mark Attendance', async () => {
    const viewer = await loginWith('accountant', ['Dashboard', 'Attendance', 'Attendance: View']);
    expect((await viewer.api.get('/api/hr/attendance')).status).toBe(200);
    expect((await viewer.api.get('/api/hr/employees')).status).toBe(200);
    expect((await viewer.api.post('/api/hr/attendance/bulk', { date: '2026-03-02', records: [] })).status).toBe(403);
    const marker = await loginWith('accountant', ['Dashboard', 'Attendance', 'Attendance: View', 'Attendance: Mark Attendance']);
    expect((await marker.api.post('/api/hr/attendance/bulk', { date: '2026-03-02', records: [] })).status).not.toBe(403);
  });

  test('only the owner sees the profit & loss report', async () => {
    const { api } = await loginWith('accountant', ['Dashboard', 'Accounts', 'Accounts: View']);
    expect((await api.get('/api/accounts/reports/summary?period=month')).status).toBe(403);
    expect((await api.get('/api/accounts/transactions')).status).toBe(200);
    expect((await admin().get('/api/accounts/reports/summary?period=month')).status).toBe(200);
  });
});
