const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Employee = require('../src/models/Employee');
const Vendor = require('../src/models/Vendor');
const AccountTransaction = require('../src/models/AccountTransaction');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a;
let b;
const entry = (extra = {}) => ({
  transactionType: 'expense', category: 'materials', amount: 100,
  description: 'Paper', paymentMethod: 'cash', accountType: 'cash', accountName: 'Main Cash',
  ...extra
});

beforeAll(async () => {
  await connectTestDb('account_staff_scope');
  a = await createOrg('account_a');
  b = await createOrg('account_b');
});
afterAll(disconnectTestDb);

test('an account entry cannot reference another business record', async () => {
  const foreign = await make.customer(b.admin, { name: 'Private B Customer' });
  const vendor = await Vendor.create({ name: 'Private B Supplier', vendorType: 'Supplier', userId: b.admin._id, createdBy: b.admin._id, dataScope: b.dataScope });
  const job = await make.job(b.admin, foreign, { title: 'Private B Job' });
  const invoice = await make.invoice(b.admin, foreign, { invoiceNumber: 'B-PRIVATE-ACCOUNT-REF' });
  for (const [field, id] of Object.entries({ customerId: foreign._id, vendorId: vendor._id, jobId: job._id, invoiceId: invoice._id })) {
    const res = await request(app).post('/api/accounts/transactions').set(auth(a.tokens.admin))
      .send(entry({ [field]: String(id) }));
    expect([field, res.status]).toEqual([field, 400]);
    expect(JSON.stringify(res.body)).not.toMatch(/Private B|B-PRIVATE/);
    expect(await AccountTransaction.countDocuments({ [field]: id })).toBe(0);
  }
});

test('older account entries with foreign references do not populate foreign names', async () => {
  const foreign = await make.customer(b.admin, { name: 'Never Show B Customer' });
  const old = await AccountTransaction.create({ ...entry(), userId: a.admin._id, customerId: foreign._id });
  const list = await request(app).get('/api/accounts/transactions?limit=100').set(auth(a.tokens.admin));
  expect(list.status).toBe(200);
  const shown = list.body.data.transactions.find((row) => row._id === String(old._id));
  expect(shown).toBeTruthy();
  expect(shown.customerId).toBeNull();
  expect(JSON.stringify(list.body)).not.toMatch(/Never Show B Customer/);
});

test('a zero amount cannot be introduced by editing an account entry', async () => {
  const created = await request(app).post('/api/accounts/transactions').set(auth(a.tokens.admin)).send(entry());
  expect(created.status).toBe(201);
  const id = created.body.data.transaction._id;
  const res = await request(app).put(`/api/accounts/transactions/${id}`).set(auth(a.tokens.admin)).send(entry({ amount: 0 }));
  expect(res.status).toBe(400);
  expect((await AccountTransaction.findById(id)).amount).toBe(100);
});

test('account editors cannot set ownership, numbering or reconciliation state', async () => {
  const created = await request(app).post('/api/accounts/transactions').set(auth(a.tokens.admin))
    .send(entry({ userId: String(b.admin._id), transactionNumber: 'FORGED', reconciled: true }));
  expect(created.status).toBe(201);
  const id = created.body.data.transaction._id;
  let saved = await AccountTransaction.findById(id);
  expect(String(saved.userId)).toBe(String(a.admin._id));
  expect(saved.transactionNumber).not.toBe('FORGED');
  expect(saved.reconciled).toBe(false);

  const changed = await request(app).put(`/api/accounts/transactions/${id}`).set(auth(a.tokens.admin))
    .send(entry({ userId: String(b.admin._id), transactionNumber: 'FORGED', reconciled: true }));
  expect(changed.status).toBe(200);
  saved = await AccountTransaction.findById(id);
  expect(String(saved.userId)).toBe(String(a.admin._id));
  expect(saved.transactionNumber).not.toBe('FORGED');
  expect(saved.reconciled).toBe(false);
});

