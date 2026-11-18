/**
 * Accounting regressions: transfers move money between two accounts once,
 * "Net this month" totals every entry of the month by its effective date,
 * type filters run before pagination, profit & loss is business-wide, and
 * the Excel export shows the effective date and the right type.
 */
const request = require('supertest');
const ExcelJS = require('exceljs');
const app = require('../src/app');
const User = require('../src/models/User');
const AccountTransaction = require('../src/models/AccountTransaction');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let other;
const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  delete: (url) => request(app).delete(url).set(auth(token))
});
const admin = () => as(org.tokens.admin);

const entry = (extra = {}) => ({
  transactionType: 'income', category: 'sales', amount: 100, description: 'Entry',
  paymentMethod: 'cash', accountType: 'cash', accountName: 'Main Cash', ...extra
});
const transfer = (amount, from, to, extra = {}) => entry({
  transactionType: 'transfer', category: 'transfer', amount, description: `Transfer ${amount}`,
  paymentMethod: 'bank_transfer', accountType: from.type, accountName: from.name,
  transferDetails: { toAccountType: to.type, toAccount: to.name }, ...extra
});
const balances = async (token = org.tokens.admin) => (await as(token).get('/api/accounts/balances')).body.data.currentBalances;
const total = (b) => b.cashBalance + b.bankBalance + b.creditCardBalance + b.loanBalance + b.investmentBalance;

/** Rows written straight to the collection, so createdAt can be set. */
const raw = (user, rows) => AccountTransaction.collection.insertMany(rows.map((row) => ({
  category: 'general', description: 'raw', paymentMethod: 'cash', accountType: 'cash', accountName: 'Main Cash',
  status: 'completed', userId: user._id, dataScope: user.dataScope, createdAt: new Date(), updatedAt: new Date(), ...row
})));

beforeAll(async () => {
  await connectTestDb('accounting_transfers_reports');
  org = await createOrg('xfer');
  other = await createOrg('xferother');
});
afterAll(disconnectTestDb);

