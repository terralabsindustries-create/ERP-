const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const AccountTransaction = require('../src/models/AccountTransaction');
const BankReconciliation = require('../src/models/BankReconciliation');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let other;
let sequence = 0;
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const transaction = (user, type, amount, accountName = 'Main Bank') => AccountTransaction.create({
  transactionNumber: `TESTBANK${process.pid}${++sequence}`,
  userId: user._id,
  transactionType: type,
  category: type === 'opening_balance' ? 'opening_balance' : 'general',
  amount,
  description: `${type} ${amount}`,
  paymentMethod: 'bank_transfer',
  accountType: 'bank',
  accountName,
  status: 'completed'
});

beforeAll(async () => {
  await connectTestDb('bank_reconciliation');
  org = await createOrg('bank');
  other = await createOrg('otherbank');
});
afterAll(disconnectTestDb);

test('previews only this login’s eligible bank entries and saves a balanced statement', async () => {
  const opening = await transaction(org.admin, 'opening_balance', 1000);
  const income = await transaction(org.admin, 'income', 200);
  const expense = await transaction(org.admin, 'expense', 50);
  await transaction(org.admin, 'income', 999, 'Other Bank');
  await transaction(other.admin, 'income', 9999);

  const preview = await request(app).get(`/api/accounts/reconciliation?accountName=Main%20Bank&statementDate=${today}`).set(auth(org.tokens.admin));
  expect(preview.status).toBe(200);
  expect(preview.body.data.openingBalance).toBe(0);
  expect(preview.body.data.transactions.map((t) => t._id)).toEqual([String(opening._id), String(income._id), String(expense._id)]);

  const body = { accountName: 'Main Bank', statementDate: today, closingBalance: 1150, transactionIds: [opening.id, income.id, expense.id] };
  const saved = await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.admin)).send(body);
  expect(saved.status).toBe(201);
  expect(saved.body.data.reconciliation).toMatchObject({ openingBalance: 0, closingBalance: 1150, clearedTotal: 1150 });
  expect(await AccountTransaction.countDocuments({ _id: { $in: body.transactionIds }, reconciled: true })).toBe(3);
  const detail = await request(app).get(`/api/accounts/reconciliation/${saved.body.data.reconciliation._id}`).set(auth(org.tokens.admin));
  expect(detail.body.data.transactions).toHaveLength(3);
  expect((await request(app).get(`/api/accounts/reconciliation/${saved.body.data.reconciliation._id}`).set(auth(other.tokens.admin))).status).toBe(404);
  expect((await request(app).delete(`/api/accounts/transactions/${income.id}`).set(auth(org.tokens.admin))).status).toBe(409);
  expect((await request(app).put(`/api/accounts/transactions/${income.id}`).set(auth(org.tokens.admin)).send({ transactionType: 'income', category: 'general', amount: 300, description: 'changed', paymentMethod: 'bank_transfer', accountType: 'bank', accountName: 'Main Bank' })).status).toBe(409);
});

test('rejects mismatches, duplicate or foreign IDs and carries forward the last statement', async () => {
  const later = await transaction(org.admin, 'expense', 25);
  const foreign = await transaction(other.admin, 'income', 25);
  const base = { accountName: 'Main Bank', statementDate: tomorrow, closingBalance: 1125, transactionIds: [later.id] };
  expect((await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.admin)).send({ ...base, closingBalance: 1124 })).status).toBe(400);
  expect((await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.admin)).send({ ...base, transactionIds: [later.id, later.id] })).status).toBe(400);
  expect((await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.admin)).send({ ...base, transactionIds: [foreign.id] })).status).toBe(409);
  expect((await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.admin)).send({ ...base, statementDate: today })).status).toBe(409);
  expect(await BankReconciliation.countDocuments({ userId: org.admin._id })).toBe(1);
  const saved = await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.admin)).send(base);
  expect(saved.status).toBe(201);
  expect(saved.body.data.reconciliation.openingBalance).toBe(1150);
  const preview = await request(app).get(`/api/accounts/reconciliation?accountName=Main%20Bank&statementDate=${tomorrow}`).set(auth(org.tokens.admin));
  expect(preview.body.data.transactions).toHaveLength(0);
});

test('view permission cannot reconcile but can see the business statements', async () => {
  await User.updateOne({ _id: org.staff1._id }, { permissions: ['Accounts', 'Accounts: View'] });
  expect((await request(app).get('/api/accounts/reconciliation').set(auth(org.tokens.staff1))).status).toBe(200);
  const response = await request(app).post('/api/accounts/reconciliation').set(auth(org.tokens.staff1)).send({ accountName: 'Main Bank', statementDate: today, closingBalance: 0, transactionIds: [] });
  expect(response.status).toBe(403);
  const preview = await request(app).get('/api/accounts/reconciliation').set(auth(org.tokens.staff1));
  expect(preview.body.data.history).toHaveLength(2);
  const foreign = await request(app).get('/api/accounts/reconciliation').set(auth(other.tokens.admin));
  expect(foreign.body.data.history).toHaveLength(0);
});

test('uses the transaction date, so a future-dated entry is not offered on an earlier statement', async () => {
  const future = await transaction(org.admin, 'income', 70, 'Date Bank');
  await AccountTransaction.updateOne({ _id: future._id }, { postedAt: new Date(`${tomorrow}T00:00:00.000Z`) });
  const earlier = await request(app).get(`/api/accounts/reconciliation?accountName=Date%20Bank&statementDate=${today}`).set(auth(org.tokens.admin));
  const later = await request(app).get(`/api/accounts/reconciliation?accountName=Date%20Bank&statementDate=${tomorrow}`).set(auth(org.tokens.admin));
  expect(earlier.body.data.transactions).toHaveLength(0);
  expect(later.body.data.transactions.map((t) => t._id)).toEqual([future.id]);
});