test('profit and loss uses the posted date of a backdated entry', async () => {
  const before = await request(app).get('/api/accounts/reports/summary?period=month').set(auth(a.tokens.admin));
  expect(before.status).toBe(200);
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1, 15);
  const postedAt = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-15`;
  const res = await request(app).post('/api/accounts/transactions').set(auth(a.tokens.admin))
    .send(entry({ amount: 77, postedAt, description: 'Prior month expense' }));
  expect(res.status).toBe(201);
  const report = await request(app).get('/api/accounts/reports/summary?period=month').set(auth(a.tokens.admin));
  expect(report.status).toBe(200);
  expect(report.body.data.report.totalExpenses).toBe(before.body.data.report.totalExpenses);
  const ledger = await request(app).get(`/api/accounts/ledger?startDate=${encodeURIComponent(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())}`)
    .set(auth(a.tokens.admin));
  expect(ledger.status).toBe(200);
  expect(ledger.body.data.transactions.map((t) => t._id)).not.toContain(res.body.data.transaction._id);
});

test('HR edit responses hide salary unless the login may view it', async () => {
  await User.updateOne({ _id: a.staff1._id }, { permissions: ['Dashboard', 'Human Resources', 'Human Resources: View', 'Human Resources: Create & Edit'] });
  const employee = await Employee.create({
    name: 'Press Operator', salary: { basic: 25000 }, userId: a.admin._id,
    createdBy: a.admin._id, dataScope: a.dataScope, status: 'active'
  });
  const res = await request(app).put(`/api/hr/employees/${employee._id}`).set(auth(a.tokens.staff1))
    .send({ designation: 'Printer', salary: { basic: 1 } });
  expect(res.status).toBe(200);
  expect(res.body.data.employee.salary).toBeUndefined();
  expect(res.body.data.employee.netSalary).toBeUndefined();
  expect((await Employee.findById(employee._id)).salary.basic).toBe(25000);
});

test('staff without module access cannot read accounts, employees or payroll', async () => {
  await User.updateOne({ _id: a.staff1._id }, { permissions: ['Dashboard'] });
  for (const path of ['/api/accounts/transactions', '/api/accounts/balances', '/api/accounts/reconciliation', '/api/hr/employees', '/api/hr/payroll']) {
    const res = await request(app).get(path).set(auth(a.tokens.staff1));
    expect([path, res.status]).toEqual([path, 403]);
  }
});

test('payroll viewers cannot generate or mark payslips paid', async () => {
  await User.updateOne({ _id: a.staff1._id }, { permissions: ['Dashboard', 'Payroll', 'Payroll: View'] });
  const list = await request(app).get('/api/hr/payroll').set(auth(a.tokens.staff1));
  expect(list.status).toBe(200);
  const generated = await request(app).post('/api/hr/payroll/generate').set(auth(a.tokens.staff1)).send({ month: 1, year: 2026 });
  expect(generated.status).toBe(403);
});

test('attendance-only staff can list names without employee private details', async () => {
  await User.updateOne({ _id: a.staff1._id }, { permissions: ['Dashboard', 'Attendance', 'Attendance: View'] });
  const employee = await Employee.create({
    name: 'Attendance Operator', email: 'private@example.com', salary: { basic: 20000 },
    userId: a.admin._id, createdBy: a.admin._id, dataScope: a.dataScope, status: 'active'
  });
  const list = await request(app).get('/api/hr/employees').set(auth(a.tokens.staff1));
  expect(list.status).toBe(200);
  const shown = list.body.data.employees.find((e) => e._id === String(employee._id));
  expect(shown.name).toBe('Attendance Operator');
  expect(shown.email).toBeUndefined();
  expect(shown.salary).toBeUndefined();
  const detail = await request(app).get(`/api/hr/employees/${employee._id}`).set(auth(a.tokens.staff1));
  expect(detail.status).toBe(403);
});

test('a paid payslip cannot be deleted while its salary expense remains in Accounts', async () => {
  await Employee.create({
    name: 'Paid Operator', salary: { basic: 20000 }, userId: a.admin._id,
    createdBy: a.admin._id, dataScope: a.dataScope, status: 'active'
  });
  const generated = await request(app).post('/api/hr/payroll/generate').set(auth(a.tokens.admin)).send({ month: 1, year: 2026 });
  expect(generated.status).toBe(200);
  const payslip = generated.body.data.payslips.find((p) => p.employeeName === 'Paid Operator');
  const paid = await request(app).patch(`/api/hr/payroll/${payslip._id}/pay`).set(auth(a.tokens.admin)).send({ paymentMethod: 'cash' });
  expect(paid.status).toBe(200);
  const expenses = await AccountTransaction.countDocuments({ userId: a.admin._id, category: 'Salaries' });
  expect(expenses).toBe(1);
  const removed = await request(app).delete(`/api/hr/payroll/${payslip._id}`).set(auth(a.tokens.admin));
  expect(removed.status).toBe(409);
  expect(await AccountTransaction.countDocuments({ userId: a.admin._id, category: 'Salaries' })).toBe(1);
});

test('the owner keeps historical account entries after deleting the staff login that recorded them', async () => {
  await User.updateOne({ _id: a.staff2._id }, { permissions: ['Dashboard', 'Accounts', 'Accounts: View', 'Accounts: Create & Edit'] });
  const created = await request(app).post('/api/accounts/transactions').set(auth(a.tokens.staff2))
    .send(entry({ description: 'Recorded by staff before removal' }));
  expect(created.status).toBe(201);
  const id = created.body.data.transaction._id;
  const removed = await request(app).delete(`/api/users/${a.staff2._id}`).set(auth(a.tokens.admin));
  expect(removed.status).toBe(200);
  const ledger = await request(app).get('/api/accounts/transactions?limit=100').set(auth(a.tokens.admin));
  expect(ledger.status).toBe(200);
  expect(ledger.body.data.transactions.map((t) => t._id)).toContain(id);
});
