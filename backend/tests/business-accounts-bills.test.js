const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Vendor = require('../src/models/Vendor');
const AccountTransaction = require('../src/models/AccountTransaction');
const PurchaseBill = require('../src/models/PurchaseBill');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let business;
let other;
const entry = (amount, type = 'income') => ({
  transactionType: type, category: 'General', amount, description: `${type} ${amount}`,
  paymentMethod: 'cash', accountType: 'cash', accountName: 'Till'
});
const as = (token, method, path) => request(app)[method](path).set(auth(token));

beforeAll(async () => {
  await connectTestDb('business_accounts_bills');
  business = await createOrg('sharedbooks');
  other = await createOrg('separatebooks');
  await User.updateMany({ _id: { $in: [business.staff1._id, business.staff2._id] } }, {
    $set: { permissions: ['Accounts', 'Accounts: View', 'Accounts: Create & Edit', 'Accounts: Delete', 'Purchase Bills', 'Purchase Bills: Create & Edit'] }
  });
});
afterAll(disconnectTestDb);

test('staff entries share balances and can be corrected without affecting another business', async () => {
  const own = await as(business.tokens.staff1, 'post', '/api/accounts/transactions').send(entry(100));
  expect(own.status).toBe(201);
  const second = await as(business.tokens.staff2, 'post', '/api/accounts/transactions').send(entry(40));
  expect(second.status).toBe(201);
  expect(second.body.data.transaction.transactionNumber).not.toBe(own.body.data.transaction.transactionNumber);
  await as(other.tokens.admin, 'post', '/api/accounts/transactions').send(entry(900));

  const balances = await as(business.tokens.admin, 'get', '/api/accounts/balances');
  expect(balances.body.data.currentBalances.cashBalance).toBe(140);
  const listed = await as(business.tokens.staff1, 'get', '/api/accounts/transactions');
  expect(listed.body.data.transactions).toHaveLength(2);
  const foreignList = await as(other.tokens.admin, 'get', '/api/accounts/transactions');
  expect(foreignList.body.data.transactions).toHaveLength(1);

  const changed = await as(business.tokens.staff1, 'put', `/api/accounts/transactions/${second.body.data.transaction._id}`).send(entry(30));
  expect(changed.status).toBe(200);
  expect((await as(business.tokens.staff2, 'get', '/api/accounts/balances')).body.data.currentBalances.cashBalance).toBe(130);
  expect((await as(other.tokens.admin, 'delete', `/api/accounts/transactions/${own.body.data.transaction._id}`)).status).toBe(404);
  expect((await as(business.tokens.admin, 'delete', `/api/accounts/transactions/${own.body.data.transaction._id}`)).status).toBe(200);
  expect((await as(business.tokens.admin, 'get', '/api/accounts/balances')).body.data.currentBalances.cashBalance).toBe(30);
  expect(await AccountTransaction.countDocuments({ userId: other.admin._id })).toBe(1);
});

test('simultaneous account entries receive distinct numbers and update the shared ledger', async () => {
  const created = await Promise.all([
    as(business.tokens.staff1, 'post', '/api/accounts/transactions').send(entry(5)),
    as(business.tokens.staff2, 'post', '/api/accounts/transactions').send(entry(8))
  ]);
  expect(created.map((result) => result.status)).toEqual([201, 201]);
  expect(new Set(created.map((result) => result.body.data.transaction.transactionNumber)).size).toBe(2);
  const admin = await as(business.tokens.admin, 'get', '/api/accounts/balances');
  expect(admin.body.data.currentBalances.cashBalance).toBe(43);
  const dashboard = await as(business.tokens.admin, 'get', '/api/dashboard/stats');
  expect(dashboard.status).toBe(200);
  expect(dashboard.body.stats.cashBalance).toBe(43);
});

test('purchase bill numbers advance across staff within a business', async () => {
  const vendor = await Vendor.create({ name: 'Shared Paper', vendorType: 'Supplier', userId: business.admin._id });
  const body = { vendorId: vendor.id, items: [{ description: 'Paper', rate: 100, quantity: 1 }] };
  const first = await as(business.tokens.staff1, 'post', '/api/purchase-bills').send(body);
  const second = await as(business.tokens.staff2, 'post', '/api/purchase-bills').send(body);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(first.body.data.bill.billNumber).toMatch(/^BILL-\d{6}-0001$/);
  expect(second.body.data.bill.billNumber).toMatch(/^BILL-\d{6}-0002$/);
  expect(String((await PurchaseBill.findById(second.body.data.bill._id)).businessId)).toBe(String(business.admin._id));
  const simultaneous = await Promise.all([
    as(business.tokens.staff1, 'post', '/api/purchase-bills').send(body),
    as(business.tokens.staff2, 'post', '/api/purchase-bills').send(body)
  ]);
  expect(simultaneous.map((result) => result.status)).toEqual([201, 201]);
  expect(simultaneous.map((result) => result.body.data.bill.billNumber).sort()).toEqual([
    first.body.data.bill.billNumber.replace(/0001$/, '0003'),
    first.body.data.bill.billNumber.replace(/0001$/, '0004')
  ]);
  const foreignVendor = await Vendor.create({ name: 'Other Paper', vendorType: 'Supplier', userId: other.admin._id });
  const foreign = await as(other.tokens.admin, 'post', '/api/purchase-bills').send({ ...body, vendorId: foreignVendor.id });
  expect(foreign.status).toBe(201);
  expect(foreign.body.data.bill.billNumber).toBe(first.body.data.bill.billNumber);
});
