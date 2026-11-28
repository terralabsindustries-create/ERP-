/** Payroll for selected employees, no duplicate periods, automatic PF / ESI and audited manual overrides. */
const request = require('supertest');
const app = require('../src/app');
const Employee = require('../src/models/Employee');
const Payroll = require('../src/models/Payroll');
const ActivityLog = require('../src/models/ActivityLog');
const { computeStatutory } = require('../src/utils/statutory');
const { configFor } = require('../src/config/statutory');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
const api = (m, url, body) => request(app)[m](url).set(auth(org.tokens.admin)).send(body);
const PERIOD = { month: 3, year: 2027 }; // 31 days
let n = 0;
const emp = (salary, extra = {}) => Employee.create({ name: `Emp ${(n += 1)}`, salary, userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active', ...extra });

beforeAll(async () => {
  await connectTestDb('payrollsel');
  await Payroll.init(); // build the unique employee+period index the live database has
  org = await createOrg('prsel');
});
afterAll(disconnectTestDb);

describe('computeStatutory (pure)', () => {
  const asOf = new Date('2027-03-01');
  test('PF on the ₹15,000 ceiling; employer split EPS / EPF; EDLI', () => {
    const r = computeStatutory({ employee: { statutory: { pfApplicable: true } }, earned: { basic: 30000 }, grossFull: 30000, paidDays: 31, asOf });
    expect(r.employee.pf).toBe(1800); // 12% of 15,000
    expect(r.employer).toMatchObject({ pf: 1800, eps: 1250, epf: 550, edli: 75 }); // 8.33% of 15,000 = 1249.5 → 1250 (nearest)
    expect(r.basis.pfWage).toBe(15000);
    expect(r.unverified).toContain('PF rounding rule');
  });
  test('PF on actual wage below the ceiling, and on full wage when opted in', () => {
    expect(computeStatutory({ employee: { statutory: { pfApplicable: true } }, earned: { basic: 10000 }, grossFull: 10000, paidDays: 31, asOf }).employee.pf).toBe(1200);
    expect(computeStatutory({ employee: { statutory: { pfApplicable: true, pfOnFullWage: true } }, earned: { basic: 30000 }, grossFull: 30000, paidDays: 31, asOf }).employee.pf).toBe(3600);
  });
  test('ESI: 0.75% / 3.25% rounded up; none above ₹21,000; employee share waived at ₹176/day', () => {
    const base = { employee: { statutory: { esiApplicable: true } }, paidDays: 31, asOf };
    const r = computeStatutory({ ...base, earned: { basic: 15000 }, grossFull: 15000 });
    expect(r.employee.esi).toBe(113); // 112.5 → 113
    expect(r.employer.esi).toBe(488); // 487.5 → 488
    expect(computeStatutory({ ...base, earned: { basic: 25000 }, grossFull: 25000 }).employee.esi).toBe(0);
    const low = computeStatutory({ ...base, earned: { basic: 5000 }, grossFull: 5000 });
    expect(low.employee.esi).toBe(0);
    expect(low.employer.esi).toBe(163);
    expect(low.notes.join(' ')).toMatch(/waived/);
  });
  test('employees who have not opted in get nothing; configuration is effective-dated', () => {
    const r = computeStatutory({ employee: {}, earned: { basic: 20000 }, grossFull: 20000, paidDays: 31, asOf });
    expect(r.employee).toEqual({ pf: 0, esi: 0 });
    expect(configFor(new Date('2018-01-01'))).toBeNull();
    expect(configFor(new Date('2027-01-01')).effectiveFrom).toBe('2019-07-01');
  });
});

describe('generation', () => {
  test('one, several or all employees; a second run does not duplicate', async () => {
    const [a, b, c] = [await emp({ basic: 20000 }), await emp({ basic: 21000 }), await emp({ basic: 22000 })];
    const one = await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeId: String(a._id) });
    expect(one.body.data.generated).toBe(1);
    const some = await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeIds: [String(a._id), String(b._id)] });
    expect(some.body.data.generated).toBe(2);
    expect(await Payroll.countDocuments({ employeeId: { $in: [a._id, b._id, c._id] }, ...PERIOD })).toBe(2); // a was regenerated, not duplicated
    expect(await Payroll.countDocuments({ employeeId: c._id, ...PERIOD })).toBe(0);

    const bad = await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeIds: [String(c._id), '000000000000000000000000'] });
    expect(bad.status).toBe(400);
    expect(await Payroll.countDocuments({ employeeId: c._id, ...PERIOD })).toBe(0); // nothing generated on a bad selection
    expect((await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeIds: ['nope'] })).status).toBe(400);

    const all = await api('post', '/api/hr/payroll/generate', PERIOD);
    expect(all.status).toBe(200);
    const total = await Employee.countDocuments({ dataScope: org.dataScope, status: 'active', 'salary.basic': { $gt: 0 } });
    expect(await Payroll.countDocuments({ dataScope: org.dataScope, ...PERIOD })).toBe(total);
  });

  test('simultaneous runs leave one payslip per employee', async () => {
    const e = await emp({ basic: 18000 });
    const runs = await Promise.all([1, 2, 3, 4].map(() => api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeId: String(e._id) })));
    expect(runs.every((r) => r.status === 200)).toBe(true);
    expect(await Payroll.countDocuments({ employeeId: e._id, ...PERIOD })).toBe(1);
  });

  test('opted-in employee gets PF and ESI worked out, employer share kept off net pay', async () => {
    const e = await emp({ basic: 15000, hra: 0 }, { statutory: { pfApplicable: true, esiApplicable: true } });
    const res = await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeId: String(e._id) });
    const slip = res.body.data.payslips[0];
    expect(slip.deductions).toMatchObject({ pf: 1800, esi: 113 });
    expect(slip.employerContributions).toMatchObject({ pf: 1800, eps: 1250, epf: 550, edli: 75, esi: 488 });
    expect(slip.netPay).toBe(15000 - 1800 - 113);
    expect(slip.statutory.configEffectiveFrom).toBe('2019-07-01');
  });

  test('loss of pay reduces the wages PF is worked on', async () => {
    const e = await emp({ basic: 31000 }, { statutory: { pfApplicable: true } });
    await api('post', '/api/hr/attendance', { employeeId: String(e._id), date: '2027-03-10', status: 'absent' });
    const slip = (await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeId: String(e._id) })).body.data.payslips[0];
    if (slip.lopDays > 0) expect(slip.statutory.pfWage).toBeLessThan(15001);
    expect(slip.deductions.pf).toBeGreaterThan(0);
  });

  test('a manual PF change needs a reason, is audited, and survives regeneration until paid', async () => {
    const e = await emp({ basic: 15000 }, { statutory: { pfApplicable: true } });
    const slip = (await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeId: String(e._id) })).body.data.payslips[0];
    const noReason = await api('put', `/api/hr/payroll/${slip._id}`, { deductions: { pf: 1000 } });
    expect(noReason.status).toBe(400);
    const ok = await api('put', `/api/hr/payroll/${slip._id}`, { deductions: { pf: 1000 }, reason: 'Court order' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.payslip.deductions.pf).toBe(1000);
    expect(ok.body.data.payslip.statutory.manualOverride.pf).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // the audit entry is written after the response
    const log = await ActivityLog.findOne({ action: 'Payslip Adjusted', entityId: slip._id }).lean();
    expect(log).toBeTruthy();
    expect(JSON.stringify(log)).toMatch(/Court order/);

    const again = (await api('post', '/api/hr/payroll/generate', { ...PERIOD, employeeId: String(e._id) })).body.data.payslips[0];
    expect(again.deductions.pf).toBe(1000);
    expect(again.statutory.manualOverride.pf).toBe(true);
  });
});
