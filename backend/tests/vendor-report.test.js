const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');
const PurchaseBill = require('../src/models/PurchaseBill');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let paperCo;
let month;
let n = 0;

const vendor = (user, name) => Vendor.create({ name, vendorType: 'Supplier', userId: user._id, dataScope: user.dataScope });
// `save()` runs the bill's own GST and balance maths.
const bill = (user, v, { amount, rate = 0, paidAmount = 0, status = 'recorded', billDate = new Date() }) =>
  new PurchaseBill({
    billNumber: `BILL-T-${++n}`,
    vendorId: v._id,
    vendorName: v.name,
    billDate,
    items: [{ description: 'Paper', rate: amount, quantity: 1, gstRate: rate }],
    paidAmount,
    status,
    userId: user._id
  }).save();

beforeAll(async () => {
  await connectTestDb('vendor_report');
  org = await createOrg('vendor_report', {
    managerPermissions: ['Dashboard', 'Reports', 'Purchase Bills']
  });
  const other = await createOrg('vendor_report_other');
  paperCo = await vendor(org.admin, 'Paper Co');
  const inkCo = await vendor(org.admin, 'Ink Co');
  const foreign = await vendor(other.admin, 'Foreign Co');
  month = new Date().toISOString().slice(0, 7);
  const lastYear = new Date();
  lastYear.setFullYear(lastYear.getFullYear() - 1);

  await bill(org.admin, paperCo, { amount: 1000, rate: 18, paidAmount: 500 });
  await bill(org.manager, paperCo, { amount: 2000 });
  await bill(org.admin, inkCo, { amount: 300 });
  await bill(org.admin, paperCo, { amount: 9999, status: 'draft' });
  await bill(org.admin, inkCo, { amount: 9999, status: 'cancelled' });
  await bill(org.admin, inkCo, { amount: 9999, billDate: lastYear });
  await bill(other.admin, foreign, { amount: 9999 });
});

afterAll(disconnectTestDb);

test('vendor totals cover recorded bills of the month and expose their bill detail', async () => {
  const response = await request(app).get(`/api/reports/vendors?month=${month}`).set(auth(org.tokens.admin));
  expect(response.status).toBe(200);
  const report = response.body.data;
  expect(report.vendors).toHaveLength(2);
  expect(report.totals).toEqual({
    billCount: 3, draftCount: 1, taxableAmount: 3300, gstAmount: 180, totalBilled: 3480, paidToDate: 500, outstanding: 2980
  });
  expect(report.vendors[0]).toMatchObject({ vendorId: String(paperCo._id), vendorName: 'Paper Co', billCount: 2, draftCount: 1, totalBilled: 3180, outstanding: 2680 });

  const detail = await request(app).get(`/api/reports/vendors/${paperCo._id}/bills?month=${month}`).set(auth(org.tokens.admin));
  expect(detail.status).toBe(200);
  expect(detail.body.data.pagination.total).toBe(3);
  expect(detail.body.data.bills.map((b) => b.status).sort()).toEqual(['draft', 'recorded', 'recorded']);
});

test('vendor report follows purchase bill visibility and permissions', async () => {
  await User.updateOne({ _id: org.manager._id }, { canViewAllData: false });
  const response = await request(app).get(`/api/reports/vendors?month=${month}`).set(auth(org.tokens.manager));
  expect(response.status).toBe(200);
  expect(response.body.data.totals).toMatchObject({ billCount: 1, totalBilled: 2000 });

  await User.updateOne({ _id: org.manager._id }, { permissions: ['Dashboard', 'Reports'] });
  const denied = await request(app).get(`/api/reports/vendors?month=${month}`).set(auth(org.tokens.manager));
  expect(denied.status).toBe(403);
});
