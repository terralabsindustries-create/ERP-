/**
 * Paid and unpaid leave in payroll (rules in src/utils/leavePolicy.js):
 * approved unpaid leave is loss of pay, each day counted once even where an
 * absence is also marked, cancelled leave stops counting, and leave types
 * the business has not classified are flagged instead of deducted.
 */
const request = require('supertest');
const app = require('../src/app');
const Employee = require('../src/models/Employee');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const { resolveMonth } = require('../src/utils/leavePolicy');

let org;
const api = () => ({
  get: (url) => request(app).get(url).set(auth(org.tokens.admin)),
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(org.tokens.admin)).send(body)
});

// March 2027: 31 days, so ₹31,000 basic is ₹1,000 a day.
const MONTH = { month: 3, year: 2027 };
let n = 0;
const employee = () => Employee.create({ name: `Printer ${(n += 1)}`, salary: { basic: 31000 }, userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });

async function approvedLeave(emp, fromDate, toDate, leaveType, extra = {}) {
  const created = await api().post('/api/hr/leaves', { employeeId: String(emp._id), fromDate, toDate, leaveType, ...extra });
  expect(created.status).toBe(201);
  const approved = await api().patch(`/api/hr/leaves/${created.body.data.leave._id}/status`, { status: 'approved' });
  expect(approved.status).toBe(200);
  return created.body.data.leave;
}
const mark = (emp, date, status) => api().post('/api/hr/attendance', { employeeId: String(emp._id), date, status });
async function generate(emp) {
  const res = await api().post('/api/hr/payroll/generate', { ...MONTH, employeeId: String(emp._id) });
  expect(res.status).toBe(200);
  return { slip: res.body.data.payslips[0], review: res.body.data.leaveReview };
}

beforeAll(async () => {
  await connectTestDb('payroll_unpaid_leave');
  org = await createOrg('unpaidleave');
});
afterAll(disconnectTestDb);

test('approved unpaid leave is loss of pay; paid leave is not', async () => {
  const unpaid = await employee();
  await approvedLeave(unpaid, '2027-03-10', '2027-03-12', 'unpaid');
  const { slip } = await generate(unpaid);
  expect(slip).toMatchObject({ lopDays: 3, paidDays: 28 });
  expect(slip.deductions.lop).toBe(3000);
  expect(slip.netPay).toBe(28000);

  const casual = await employee();
  await approvedLeave(casual, '2027-03-10', '2027-03-12', 'casual');
  expect((await generate(casual)).slip).toMatchObject({ lopDays: 0, netPay: 31000 });
});

test('an absence marked on an unpaid leave day is not counted twice', async () => {
  const emp = await employee();
  expect((await mark(emp, '2027-03-15', 'absent')).status).toBe(201);
  expect((await mark(emp, '2027-03-16', 'half-day')).status).toBe(201);
  await approvedLeave(emp, '2027-03-15', '2027-03-16', 'unpaid');
  expect((await mark(emp, '2027-03-20', 'absent')).status).toBe(201);
  // 15th and 16th: one day of unpaid leave each; 20th: an absence.
  expect((await generate(emp)).slip.lopDays).toBe(3);
});

test('approved paid leave replaces an absence mark for that day', async () => {
  const emp = await employee();
  await mark(emp, '2027-03-05', 'absent');
  await approvedLeave(emp, '2027-03-05', '2027-03-05', 'sick');
  expect((await generate(emp)).slip.lopDays).toBe(0);
});

test('cancelling unpaid leave removes its loss of pay when payroll is generated again', async () => {
  const emp = await employee();
  const leave = await approvedLeave(emp, '2027-03-22', '2027-03-23', 'unpaid');
  expect((await generate(emp)).slip.lopDays).toBe(2);
  expect((await api().patch(`/api/hr/leaves/${leave._id}/status`, { status: 'cancelled' })).status).toBe(200);
  const { slip } = await generate(emp);
  expect(slip).toMatchObject({ lopDays: 0, netPay: 31000 });
});

test('a paid payslip is not changed by a later leave change', async () => {
  const emp = await employee();
  const leave = await approvedLeave(emp, '2027-03-02', '2027-03-02', 'unpaid');
  const { slip } = await generate(emp);
  expect((await api().patch(`/api/hr/payroll/${slip._id}/pay`, {})).status).toBe(200);
  await api().patch(`/api/hr/leaves/${leave._id}/status`, { status: 'cancelled' });
  const again = await api().post('/api/hr/payroll/generate', { ...MONTH, employeeId: String(emp._id) });
  expect(again.body.data).toMatchObject({ generated: 0, skipped: 1 });
});

