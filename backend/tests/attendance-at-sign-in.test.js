const request = require('supertest');
const app = require('../src/app');
const Employee = require('../src/models/Employee');
const Attendance = require('../src/models/Attendance');
const LeaveRequest = require('../src/models/LeaveRequest');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const { markPresentOnLogin, markCheckOutOnLogout, businessClock, hoursBetween, resetMemo } = require('../src/utils/autoAttendance');

let org;
let other;

const employeeFor = (o, user, extra = {}) =>
  Employee.create({ name: user.fullName, email: user.email, linkedUserId: user._id, userId: o.admin._id, createdBy: o.admin._id, dataScope: o.dataScope, status: 'active', ...extra });

const today = () => businessClock().day;
const recordOf = (employee) => Attendance.findOne({ employeeId: employee._id, date: today() }).lean();

beforeAll(async () => {
  await connectTestDb('attendance-at-sign-in');
  org = await createOrg('autoatt');
  other = await createOrg('autoatt-other');
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  resetMemo();
  await Attendance.deleteMany({});
  await Employee.deleteMany({});
  await LeaveRequest.deleteMany({});
});

describe('business clock', () => {
  test('uses the Indian calendar day, not the UTC one', () => {
    // 20:00 UTC on 25 Nov is 01:30 on 26 Nov in India.
    const { day, time } = businessClock(new Date('2026-11-25T20:00:00Z'));
    expect(day.toISOString()).toBe('2026-11-26T00:00:00.000Z');
    expect(time).toBe('01:30');
  });

  test('works out the hours between check-in and check-out', () => {
    expect(hoursBetween('09:15', '18:45')).toBe(9.5);
    expect(hoursBetween('18:00', '09:00')).toBe(0);
    expect(hoursBetween(undefined, '09:00')).toBe(0);
  });
});

describe('signing in marks attendance', () => {
  test('a password login marks the linked employee present with the check-in time', async () => {
    const employee = await employeeFor(org, org.staff1);
    const res = await request(app).post('/api/auth/login').send({ email: org.staff1.email, password: 'Passw0rd!' });
    expect(res.status).toBe(200);

    const record = await recordOf(employee);
    expect(record).toMatchObject({ status: 'present', source: 'login', dataScope: org.dataScope });
    expect(record.checkIn).toMatch(/^\d{2}:\d{2}$/);
    expect(String(record.userId)).toBe(String(org.admin._id));

    // HR sees it in the register for today.
    const day = today().toISOString().slice(0, 10);
    const list = await request(app).get(`/api/hr/attendance?date=${day}`).set(auth(org.tokens.admin));
    expect(list.body.data.attendance).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'present', source: 'login' })]));
  });

  test('opening the app with a session from yesterday counts as today\'s sign-in', async () => {
    const employee = await employeeFor(org, org.staff2);
    const res = await request(app).get('/api/auth/me').set(auth(org.tokens.staff2));
    expect(res.status).toBe(200);
    expect(await recordOf(employee)).toMatchObject({ status: 'present', source: 'login' });
  });

  test('signing in again keeps one record and the first check-in time', async () => {
    const employee = await employeeFor(org, org.staff1);
    const morning = new Date();
    await markPresentOnLogin(org.staff1, morning);
    resetMemo();
    const later = new Date(morning.getTime() + 60 * 1000);
    await Promise.all([markPresentOnLogin(org.staff1, later), markPresentOnLogin(org.staff1, later)]);

    const records = await Attendance.find({ employeeId: employee._id });
    expect(records).toHaveLength(1);
    expect(records[0].checkIn).toBe(businessClock(morning).time);
  });

  test('never changes a day HR has already marked', async () => {
    const employee = await employeeFor(org, org.staff1);
    const day = today().toISOString().slice(0, 10);
    await request(app).post('/api/hr/attendance/bulk').set(auth(org.tokens.admin))
      .send({ date: day, records: [{ employeeId: String(employee._id), status: 'half-day' }] });

    expect(await markPresentOnLogin(org.staff1)).toBe('exists');
    expect(await recordOf(employee)).toMatchObject({ status: 'half-day', source: 'manual' });
  });

  test('does not mark someone on approved leave', async () => {
    const employee = await employeeFor(org, org.staff1);
    await LeaveRequest.create({
      employeeId: employee._id, leaveType: 'casual', fromDate: today(), toDate: today(), days: 1, reason: 'Wedding',
      status: 'approved', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope
    });
    expect(await markPresentOnLogin(org.staff1)).toBe('leave');
    expect(await recordOf(employee)).toBeNull();
  });

  test('skips logins with no employee row, and inactive employees', async () => {
    expect(await markPresentOnLogin(org.manager)).toBe('no-employee');
    const employee = await employeeFor(org, org.staff1, { status: 'inactive' });
    expect(await markPresentOnLogin(org.staff1)).toBe('no-employee');
    expect(await recordOf(employee)).toBeNull();
  });

  test('only uses the employee row of the login\'s own business', async () => {
    // Same login id linked from another business's employee (bad data) must not be marked.
    const foreign = await employeeFor(other, org.staff1);
    expect(await markPresentOnLogin(org.staff1)).toBe('no-employee');
    expect(await recordOf(foreign)).toBeNull();
  });

  test('a failed sign-in marks nothing', async () => {
    const employee = await employeeFor(org, org.staff1);
    const res = await request(app).post('/api/auth/login').send({ email: org.staff1.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(await recordOf(employee)).toBeNull();
  });
});

describe('signing out records the check-out', () => {
  test('logout sets the check-out time and hours worked', async () => {
    const employee = await employeeFor(org, org.staff1);
    const { day } = businessClock();
    await Attendance.create({
      employeeId: employee._id, date: day, status: 'present', checkIn: '00:00', source: 'login',
      createdBy: org.staff1._id, userId: org.admin._id, dataScope: org.dataScope
    });

    const res = await request(app).post('/api/auth/logout').set(auth(org.tokens.staff1));
    expect(res.status).toBe(200);
    const record = await recordOf(employee);
    expect(record.checkOut).toBe(businessClock().time);
    expect(record.workHours).toBe(hoursBetween('00:00', record.checkOut));
  });

  test('logout leaves absent days and days without a check-in alone', async () => {
    const employee = await employeeFor(org, org.staff1);
    await Attendance.create({
      employeeId: employee._id, date: today(), status: 'absent', source: 'manual',
      createdBy: org.admin._id, userId: org.admin._id, dataScope: org.dataScope
    });
    expect(await markCheckOutOnLogout(org.staff1)).toBe('no-record');
    expect((await recordOf(employee)).checkOut).toBeUndefined();
  });
});
