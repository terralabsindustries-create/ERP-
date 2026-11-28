/**
 * GET /api/payment-accounts/collections: the list behind the dashboard's
 * "Payment collection" figures — same receipts, same India days, same total —
 * with filters for account, account type, method and search, a CSV export,
 * business isolation and the Accounts permission.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const AccountTransaction = require('../src/models/AccountTransaction');
const PaymentAccount = require('../src/models/PaymentAccount');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let customer;
const acc = {};
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const get = (url, token = org.tokens.admin) => request(app).get(url).set(auth(token));
const pay = (body, token = org.tokens.admin, cust = customer) => request(app).post('/api/payments').set(auth(token)).send({ customerId: String(cust._id), status: 'completed', ...body });
const list = async (qs = '') => {
  const res = await get(`/api/payment-accounts/collections?from=${today()}${qs}`);
  expect(res.status).toBe(200);
  return res.body.data;
};

beforeAll(async () => {
  await connectTestDb('payment_collections');
  await AccountTransaction.syncIndexes();
  await PaymentAccount.syncIndexes();
  org = await createOrg('pcol');
  other = await createOrg('pcolx');
  customer = await make.customer(org.admin, { name: 'Lotus Publications' });
  const add = async (body, token = org.tokens.admin) => (await request(app).post('/api/payment-accounts').set(auth(token)).send(body)).body.data.account;
  acc.cash = await add({ kind: 'cash', nickname: 'Cash' });
  acc.paytm = await add({ kind: 'wallet', nickname: 'Paytm', provider: 'Paytm' });
  acc.bank = await add({ kind: 'bank', nickname: 'HDFC Current' });
  expect((await pay({ amount: 500, paymentMethod: 'cash', paymentAccountId: acc.cash._id })).status).toBe(201);
  expect((await pay({ amount: 1200, paymentMethod: 'upi', paymentAccountId: acc.paytm._id, referenceNumber: 'UTR998877' })).status).toBe(201);
  expect((await pay({ amount: 300, paymentMethod: 'upi', paymentAccountId: acc.paytm._id })).status).toBe(201);
  expect((await pay({ amount: 9000, paymentMethod: 'bank_transfer', paymentAccountId: acc.bank._id })).status).toBe(201);
  // Not collected: pending.
  expect((await pay({ amount: 777, paymentMethod: 'cash', paymentAccountId: acc.cash._id, status: 'pending' })).status).toBe(201);
  // Another business's collection.
  const otherCash = await add({ kind: 'cash', nickname: 'Cash' }, other.tokens.admin);
  const otherCust = await make.customer(other.admin);
  expect((await pay({ amount: 4444, paymentMethod: 'cash', paymentAccountId: otherCash._id }, other.tokens.admin, otherCust)).status).toBe(201);
});
afterAll(disconnectTestDb);

test('lists the receipts of the day and totals them like the summary', async () => {
  const data = await list();
  expect(data.totals).toEqual({ count: 4, amount: 11000 });
  expect(data.rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([300, 500, 1200, 9000]);
  const summary = (await get(`/api/payment-accounts/summary?from=${today()}`)).body.data;
  expect(summary.totals.collected).toBe(data.totals.amount);
  const upi = data.rows.find((r) => r.amount === 1200);
  expect(upi).toMatchObject({ method: 'upi', account: { nickname: 'Paytm', kind: 'wallet' }, payment: { customerName: 'Lotus Publications', reference: 'UTR998877' } });
  expect(upi.payment.paymentId).toBeTruthy();
  expect(data.rows.some((r) => [4444, 777].includes(r.amount))).toBe(false);
});

test('filters by account, account type, method and search', async () => {
  expect((await list(`&accountId=${acc.paytm._id}`)).totals).toEqual({ count: 2, amount: 1500 });
  expect((await list('&kind=bank')).totals).toEqual({ count: 1, amount: 9000 });
  expect((await list('&kind=cash')).totals).toEqual({ count: 1, amount: 500 });
  expect((await list('&paymentMethod=upi')).totals).toEqual({ count: 2, amount: 1500 });
  expect((await list('&search=UTR9988')).totals).toEqual({ count: 1, amount: 1200 });
  expect((await list('&accountId=unassigned')).totals).toEqual({ count: 0, amount: 0 });
  const sorted = await list('&sort=-amount&limit=2&page=1');
  expect(sorted.rows.map((r) => r.amount)).toEqual([9000, 1200]);
  expect(sorted.pagination.total).toBe(4);
});

test('a different day has nothing; bad input is refused', async () => {
  expect((await get('/api/payment-accounts/collections?from=2020-01-01')).body.data.totals.count).toBe(0);
  expect((await get('/api/payment-accounts/collections?from=2026-11-10&to=2026-11-01')).status).toBe(400);
  expect((await get('/api/payment-accounts/collections?kind=paypal')).status).toBe(400);
});

test('CSV export carries every row and the total', async () => {
  const res = await get(`/api/payment-accounts/collections?from=${today()}&format=csv`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/text\/csv/);
  expect(res.text).toMatch(/Lotus Publications/);
  expect(res.text).toMatch(/Total,.*4 payments,11000\.00/);
});

test('needs the Accounts permission', async () => {
  await User.updateOne({ _id: org.staff1._id }, { $set: { permissions: ['Payments', 'Payments: View'] } });
  expect((await get('/api/payment-accounts/collections', org.tokens.staff1)).status).toBe(403);
});