test('half-day unpaid leave is half a day of loss of pay', async () => {
  const emp = await employee();
  await approvedLeave(emp, '2027-03-09', '2027-03-09', 'unpaid', { days: 0.5 });
  expect((await generate(emp)).slip.lopDays).toBe(0.5);
});

test('overlapping approved leave is refused, so a day is never on two leaves', async () => {
  const emp = await employee();
  await approvedLeave(emp, '2027-03-10', '2027-03-14', 'unpaid');
  const second = await api().post('/api/hr/leaves', { employeeId: String(emp._id), fromDate: '2027-03-14', toDate: '2027-03-15', leaveType: 'unpaid' });
  const res = await api().patch(`/api/hr/leaves/${second.body.data.leave._id}/status`, { status: 'approved' });
  expect(res.status).toBe(409);
  expect((await generate(emp)).slip.lopDays).toBe(5);
});

test('unclassified leave types are flagged for review, not deducted', async () => {
  const emp = await employee();
  await approvedLeave(emp, '2027-03-01', '2027-03-03', 'other');
  const { slip, review } = await generate(emp);
  expect(slip.lopDays).toBe(0);
  expect(review).toEqual([expect.objectContaining({ employeeName: emp.name, notes: expect.arrayContaining([expect.stringMatching(/other leave — paid or unpaid is not decided/)]) })]);
});

test('unpaid leave over a marked holiday is not deducted for the holiday and is flagged', async () => {
  const emp = await employee();
  await mark(emp, '2027-03-28', 'week-off');
  await approvedLeave(emp, '2027-03-27', '2027-03-29', 'unpaid');
  const { slip, review } = await generate(emp);
  expect(slip.lopDays).toBe(2);
  expect(review[0].notes).toEqual(expect.arrayContaining([expect.stringMatching(/week-off/)]));
});

test('the attendance summary uses the same rules', async () => {
  const emp = await employee();
  await mark(emp, '2027-03-04', 'absent');
  await approvedLeave(emp, '2027-03-04', '2027-03-05', 'unpaid');
  await mark(emp, '2027-03-06', 'present');
  const summary = (await api().get('/api/hr/attendance/summary?month=3&year=2027')).body.data.summary[String(emp._id)];
  expect(summary).toMatchObject({ absent: 0, leave: 2, unpaidLeave: 2, present: 1, paidDays: 1, lopDays: 2 });
});

test('leave requests are validated', async () => {
  const emp = await employee();
  const id = String(emp._id);
  expect((await api().post('/api/hr/leaves', { employeeId: id, fromDate: '2027-03-05', toDate: '2027-03-04' })).status).toBe(400);
  expect((await api().post('/api/hr/leaves', { employeeId: id, fromDate: '2027-03-05', toDate: '2027-03-05', leaveType: 'holiday' })).status).toBe(400);
  expect((await api().post('/api/hr/leaves', { employeeId: id, fromDate: '2027-03-05', toDate: '2027-03-05', days: 3 })).status).toBe(400);
});

describe('resolveMonth', () => {
  const start = new Date(Date.UTC(2027, 2, 1));
  const end = new Date(Date.UTC(2027, 3, 1));
  test('ignores leave that is not approved and leave outside the month', () => {
    const r = resolveMonth({ start, end, leaves: [
      { employeeId: 'e', leaveType: 'unpaid', status: 'cancelled', fromDate: '2027-03-02', toDate: '2027-03-02', days: 1 },
      { employeeId: 'e', leaveType: 'unpaid', status: 'approved', fromDate: '2027-02-27', toDate: '2027-03-02', days: 4 }
    ] });
    expect(r.get('e').lopDays).toBe(2);
  });
  test('never deducts more than the leave request days', () => {
    const r = resolveMonth({ start, end, leaves: [{ employeeId: 'e', leaveType: 'unpaid', status: 'approved', fromDate: '2027-03-02', toDate: '2027-03-04', days: 2.5 }] });
    expect(r.get('e').lopDays).toBe(2.5);
    expect(r.get('e').review.join(' ')).toMatch(/capped at 2.5/);
  });
});
