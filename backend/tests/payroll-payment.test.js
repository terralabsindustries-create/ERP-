/**
 * "Mark paid" and its salary expense in Accounts happen together and once:
 * a failed expense write leaves the payslip unpaid, and retries or
 * concurrent requests never record a second expense.
 */
const request = require('supertest');
const app = require('../src/app');
const Employee = require('../src/models/Employee');
const Payroll = require('../src/models/Payroll');
const AccountTransaction = require('../src/models/AccountTransaction');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
const api = () => ({
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body),
  put: (url, body) => request(app).put(url).set(auth(org.tokens.admin)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(org.tokens.admin)).send(body),
  delete: (url) => request(app).delete(url).set(auth(org.tokens.admin))
});

let n = 0;
/** A generated payslip for a new employee, for its own month so tests do not share one. */
async function payslip(basic = 30000) {
  n += 1;
  const employee = await Employee.create({ name: `Operator ${n}`, salary: { basic }, userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
  const res = await api().post('/api/hr/payroll/generate', { month: ((n - 1) % 12) + 1, year: 2030 + Math.floor((n - 1) / 12), employeeId: String(employee._id) });
  expect(res.status).toBe(200);
  return res.body.data.payslips[0];
}
const expenses = (slip) => AccountTransaction.find({ sourcePayrollId: slip._id }).lean();
const status = async (slip) => (await Payroll.findById(slip._id).lean()).status;

beforeAll(async () => {
  await connectTestDb('payroll_payment');
  org = await createOrg('payrollpay');
  // The one-expense-per-payslip rule is a unique index; build it before racing.
  await AccountTransaction.syncIndexes();
});
afterAll(disconnectTestDb);

test('marking paid records one expense dated the payment day', async () => {
  const slip = await payslip();
  const res = await api().patch(`/api/hr/payroll/${slip._id}/pay`, { paymentMethod: 'cash', paidDate: '2030-01-31' });
  expect(res.status).toBe(200);
  expect(res.body.data.payslip.status).toBe('paid');
  const [expense, ...more] = await expenses(slip);
  expect(more).toHaveLength(0);
  expect(expense).toMatchObject({ transactionType: 'expense', category: 'Salaries', amount: slip.netPay, accountType: 'cash', status: 'completed', dataScope: org.dataScope });
  expect(expense.postedAt.toISOString().slice(0, 10)).toBe('2030-01-31');
});

test('a retry of a paid payslip records nothing more', async () => {
  const slip = await payslip();
  expect((await api().patch(`/api/hr/payroll/${slip._id}/pay`, {})).status).toBe(200);
  const again = await api().patch(`/api/hr/payroll/${slip._id}/pay`, {});
  expect(again.status).toBe(200);
  expect(again.body.data.alreadyPaid).toBe(true);
  expect(await expenses(slip)).toHaveLength(1);
});

test('concurrent requests pay once and record one expense', async () => {
  const slip = await payslip();
  const results = await Promise.all(Array.from({ length: 5 }, () => api().patch(`/api/hr/payroll/${slip._id}/pay`, { paymentMethod: 'upi' })));
  expect(results.every((r) => r.status === 200)).toBe(true);
  expect(results.filter((r) => !r.body.data.alreadyPaid)).toHaveLength(1);
  expect(await expenses(slip)).toHaveLength(1);
  expect(await status(slip)).toBe('paid');
});

test('a failed expense write leaves the payslip unpaid, and a retry then pays it once', async () => {
  const slip = await payslip();
  const spy = jest.spyOn(AccountTransaction, 'create').mockRejectedValueOnce(new Error('disk full'));
  try {
    const res = await api().patch(`/api/hr/payroll/${slip._id}/pay`, {});
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/not marked paid/);
  } finally {
    spy.mockRestore();
  }
  expect(await status(slip)).toBe('generated');
  expect((await Payroll.findById(slip._id).lean()).paidDate).toBeUndefined();
  expect(await expenses(slip)).toHaveLength(0);

  expect((await api().patch(`/api/hr/payroll/${slip._id}/pay`, {})).status).toBe(200);
  expect(await expenses(slip)).toHaveLength(1);
});

test('an expense left behind by a failed undo is reused, not doubled', async () => {
  const slip = await payslip();
  await AccountTransaction.create({
    transactionType: 'expense', category: 'Salaries', amount: 1, description: 'left over', paymentMethod: 'cash',
    accountType: 'cash', accountName: 'Payroll', status: 'completed', sourcePayrollId: slip._id, userId: org.admin._id, dataScope: org.dataScope
  });
  expect((await api().patch(`/api/hr/payroll/${slip._id}/pay`, {})).status).toBe(200);
  const list = await expenses(slip);
  expect(list).toHaveLength(1);
  expect(list[0].amount).toBe(slip.netPay);
});

test('a paid payslip cannot be edited or regenerated, and its expense is locked in Accounts', async () => {
  const slip = await payslip();
  expect((await api().patch(`/api/hr/payroll/${slip._id}/pay`, {})).status).toBe(200);
  expect((await api().put(`/api/hr/payroll/${slip._id}`, { earnings: { bonus: 5000 } })).status).toBe(400);
  const [expense] = await expenses(slip);
  const edit = await request(app).put(`/api/accounts/transactions/${expense._id}`).set(auth(org.tokens.admin)).send({
    transactionType: 'expense', category: 'Salaries', amount: 1, description: 'x', paymentMethod: 'cash', accountType: 'cash', accountName: 'Payroll'
  });
  expect(edit.status).toBe(409);
  expect((await request(app).delete(`/api/accounts/transactions/${expense._id}`).set(auth(org.tokens.admin))).status).toBe(409);
  expect(await expenses(slip)).toHaveLength(1);
});

test('an edit that races payment cannot change what was paid', async () => {
  const slip = await payslip();
  const stale = await Payroll.findById(slip._id).lean();
  expect((await api().patch(`/api/hr/payroll/${slip._id}/pay`, {})).status).toBe(200);
  // The edit was read before the payment: its conditional write misses.
  const write = await Payroll.findOneAndUpdate({ _id: slip._id, status: { $ne: 'paid' }, updatedAt: stale.updatedAt }, { $set: { netPay: 1 } });
  expect(write).toBeNull();
  const [expense] = await expenses(slip);
  expect(expense.amount).toBe((await Payroll.findById(slip._id).lean()).netPay);
});