describe('transfers between accounts', () => {
  const cash = { type: 'cash', name: 'Main Cash' };
  const bank = { type: 'bank', name: 'HDFC Current' };

  beforeAll(async () => {
    expect((await admin().post('/api/accounts/transactions', entry({ transactionType: 'opening_balance', category: 'opening_balance', amount: 10000 }))).status).toBe(201);
  });

  test('need a destination and refuse the same account', async () => {
    const missing = await admin().post('/api/accounts/transactions', entry({ transactionType: 'transfer', category: 'transfer' }));
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/transfer goes to/);

    const blankName = await admin().post('/api/accounts/transactions', transfer(50, cash, { type: 'bank', name: '   ' }));
    expect(blankName.status).toBe(400);

    const same = await admin().post('/api/accounts/transactions', transfer(50, cash, { type: 'cash', name: '  main   CASH ' }));
    expect(same.status).toBe(400);
    expect(same.body.message).toBe('A transfer must go to a different account');
    expect(await AccountTransaction.countDocuments({ dataScope: org.dataScope, transactionType: 'transfer' })).toBe(0);
  });

  test('debit the source and credit the destination once, leaving the business total unchanged', async () => {
    const before = await balances();
    const res = await admin().post('/api/accounts/transactions', transfer(2500, cash, bank));
    expect(res.status).toBe(201);
    expect(res.body.data.transaction.transferDetails).toMatchObject({ fromAccount: 'Main Cash', toAccountType: 'bank', toAccount: 'HDFC Current' });
    expect(await AccountTransaction.countDocuments({ dataScope: org.dataScope, transactionType: 'transfer' })).toBe(1);

    const after = await balances();
    expect(after.cashBalance).toBe(before.cashBalance - 2500);
    expect(after.bankBalance).toBe(before.bankBalance + 2500);
    expect(total(after)).toBe(total(before));

    // The dashboard reads the same ledger.
    const dash = await admin().get('/api/dashboard/stats');
    expect(dash.status).toBe(200);
    expect(dash.body.stats).toMatchObject({ cashBalance: after.cashBalance, bankBalance: after.bankBalance });
  });

  test('the dashboard counts entries kept from a removed login, like the Accounts page', async () => {
    const books = await createOrg('xferdash');
    const removedLogin = { _id: new (require('mongoose').Types.ObjectId)(), dataScope: books.dataScope };
    await raw(books.admin, [{ transactionType: 'opening_balance', amount: 1000 }]);
    await raw(removedLogin, [{ transactionType: 'income', amount: 250 }]);
    const accounts = await balances(books.tokens.admin);
    expect(accounts.cashBalance).toBe(1250);
    const dash = await as(books.tokens.admin).get('/api/dashboard/stats');
    expect(dash.body.stats).toMatchObject({ cashBalance: 1250 });
  });

  test('a transfer between two accounts of the same kind leaves that kind unchanged', async () => {
    const before = await balances();
    expect((await admin().post('/api/accounts/transactions', transfer(400, bank, { type: 'bank', name: 'SBI Savings' }))).status).toBe(201);
    expect(await balances()).toEqual(before);
  });

  test('editing keeps the rules, and an entry that stops being a transfer drops its destination', async () => {
    const created = (await admin().post('/api/accounts/transactions', transfer(300, cash, bank))).body.data.transaction;
    const before = await balances();

    expect((await admin().put(`/api/accounts/transactions/${created._id}`, transfer(300, cash, cash))).status).toBe(400);
    expect((await admin().put(`/api/accounts/transactions/${created._id}`, entry({ transactionType: 'transfer', category: 'transfer', amount: 300 }))).status).toBe(400);

    const resized = await admin().put(`/api/accounts/transactions/${created._id}`, transfer(500, cash, bank));
    expect(resized.status).toBe(200);
    let now = await balances();
    expect(now.cashBalance).toBe(before.cashBalance - 200);
    expect(now.bankBalance).toBe(before.bankBalance + 200);

    const expense = await admin().put(`/api/accounts/transactions/${created._id}`, entry({ transactionType: 'expense', category: 'rent', amount: 500 }));
    expect(expense.status).toBe(200);
    expect((await AccountTransaction.findById(created._id)).transferDetails?.toAccountType).toBeUndefined();
    now = await balances();
    expect(now.cashBalance).toBe(before.cashBalance - 200);
    expect(now.bankBalance).toBe(before.bankBalance - 300);
  });

  test('a client cannot forge the destination reconciliation state', async () => {
    const res = await admin().post('/api/accounts/transactions', { ...transfer(10, cash, bank), transferInReconciled: true, transferDetails: { toAccountType: 'bank', toAccount: 'HDFC Current', transferFee: 99 } });
    expect(res.status).toBe(201);
    const saved = await AccountTransaction.findById(res.body.data.transaction._id);
    expect(saved.transferInReconciled).toBe(false);
    expect(saved.transferDetails.transferFee).toBe(0);
  });

  test('a transfer appears under both accounts and clears on the destination bank statement on its own', async () => {
    const bankList = await admin().get('/api/accounts/transactions?accountType=bank&transactionType=transfer&limit=100');
    const cashList = await admin().get('/api/accounts/transactions?accountType=cash&transactionType=transfer&limit=100');
    const cashToBank = bankList.body.data.transactions.filter((t) => t.accountType === 'cash');
    expect(cashToBank.length).toBeGreaterThan(0);
    expect(cashList.body.data.transactions.map((t) => t._id)).toEqual(expect.arrayContaining(cashToBank.map((t) => t._id)));

    const istNow = new Date(Date.now() + 330 * 60000);
    const today = istNow.toISOString().slice(0, 10);
    const intoSbi = (await admin().post('/api/accounts/transactions', transfer(750, cash, { type: 'bank', name: 'Axis Payroll' }))).body.data.transaction;

    const preview = await admin().get(`/api/accounts/reconciliation?accountName=Axis%20Payroll&statementDate=${today}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.accounts).toContain('Axis Payroll');
    expect(preview.body.data.transactions).toEqual([expect.objectContaining({ _id: intoSbi._id, direction: 'in' })]);

    // A bank-to-bank transfer: out on the source statement, in on the destination's.
    const hdfcToAxis = (await admin().post('/api/accounts/transactions', transfer(50, bank, { type: 'bank', name: 'Axis Payroll' }))).body.data.transaction;
    const hdfc = await admin().get(`/api/accounts/reconciliation?accountName=HDFC%20Current&statementDate=${today}`);
    expect(hdfc.body.data.transactions.find((t) => t._id === hdfcToAxis._id).direction).toBe('out');

    const saved = await admin().post('/api/accounts/reconciliation', { accountName: 'Axis Payroll', statementDate: today, closingBalance: 800, transactionIds: [intoSbi._id, hdfcToAxis._id] });
    expect(saved.status).toBe(201);
    const stored = await AccountTransaction.findById(hdfcToAxis._id);
    expect(stored).toMatchObject({ transferInReconciled: true, reconciled: false });

    // Still open on the source account's statement, and locked against edits.
    const hdfcAfter = await admin().get(`/api/accounts/reconciliation?accountName=HDFC%20Current&statementDate=${today}`);
    expect(hdfcAfter.body.data.transactions.map((t) => t._id)).toContain(hdfcToAxis._id);
    expect((await admin().put(`/api/accounts/transactions/${intoSbi._id}`, transfer(1, cash, { type: 'bank', name: 'Axis Payroll' }))).status).toBe(409);
    expect((await admin().delete(`/api/accounts/transactions/${intoSbi._id}`)).status).toBe(409);

    const detail = await admin().get(`/api/accounts/reconciliation/${saved.body.data.reconciliation._id}`);
    expect(detail.body.data.transactions.every((t) => t.direction === 'in')).toBe(true);
  });

  test('a transfer recorded before destinations existed still debits only its source', async () => {
    const before = await balances();
    await raw(org.admin, [{ transactionType: 'transfer', amount: 90 }]);
    const after = await balances();
    expect(after.cashBalance).toBe(before.cashBalance - 90);
    expect(after.bankBalance).toBe(before.bankBalance);
  });
});

describe('net for a month', () => {
  const march = { startDate: '2026-03-01T00:00:00.000Z', endDate: '2026-04-01T00:00:00.000Z' };
  const url = `/api/accounts/stats/period?startDate=${encodeURIComponent(march.startDate)}&endDate=${encodeURIComponent(march.endDate)}`;

  test('totals every completed entry of the month by its effective date, not the first 100', async () => {
    const inMarch = new Date('2026-03-10T06:00:00.000Z');
    await raw(org.admin, Array.from({ length: 130 }, () => ({ transactionType: 'income', amount: 10, createdAt: inMarch })));
    await raw(org.admin, [
      { transactionType: 'expense', amount: 200, createdAt: inMarch },
      // Typed in April, dated March: counts in March.
      { transactionType: 'expense', amount: 50, createdAt: new Date('2026-04-02T06:00:00.000Z'), postedAt: new Date('2026-03-31T00:00:00.000Z') },
      // Typed in March, dated February: does not.
      { transactionType: 'income', amount: 999, createdAt: inMarch, postedAt: new Date('2026-02-27T00:00:00.000Z') },
      // Not completed, or not income/expense: not counted.
      { transactionType: 'income', amount: 777, createdAt: inMarch, status: 'pending' },
      { transactionType: 'expense', amount: 555, createdAt: inMarch, status: 'cancelled' },
      { transactionType: 'opening_balance', amount: 5000, createdAt: inMarch },
      { transactionType: 'transfer', amount: 300, createdAt: inMarch, transferDetails: { toAccountType: 'bank', toAccount: 'X' } }
    ]);
    await raw(other.admin, [{ transactionType: 'income', amount: 12345, createdAt: inMarch }]);

    const res = await admin().get(url);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ income: 1300, expense: 250, net: 1050, entries: 132 });
  });

  test('validates the period and defaults to the current month', async () => {
    expect((await admin().get('/api/accounts/stats/period?startDate=nope')).status).toBe(400);
    expect((await admin().get(`/api/accounts/stats/period?startDate=${encodeURIComponent(march.endDate)}&endDate=${encodeURIComponent(march.startDate)}`)).status).toBe(400);
    expect((await admin().get('/api/accounts/stats/period')).status).toBe(200);
  });
});

describe('type filters on the transaction list', () => {
  let scoped;
  beforeAll(async () => {
    scoped = await createOrg('xferlist');
    await raw(scoped.admin, [
      ...Array.from({ length: 40 }, (_, i) => ({ transactionType: 'income', amount: 1, createdAt: new Date(Date.now() - i * 1000) })),
      ...Array.from({ length: 5 }, () => ({ transactionType: 'opening_balance', amount: 1, createdAt: new Date(Date.now() - 100000) })),
      ...Array.from({ length: 4 }, () => ({ transactionType: 'adjustment', amount: 1, createdAt: new Date(Date.now() - 100000) })),
      ...Array.from({ length: 3 }, () => ({ transactionType: 'transfer', amount: 1, createdAt: new Date(Date.now() - 100000), transferDetails: { toAccountType: 'bank', toAccount: 'B' } }))
    ]);
  });

  test('filter before paginating, count every match and reach every page', async () => {
    const seen = new Set();
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const res = await as(scoped.tokens.admin).get(`/api/accounts/transactions?transactionType=transfer,opening_balance,adjustment&limit=5&page=${page}`);
      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toMatchObject({ totalTransactions: 12, total: 3 });
      pages = res.body.data.pagination.total;
      res.body.data.transactions.forEach((t) => {
        expect(['transfer', 'opening_balance', 'adjustment']).toContain(t.transactionType);
        seen.add(t._id);
      });
    }
    expect(seen.size).toBe(12);

    const single = await as(scoped.tokens.admin).get('/api/accounts/transactions?transactionType=adjustment');
    expect(single.body.data.pagination.totalTransactions).toBe(4);
  });

  test('refuse an unknown type instead of returning an empty page', async () => {
    expect((await as(scoped.tokens.admin).get('/api/accounts/transactions?transactionType=transfer,bogus')).status).toBe(400);
  });
});

describe('profit & loss', () => {
  test('is the business total, whichever login typed the entry, and owner-only', async () => {
    const books = await createOrg('xferpl');
    await User.updateMany({ _id: { $in: [books.staff1._id] } }, { $set: { permissions: ['Accounts', 'Accounts: View', 'Accounts: Create & Edit'] } });
    expect((await as(books.tokens.admin).post('/api/accounts/transactions', entry({ amount: 300 }))).status).toBe(201);
    expect((await as(books.tokens.staff1).post('/api/accounts/transactions', entry({ amount: 200 }))).status).toBe(201);
    expect((await as(books.tokens.staff1).post('/api/accounts/transactions', entry({ transactionType: 'expense', category: 'rent', amount: 120 }))).status).toBe(201);
    expect((await as(books.tokens.admin).post('/api/accounts/transactions', transfer(50, { type: 'cash', name: 'Main Cash' }, { type: 'bank', name: 'B' }))).status).toBe(201);

    const report = await as(books.tokens.admin).get('/api/accounts/reports/summary?period=month');
    expect(report.status).toBe(200);
    expect(report.body.data.report).toMatchObject({ totalIncome: 500, totalExpenses: 120, netProfit: 380, cashBalance: 330, bankBalance: 50 });
    expect((await as(books.tokens.staff1).get('/api/accounts/reports/summary?period=month')).status).toBe(403);
  });
});

describe('Excel export', () => {
  const binary = (res, done) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  test('shows the effective date and the right type for every kind of entry', async () => {
    const books = await createOrg('xferxlsx');
    const march = new Date('2026-03-12T10:00:00.000Z');
    await raw(books.admin, [
      { transactionType: 'income', amount: 1, transactionNumber: `XL-INC-${process.pid}`, createdAt: march },
      { transactionType: 'expense', amount: 2, transactionNumber: `XL-EXP-${process.pid}`, createdAt: march },
      { transactionType: 'transfer', amount: 3, transactionNumber: `XL-TRF-${process.pid}`, createdAt: march, transferDetails: { toAccountType: 'bank', toAccount: 'B' } },
      { transactionType: 'opening_balance', amount: 4, transactionNumber: `XL-OPN-${process.pid}`, createdAt: march },
      { transactionType: 'adjustment', amount: 5, transactionNumber: `XL-ADJ-${process.pid}`, createdAt: march },
      // Entered in April, dated 5 March: the sheet shows 05/03/2026.
      { transactionType: 'expense', amount: 6, transactionNumber: `XL-BACK-${process.pid}`, createdAt: new Date('2026-04-03T10:00:00.000Z'), postedAt: new Date('2026-03-05T00:00:00.000Z') }
    ]);

    const res = await request(app).get('/api/accounts/reports/export?startDate=2026-03-01&endDate=2026-03-31')
      .set(auth(books.tokens.admin)).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.getWorksheet('Transactions Report');
    const rows = {};
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      rows[row.getCell(2).value] = { date: row.getCell(1).value, type: row.getCell(5).value, account: row.getCell(7).value };
    });
    const at = (code) => rows[`XL-${code}-${process.pid}`];
    expect(Object.keys(rows)).toHaveLength(6);
    expect(at('INC').type).toBe('Income');
    expect(at('EXP').type).toBe('Expense');
    expect(at('TRF')).toMatchObject({ type: 'Transfer', account: 'CASH → BANK' });
    expect(at('OPN').type).toBe('Opening balance');
    expect(at('ADJ').type).toBe('Adjustment');
    expect(at('BACK').date).toBe('05/03/2026');
    expect(at('INC').date).toBe('12/03/2026');
  });
});
