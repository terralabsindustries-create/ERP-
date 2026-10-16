/**
 * Team workload and evaluation figures are counts of real records, and the
 * records behind each person's numbers can be listed.
 */
const request = require('supertest');
const app = require('../src/app');
const ActivityLog = require('../src/models/ActivityLog');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

const DAY = 864e5;
let org;

beforeAll(async () => {
  await connectTestDb('team');
  org = await createOrg('w');
  const now = Date.now();
  const staff = org.staff1;
  // Completed on time, completed two days late, completed with no due date.
  await make.task(org.admin, staff, { title: 'On time', status: 'completed', dueDate: new Date(now - 3 * DAY), completedAt: new Date(now - 4 * DAY) });
  await make.task(org.admin, staff, { title: 'Late', status: 'completed', dueDate: new Date(now - 5 * DAY), completedAt: new Date(now - 3 * DAY + 3600e3) });
  await make.task(org.admin, staff, { title: 'No due date', status: 'completed', completedAt: new Date(now - DAY) });
  // Completed long before the period: not counted.
  await make.task(org.admin, staff, { title: 'Old', status: 'completed', dueDate: new Date(now - 80 * DAY), completedAt: new Date(now - 60 * DAY) });
  // Open work: overdue, blocked, due soon.
  await make.task(org.admin, staff, { title: 'Overdue', status: 'in_progress', dueDate: new Date(now - DAY) });
  await make.task(org.admin, staff, { title: 'Blocked', status: 'on_hold', dueDate: new Date(now + 10 * DAY), notes: 'Waiting on paper delivery' });
  await make.task(org.admin, staff, { title: 'Soon', status: 'pending', dueDate: new Date(now + DAY) });
  await ActivityLog.create({
    action: 'Task Status Changed', description: 'x', entityType: 'task', entityId: org.admin._id, performedBy: staff._id,
    performedByName: staff.fullName, actionType: 'update', userId: staff._id, dataScope: org.dataScope
  });
});
afterAll(disconnectTestDb);

test('staff cannot open the team overview or another member\'s records', async () => {
  expect((await request(app).get('/api/team/overview').set(auth(org.tokens.staff1))).status).toBe(403);
  expect((await request(app).get(`/api/team/members/${org.staff2._id}`).set(auth(org.tokens.staff1))).status).toBe(403);
});

test('per-person counts match the records', async () => {
  const res = await request(app).get('/api/team/overview?days=30').set(auth(org.tokens.manager));
  expect(res.status).toBe(200);
  const me = res.body.data.members.find((m) => m.user._id === String(org.staff1._id));
  expect(me.tasks).toEqual({
    open: 3,
    inProgress: 1,
    onHold: 1,
    overdue: 1,
    dueSoon: 1,
    completed: 3,
    onTime: 1,
    late: 1,
    noDueDate: 1,
    avgDaysLate: 2
  });
  expect(me.activity.count).toBe(1);
  expect(res.body.data.blocked.map((t) => [t.title, t.assignee.fullName, t.notes])).toEqual([['Blocked', org.staff1.fullName, 'Waiting on paper delivery']]);
  expect(res.body.data.overdue.map((t) => t.title)).toEqual(['Overdue']);
});

test('the member view lists the tasks behind the numbers, with timeliness per task', async () => {
  const res = await request(app).get(`/api/team/members/${org.staff1._id}?days=30`).set(auth(org.tokens.admin));
  expect(res.status).toBe(200);
  const byTitle = Object.fromEntries(res.body.data.tasks.map((t) => [t.title, t]));
  expect(byTitle['On time'].timeliness).toEqual({ result: 'on_time' });
  expect(byTitle.Late.timeliness).toEqual({ result: 'late', daysLate: 2 });
  expect(byTitle['No due date'].timeliness).toEqual({ result: 'no_due_date' });
  expect(byTitle.Old).toBeUndefined();
  expect(byTitle.Blocked.assigner.fullName).toBe(org.admin.fullName);
});
