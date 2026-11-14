const request = require('supertest');
const app = require('../src/app');
const Employee = require('../src/models/Employee');
const Attendance = require('../src/models/Attendance');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
const api = () => ({
  get: (path) => request(app).get(path).set(auth(org.tokens.admin)),
  post: (path, body) => request(app).post(path).set(auth(org.tokens.admin)).send(body),
  patch: (path, body) => request(app).patch(path).set(auth(org.tokens.admin)).send(body)
});

beforeAll(async () => {
  await connectTestDb('attendance-approved-leave');
  org = await createOrg('attendance-leave');
});
afterAll(disconnectTestDb);

test('approved leave overrides an old present mark and reverts when cancelled', async () => {
  const employee = await Employee.create({ name: 'Jyothish', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
  const id = String(employee._id);
  const day = '2026-11-14';
  expect((await api().post('/api/hr/attendance/bulk', { date: day, records: [{ employeeId: id, status: 'present' }] })).status).toBe(200);
  const created = await api().post('/api/hr/leaves', { employeeId: id, fromDate: day, toDate: day, leaveType: 'casual' });
  expect(created.status).toBe(201);
  const leaveId = created.body.data.leave._id;
  expect((await api().patch(`/api/hr/leaves/${leaveId}/status`, { status: 'approved' })).status).toBe(200);

  const attendance = await api().get(`/api/hr/attendance?date=${day}`);
  expect(attendance.body.data.approvedLeaveEmployeeIds).toContain(id);
  expect(attendance.body.data.attendance.find((row) => String(row.employeeId?._id || row.employeeId) === id).status).toBe('leave');
  const summary = await api().get('/api/hr/attendance/summary?month=11&year=2026');
  expect(summary.body.data.summary[id]).toMatchObject({ present: 0, leave: 1 });
  expect((await api().post('/api/hr/attendance/bulk', { date: day, records: [{ employeeId: id, status: 'present' }] })).status).toBe(409);
  expect((await api().post('/api/hr/attendance', { date: day, employeeId: id, status: 'present' })).status).toBe(409);

  expect((await api().patch(`/api/hr/leaves/${leaveId}/status`, { status: 'cancelled' })).status).toBe(200);
  const after = await api().get(`/api/hr/attendance?date=${day}`);
  expect(after.body.data.approvedLeaveEmployeeIds).not.toContain(id);
  expect(after.body.data.attendance.find((row) => String(row.employeeId?._id || row.employeeId) === id).status).toBe('present');
});

test('approved leave appears even before attendance is saved, without leaving a stale mark', async () => {
  const employee = await Employee.create({ name: 'No mark yet', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
  const id = String(employee._id);
  const day = '2026-11-16';
  const created = await api().post('/api/hr/leaves', { employeeId: id, fromDate: day, toDate: day });
  const leaveId = created.body.data.leave._id;
  await api().patch(`/api/hr/leaves/${leaveId}/status`, { status: 'approved' });

  const attendance = await api().get(`/api/hr/attendance?date=${day}`);
  expect(attendance.body.data.attendance).toEqual(expect.arrayContaining([expect.objectContaining({ employeeId: id, status: 'leave', fromApprovedLeave: true })]));
  expect((await api().get('/api/hr/attendance/summary?month=11&year=2026')).body.data.summary[id]).toMatchObject({ leave: 1 });
  expect((await api().post('/api/hr/attendance/bulk', { date: day, records: [{ employeeId: id, status: 'leave' }] })).status).toBe(200);
  expect(await Attendance.exists({ employeeId: id, date: new Date(`${day}T00:00:00.000Z`) })).toBeNull();

  await api().patch(`/api/hr/leaves/${leaveId}/status`, { status: 'cancelled' });
  expect((await api().get(`/api/hr/attendance?date=${day}`)).body.data.attendance).not.toEqual(expect.arrayContaining([expect.objectContaining({ employeeId: id, status: 'leave' })]));
});
