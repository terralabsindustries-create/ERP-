/**
 * Payment receiving accounts (Cash, Paytm, bank accounts): set-up, choosing
 * one when recording a payment, per-account collections and balances, the
 * daily opening / closing report, refunds, duplicates, adjustments, renames
 * and business isolation.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Payment = require('../src/models/Payment');
const AccountTransaction = require('../src/models/AccountTransaction');
const PaymentAccount = require('../src/models/PaymentAccount');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let customer;
const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  delete: (url) => request(app).delete(url).set(auth(token))
});
const admin = () => as(org.tokens.admin);
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

const accounts = {};
const addAccount = async (body, token = org.tokens.admin) => {
  const res = await as(token).post('/api/payment-accounts', body);
  expect(res.status).toBe(201);
  return res.body.data.account;
};
const pay = (body, token = org.tokens.admin) => as(token).post('/api/payments', { customerId: String(customer._id), status: 'completed', ...body });
const summary = async (from, to = from, extra = '') => {
  const res = await admin().get(`/api/payment-accounts/summary?from=${from}&to=${to}${extra}`);
  expect(res.status).toBe(200);
  return res.body.data;
};
const rowOf = (data, account) => data.accounts.find((r) => r._id === account._id);

beforeAll(async () => {
  await connectTestDb('payment_accounts');
  org = await createOrg('payacc');
  other = await createOrg('payaccother');
  customer = await make.customer(org.admin);
  await AccountTransaction.syncIndexes();
  await PaymentAccount.syncIndexes();
});
afterAll(disconnectTestDb);

describe('setting up accounts', () => {
  test('a business can add cash, Paytm and several bank accounts', async () => {
    accounts.cash = await addAccount({ kind: 'cash', nickname: 'Cash', openingBalance: 1000, openingDate: '2026-10-01' });
    accounts.paytm = await addAccount({ kind: 'wallet', nickname: 'Paytm', provider: 'Paytm', walletId: 'shop@paytm' });
    accounts.hdfc = await addAccount({ kind: 'bank', nickname: 'HDFC Current', bankName: 'HDFC Bank', accountHolderName: 'PAYACC Printers', accountNumber: '50100123454321', ifscCode: 'HDFC0001234', openingBalance: 20000, openingDate: '2026-10-01' });
    accounts.sbi = await addAccount({ kind: 'bank', nickname: 'SBI Savings', bankName: 'State Bank of India', accountNumber: '30001112223', ifscCode: 'SBIN0000456' });

    const list = (await admin().get('/api/payment-accounts')).body.data.accounts;
    expect(list.map((a) => a.nickname).sort()).toEqual(['Cash', 'HDFC Current', 'Paytm', 'SBI Savings']);
    const hdfc = list.find((a) => a.nickname === 'HDFC Current');
    // The number is masked everywhere except an editor's explicit reveal.
    expect(hdfc).toMatchObject({ accountNumberMasked: '••••4321', balance: 20000 });
    expect(hdfc.accountNumber).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('50100123454321');
    const revealed = await admin().get(`/api/payment-accounts/${accounts.hdfc._id}?reveal=true`);
    expect(revealed.body.data.account.accountNumber).toBe('50100123454321');
  });

  test('names are unique per business and bank details are validated', async () => {
    expect((await admin().post('/api/payment-accounts', { kind: 'cash', nickname: '  cash ' })).status).toBe(409);
    expect((await admin().post('/api/payment-accounts', { kind: 'bank', nickname: 'Bad IFSC', ifscCode: 'HDFC123' })).status).toBe(400);
    expect((await admin().post('/api/payment-accounts', { kind: 'paypal', nickname: 'X' })).status).toBe(400);
    // Another business may use the same name.
    expect((await as(other.tokens.admin).post('/api/payment-accounts', { kind: 'cash', nickname: 'Cash' })).status).toBe(201);
  });

  test('logins that record payments see names only; only Accounts editors change accounts', async () => {
    await User.updateOne({ _id: org.staff1._id }, { $set: { permissions: ['Payments', 'Payments: View', 'Payments: Record Payment'] } });
    const staff = as(org.tokens.staff1);
    const list = await staff.get('/api/payment-accounts?active=true');
    expect(list.status).toBe(200);
    expect(list.body.data.accounts).toHaveLength(4);
    expect(list.body.data.accounts[0].balance).toBeUndefined();
    expect((await staff.get(`/api/payment-accounts/${accounts.hdfc._id}?reveal=true`)).body.data.account.accountNumber).toBeUndefined();
    expect((await staff.get('/api/payment-accounts/summary')).status).toBe(403);
    expect((await staff.post('/api/payment-accounts', { kind: 'cash', nickname: 'Drawer 2' })).status).toBe(403);
    expect((await staff.put(`/api/payment-accounts/${accounts.cash._id}`, { nickname: 'Mine' })).status).toBe(403);
  });

  test("another business cannot see or use these accounts", async () => {
    const them = as(other.tokens.admin);
    expect((await them.get('/api/payment-accounts')).body.data.accounts.map((a) => a.nickname)).toEqual(['Cash']);
    expect((await them.get(`/api/payment-accounts/${accounts.hdfc._id}`)).status).toBe(404);
    const theirCustomer = await make.customer(other.admin);
    const res = await them.post('/api/payments', { customerId: String(theirCustomer._id), amount: 10, paymentMethod: 'upi', paymentAccountId: accounts.paytm._id });
    expect(res.status).toBe(404);
  });
});

describe('recording payments into an account', () => {
  test('once accounts exist, a payment must say where it was received, into a fitting account', async () => {
    const missing = await pay({ amount: 100, paymentMethod: 'cash' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('PAYMENT_ACCOUNT_REQUIRED');
    expect((await pay({ amount: 100, paymentMethod: 'cash', paymentAccountId: accounts.paytm._id })).body.code).toBe('PAYMENT_ACCOUNT_MISMATCH');
    expect((await pay({ amount: 100, paymentMethod: 'upi', paymentAccountId: accounts.cash._id })).body.code).toBe('PAYMENT_ACCOUNT_MISMATCH');
    expect(await Payment.countDocuments({ dataScope: org.dataScope })).toBe(0);
  });

  test('₹5,000 through Paytm adds to Paytm only', async () => {
    const before = await summary('2026-10-02');
    const res = await pay({ amount: 5000, paymentMethod: 'upi', paymentAccountId: accounts.paytm._id, paymentDate: '2026-10-02', referenceNumber: 'PTM-77' });
    expect(res.status).toBe(201);
    // The payment names its account by nickname, never by number.
    expect(res.body.data.payment.paymentAccountId).toMatchObject({ _id: accounts.paytm._id, nickname: 'Paytm', kind: 'wallet' });
    const entry = await AccountTransaction.findOne({ sourcePaymentId: res.body.data.payment._id }).lean();
    expect(entry).toMatchObject({ transactionType: 'income', amount: 5000, accountName: 'Paytm', accountType: 'bank', status: 'completed' });
    expect(String(entry.paymentAccountId)).toBe(accounts.paytm._id);

    const after = await summary('2026-10-02');
    expect(rowOf(after, accounts.paytm)).toMatchObject({ received: 5000, receivedCount: 1, closing: 5000 });
    for (const a of [accounts.cash, accounts.hdfc, accounts.sbi]) {
      expect(rowOf(after, a).received).toBe(rowOf(before, a).received);
      expect(rowOf(after, a).closing).toBe(rowOf(before, a).closing);
    }
    expect(after.byKind.wallet.received).toBe(5000);
  });

  test('cash goes to Cash and each bank payment to its own bank', async () => {
    expect((await pay({ amount: 300, paymentMethod: 'cash', paymentAccountId: accounts.cash._id, paymentDate: '2026-10-02' })).status).toBe(201);
    expect((await pay({ amount: 1200, paymentMethod: 'bank_transfer', paymentAccountId: accounts.hdfc._id, paymentDate: '2026-10-02' })).status).toBe(201);
    expect((await pay({ amount: 800, paymentMethod: 'cheque', paymentAccountId: accounts.sbi._id, paymentDate: '2026-10-02' })).status).toBe(201);
    const day = await summary('2026-10-02');
    expect(rowOf(day, accounts.cash)).toMatchObject({ opening: 1000, received: 300, closing: 1300 });
    expect(rowOf(day, accounts.hdfc)).toMatchObject({ opening: 20000, received: 1200, closing: 21200 });
    expect(rowOf(day, accounts.sbi)).toMatchObject({ opening: 0, received: 800, closing: 800 });
    expect(day.totals).toMatchObject({ received: 7300, collected: 7300 });
    expect(day.byKind).toMatchObject({ cash: { received: 300 }, wallet: { received: 5000 }, bank: { received: 2000 } });
  });

  test('pending and failed payments are not counted as received', async () => {
    expect((await pay({ amount: 999, paymentMethod: 'upi', paymentAccountId: accounts.paytm._id, paymentDate: '2026-10-02', status: 'pending' })).status).toBe(201);
    expect((await pay({ amount: 888, paymentMethod: 'upi', paymentAccountId: accounts.paytm._id, paymentDate: '2026-10-02', status: 'failed' })).status).toBe(201);
    expect(rowOf(await summary('2026-10-02'), accounts.paytm)).toMatchObject({ received: 5000, closing: 5000 });
  });

  test('a repeated submission records the payment and its collection once', async () => {
    const body = { amount: 250, paymentMethod: 'upi', paymentAccountId: accounts.paytm._id, paymentDate: '2026-10-03', idempotencyKey: `dup-${process.pid}-1` };
    const results = await Promise.all([pay(body), pay(body), pay(body)]);
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(results.map((r) => r.body.data.payment._id)).size).toBe(1);
    expect(rowOf(await summary('2026-10-03'), accounts.paytm)).toMatchObject({ received: 250, receivedCount: 1 });
    // The same key for a different account is a different payment: refused.
    expect((await pay({ ...body, paymentAccountId: accounts.hdfc._id, paymentMethod: 'bank_transfer' })).status).toBe(409);
  });

  test('concurrent payments into one account all count', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => pay({ amount: 100 + i, paymentMethod: 'cash', paymentAccountId: accounts.cash._id, paymentDate: '2026-10-04' })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(rowOf(await summary('2026-10-04'), accounts.cash).received).toBe(615);
  });

  test('a payment applied to an invoice still settles the invoice', async () => {
    const invoice = await make.invoice(org.admin, customer, { lines: [{ amount: 1000, rate: 0 }] });
    const res = await pay({ amount: 400, paymentMethod: 'upi', paymentAccountId: accounts.sbi._id, invoiceId: String(invoice._id), paymentDate: '2026-10-04' });
    expect(res.status).toBe(201);
    const after = (await admin().get(`/api/invoices/${invoice._id}`)).body.data.invoice;
    expect(after).toMatchObject({ paidAmount: 400, balanceAmount: 600, paymentStatus: 'partial' });
  });

  test('payments can be listed and searched by account', async () => {
    const list = (await admin().get(`/api/payments?paymentAccountId=${accounts.paytm._id}&limit=100`)).body.data.payments;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.paymentAccountId?.nickname === 'Paytm')).toBe(true);
    const found = (await admin().get(`/api/payments?paymentAccountId=${accounts.paytm._id}&search=PTM-77`)).body.data.payments;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ amount: 5000, referenceNumber: 'PTM-77', status: 'completed', customerName: customer.name });
  });
});

describe('daily opening and closing balances', () => {
  test('closing = opening + received − paid out, day after day', async () => {
    const acct = await addAccount({ kind: 'bank', nickname: 'Axis Collections', openingBalance: 1000, openingDate: '2026-09-10' });
    await pay({ amount: 500, paymentMethod: 'upi', paymentAccountId: acct._id, paymentDate: '2026-09-11' });
    await pay({ amount: 300, paymentMethod: 'upi', paymentAccountId: acct._id, paymentDate: '2026-09-12' });
    // Money out of the account on the 12th: a supplier paid from it.
    const out = await admin().post('/api/accounts/transactions', {
      transactionType: 'expense', category: 'materials', amount: 200, description: 'Paper', paymentMethod: 'bank_transfer',
      accountType: 'bank', accountName: 'ignored', paymentAccountId: acct._id, postedAt: '2026-09-12'
    });
    expect(out.status).toBe(201);
    expect(out.body.data.transaction).toMatchObject({ accountName: 'Axis Collections', accountType: 'bank' });

    expect(rowOf(await summary('2026-09-10'), acct)).toMatchObject({ opening: 1000, received: 0, paidOut: 0, closing: 1000 });
    expect(rowOf(await summary('2026-09-11'), acct)).toMatchObject({ opening: 1000, received: 500, paidOut: 0, closing: 1500 });
    const twelfth = rowOf(await summary('2026-09-12'), acct);
    expect(twelfth).toMatchObject({ opening: 1500, received: 300, paidOut: 200, closing: 1600, currentBalance: 1600 });
    // Today's collections are not the account's balance.
    expect(rowOf(await summary(istToday()), acct)).toMatchObject({ received: 0, opening: 1600, closing: 1600 });
    // A period: opening at its start, closing at its end.
    expect(rowOf(await summary('2026-09-11', '2026-09-12'), acct)).toMatchObject({ opening: 1000, received: 800, paidOut: 200, closing: 1600 });
    expect((await summary('2026-09-11', '2026-09-12', `&accountId=${acct._id}`)).accounts).toHaveLength(1);
  });

  test('a transfer from Cash to a bank moves money between the two accounts only', async () => {
    const before = await summary('2026-10-05');
    const res = await admin().post('/api/accounts/transactions', {
      transactionType: 'transfer', category: 'transfer', amount: 500, description: 'Cash deposited', paymentMethod: 'cash',
      accountType: 'cash', accountName: 'x', paymentAccountId: accounts.cash._id, postedAt: '2026-10-05',
      transferDetails: { toAccountType: 'bank', toAccount: 'y', toPaymentAccountId: accounts.hdfc._id }
    });
    expect(res.status).toBe(201);
    const after = await summary('2026-10-05');
    expect(rowOf(after, accounts.cash).paidOut).toBe(rowOf(before, accounts.cash).paidOut + 500);
    expect(rowOf(after, accounts.hdfc).otherIn).toBe(rowOf(before, accounts.hdfc).otherIn + 500);
    expect(after.totals.currentBalance).toBe(before.totals.currentBalance);
    const same = await admin().post('/api/accounts/transactions', {
      transactionType: 'transfer', category: 'transfer', amount: 1, description: 'x', paymentMethod: 'cash', accountType: 'cash', accountName: 'x',
      paymentAccountId: accounts.cash._id, transferDetails: { toAccountType: 'cash', toAccount: 'x', toPaymentAccountId: accounts.cash._id }
    });
    expect(same.status).toBe(400);
  });

  test('a balance adjustment brings the recorded balance to the actual one, on record', async () => {
    const acct = await addAccount({ kind: 'cash', nickname: 'Counter drawer', openingBalance: 500, openingDate: '2026-09-01' });
    const res = await admin().post(`/api/payment-accounts/${acct._id}/adjust`, { actualBalance: 470, date: '2026-09-01', note: 'Cash count short' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ recorded: 500, difference: -30 });
    expect(rowOf(await summary('2026-09-01'), acct)).toMatchObject({ opening: 500, paidOut: 30, closing: 470 });
    expect((await admin().post(`/api/payment-accounts/${acct._id}/adjust`, { actualBalance: 470, date: '2026-09-01', note: 'Recount' })).body.data.difference).toBe(0);
    expect((await admin().post(`/api/payment-accounts/${acct._id}/adjust`, { actualBalance: 470, note: '' })).status).toBe(400);
  });
});

describe('refunds, failures and reversals', () => {
  test('a refund keeps the receipt on its day and pays the money out on the refund day', async () => {
    const acct = await addAccount({ kind: 'wallet', nickname: 'PhonePe', provider: 'PhonePe' });
    const created = await pay({ amount: 700, paymentMethod: 'upi', paymentAccountId: acct._id, paymentDate: '2026-09-20' });
    const id = created.body.data.payment._id;
    expect((await admin().put(`/api/payments/${id}`, { status: 'refunded' })).status).toBe(200);

    expect(rowOf(await summary('2026-09-20'), acct)).toMatchObject({ received: 700, closing: 700 });
    const today = rowOf(await summary(istToday()), acct);
    expect(today).toMatchObject({ paidOut: 700, closing: 0, currentBalance: 0 });
    const refund = await AccountTransaction.findOne({ sourceRefundPaymentId: id }).lean();
    expect(refund).toMatchObject({ transactionType: 'expense', amount: 700, status: 'completed', accountName: 'PhonePe' });
    // The refund entry is protected like the receipt.
    expect((await admin().delete(`/api/accounts/transactions/${refund._id}`)).status).toBe(409);

    // Marked received again: the refund is reversed, the money is back.
    expect((await admin().put(`/api/payments/${id}`, { status: 'completed' })).status).toBe(200);
    expect((await AccountTransaction.findById(refund._id).lean()).status).toBe('reversed');
    expect(rowOf(await summary(istToday()), acct)).toMatchObject({ paidOut: 0, currentBalance: 700 });

    // Deleting the payment reverses everything.
    expect((await admin().delete(`/api/payments/${id}`)).status).toBe(200);
    expect(rowOf(await summary(istToday()), acct).currentBalance).toBe(0);
    expect(rowOf(await summary('2026-09-20'), acct).received).toBe(0);
  });

  test('a cancelled or failed payment is taken off the account', async () => {
    const acct = await addAccount({ kind: 'bank', nickname: 'Kotak', bankName: 'Kotak' });
    const id = (await pay({ amount: 900, paymentMethod: 'bank_transfer', paymentAccountId: acct._id, paymentDate: '2026-09-21' })).body.data.payment._id;
    expect(rowOf(await summary('2026-09-21'), acct).received).toBe(900);
    expect((await admin().put(`/api/payments/${id}`, { status: 'cancelled' })).status).toBe(200);
    expect(rowOf(await summary('2026-09-21'), acct).received).toBe(0);
  });

  test('moving a payment to another account moves its collection', async () => {
    const a = await addAccount({ kind: 'bank', nickname: 'ICICI A' });
    const b = await addAccount({ kind: 'bank', nickname: 'ICICI B' });
    const id = (await pay({ amount: 60, paymentMethod: 'upi', paymentAccountId: a._id, paymentDate: '2026-09-22' })).body.data.payment._id;
    expect((await admin().put(`/api/payments/${id}`, { paymentAccountId: b._id })).status).toBe(200);
    const day = await summary('2026-09-22');
    expect([rowOf(day, a).received, rowOf(day, b).received]).toEqual([0, 60]);
  });
});

describe('renaming, deactivating and deleting', () => {
  test('a rename carries over to the history; a deactivated account keeps it but takes no new payments', async () => {
    const acct = await addAccount({ kind: 'bank', nickname: 'Old Name Bank' });
    const id = (await pay({ amount: 75, paymentMethod: 'upi', paymentAccountId: acct._id, paymentDate: '2026-09-25' })).body.data.payment._id;
    expect((await admin().put(`/api/payment-accounts/${acct._id}`, { nickname: 'New Name Bank' })).status).toBe(200);
    expect((await AccountTransaction.findOne({ sourcePaymentId: id }).lean()).accountName).toBe('New Name Bank');
    expect((await admin().get(`/api/payments/${id}`)).body.data.payment.paymentAccountId.nickname).toBe('New Name Bank');

    expect((await admin().put(`/api/payment-accounts/${acct._id}`, { isActive: false })).status).toBe(200);
    expect((await admin().get('/api/payment-accounts?active=true')).body.data.accounts.map((a) => a._id)).not.toContain(acct._id);
    expect((await pay({ amount: 5, paymentMethod: 'upi', paymentAccountId: acct._id })).body.code).toBe('PAYMENT_ACCOUNT_INACTIVE');
    // Its history still counts, and an existing payment may keep it.
    expect(rowOf(await summary('2026-09-25'), acct)).toMatchObject({ received: 75, isActive: false });
    expect((await admin().put(`/api/payments/${id}`, { notes: 'checked', paymentAccountId: acct._id })).status).toBe(200);

    expect((await admin().delete(`/api/payment-accounts/${acct._id}`)).status).toBe(409);
    expect((await admin().put(`/api/payment-accounts/${acct._id}`, { kind: 'cash' })).status).toBe(409);
  });

  test('an unused account can be deleted, with its opening balance entry', async () => {
    const acct = await addAccount({ kind: 'cash', nickname: 'Spare float', openingBalance: 50, openingDate: '2026-09-01' });
    expect(await AccountTransaction.countDocuments({ paymentAccountId: acct._id })).toBe(1);
    expect((await admin().delete(`/api/payment-accounts/${acct._id}`)).status).toBe(200);
    expect(await AccountTransaction.countDocuments({ paymentAccountId: acct._id })).toBe(0);
  });

  test('changing the opening balance updates its entry; the entry is edited only on the account', async () => {
    const acct = await addAccount({ kind: 'cash', nickname: 'Petty cash', openingBalance: 100, openingDate: '2026-09-01' });
    expect((await admin().put(`/api/payment-accounts/${acct._id}`, { openingBalance: 250 })).status).toBe(200);
    expect(rowOf(await summary('2026-09-01'), acct).opening).toBe(250);
    const entry = await AccountTransaction.findOne({ paymentAccountId: acct._id, transactionType: 'opening_balance' }).lean();
    expect((await admin().delete(`/api/accounts/transactions/${entry._id}`)).status).toBe(409);
  });
});

describe('the Accounts page and dashboard read the same ledger', () => {
  test('collected today uses the same India day as the account collection report', async () => {
    // 18:30 UTC is midnight in India. A receipt just before it belongs to
    // yesterday even when the server itself runs in UTC.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T19:00:00Z'));
    try {
      const before = (await admin().get('/api/dashboard/stats')).body.stats.collectedToday;
      expect((await pay({ amount: 100, paymentMethod: 'cash', paymentAccountId: accounts.cash._id, paymentDate: '2026-11-18T18:00:00Z' })).status).toBe(201);
      expect((await pay({ amount: 300, paymentMethod: 'cash', paymentAccountId: accounts.cash._id, paymentDate: '2026-11-18T18:45:00Z' })).status).toBe(201);
      const after = (await admin().get('/api/dashboard/stats')).body.stats.collectedToday;
      expect(after - before).toBe(300);
      expect(rowOf(await summary('2026-11-19'), accounts.cash).received).toBeGreaterThanOrEqual(300);
    } finally {
      now.mockRestore();
    }
  });

  test('cash and bank balances include the payment accounts', async () => {
    const totals = (await summary(istToday())).byKind;
    const balances = (await admin().get('/api/accounts/balances')).body.data.currentBalances;
    const dash = (await admin().get('/api/dashboard/stats')).body.stats;
    // Every cash entry of this business is on a payment account here.
    expect(balances.cashBalance).toBe(totals.cash.currentBalance);
    expect(dash.cashBalance).toBe(balances.cashBalance);
  });

  test('a business with no accounts records payments as before', async () => {
    const fresh = await createOrg('payaccfresh');
    const c = await make.customer(fresh.admin);
    const res = await as(fresh.tokens.admin).post('/api/payments', { customerId: String(c._id), amount: 40, paymentMethod: 'cash', status: 'completed' });
    expect(res.status).toBe(201);
    expect(await AccountTransaction.findOne({ sourcePaymentId: res.body.data.payment._id }).lean()).toMatchObject({ accountName: 'Cash Account', accountType: 'cash' });
    const s = (await as(fresh.tokens.admin).get(`/api/payment-accounts/summary?from=${istToday()}`)).body.data;
    expect(s.unassigned).toMatchObject({ received: 40, count: 1 });
    expect(s.totals.collected).toBe(40);
  });
});
