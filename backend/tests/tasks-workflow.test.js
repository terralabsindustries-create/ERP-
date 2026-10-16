/**
 * Work handed from a manager to staff and back: assignment, who can see and
 * change what, comments, status updates, the hand-off trail and the
 * notifications each step sends.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Task = require('../src/models/Task');
const Notification = require('../src/models/Notification');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
beforeAll(async () => {
  await connectTestDb('tasks');
  org = await createOrg('t', {
    staffPermissions: ['Dashboard'],
    // The manager hands out work but does not see every staff record.
    managerPermissions: ['Dashboard', 'Staff & Tasks', 'Staff & Tasks: View', 'Staff & Tasks: Assign Tasks']
  });
  await User.updateOne({ _id: org.manager._id }, { canViewAllData: false });
});
afterAll(disconnectTestDb);

const as = (who) => ({
  get: (url) => request(app).get(url).set(auth(org.tokens[who])),
  post: (url, body) => request(app).post(url).set(auth(org.tokens[who])).send(body),
  put: (url, body) => request(app).put(url).set(auth(org.tokens[who])).send(body),
  delete: (url) => request(app).delete(url).set(auth(org.tokens[who]))
});

const notificationsFor = (user) => Notification.find({ recipient: user._id }).sort({ createdAt: 1 }).lean();

describe('assigning work', () => {
  let taskId;

  test('a manager with Assign Tasks assigns a task to a staff member, who is notified', async () => {
    const due = new Date(Date.now() + 2 * 864e5).toISOString();
    const res = await as('manager').post('/api/tasks', { title: 'Approve proof for Lotus brochure', assignedTo: String(org.staff1._id), dueDate: due, priority: 'high' });
    expect(res.status).toBe(201);
    taskId = res.body.data._id;
    expect(res.body.data.assignedTo.fullName).toBe(org.staff1.fullName);
    expect(res.body.data.userId.fullName).toBe(org.manager.fullName);

    const notes = await notificationsFor(org.staff1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'task_assigned', actorName: org.manager.fullName, link: `/tasks/${taskId}` });
  });

  test('staff without Assign Tasks cannot hand out work', async () => {
    const res = await as('staff1').post('/api/tasks', { title: 'Self-made task', assignedTo: String(org.staff2._id) });
    expect(res.status).toBe(403);
  });

  test('the assignee sees it; another staff member does not, by list, id or search', async () => {
    expect((await as('staff1').get('/api/tasks')).body.data.map((t) => t._id)).toContain(taskId);
    expect((await as('staff1').get(`/api/tasks/by-staff/${org.staff1._id}`)).body.data.map((t) => t._id)).toContain(taskId);

    expect((await as('staff2').get('/api/tasks')).body.data).toHaveLength(0);
    expect((await as('staff2').get('/api/tasks?search=Lotus')).body.data).toHaveLength(0);
    expect((await as('staff2').get(`/api/tasks/${taskId}`)).status).toBe(404);
    expect((await as('staff2').get(`/api/tasks/by-staff/${org.staff1._id}`)).body.data).toHaveLength(0);
  });

  test('another staff member cannot change, comment on or delete it', async () => {
    expect((await as('staff2').put(`/api/tasks/${taskId}/status`, { status: 'completed' })).status).toBe(404);
    expect((await as('staff2').post(`/api/tasks/${taskId}/comments`, { text: 'not mine' })).status).toBe(404);
    expect((await as('staff2').put(`/api/tasks/${taskId}`, { title: 'x', assignedTo: String(org.staff2._id) })).status).toBe(404);
    expect((await as('staff2').delete(`/api/tasks/${taskId}`)).status).toBe(404);
    expect((await Task.findById(taskId)).status).toBe('pending');
  });

  test('the assignee cannot edit, reassign, cancel or delete it', async () => {
    expect((await as('staff1').put(`/api/tasks/${taskId}`, { title: 'Renamed', assignedTo: String(org.staff2._id) })).status).toBe(403);
    expect((await as('staff1').put(`/api/tasks/${taskId}/status`, { status: 'cancelled' })).status).toBe(403);
    expect((await as('staff1').delete(`/api/tasks/${taskId}`)).status).toBe(403);
  });

  test('the assignee comments; the manager is notified with author and task', async () => {
    const res = await as('staff1').post(`/api/tasks/${taskId}/comments`, { text: 'Customer wants the logo bigger — waiting on new artwork.' });
    expect(res.status).toBe(200);
    const comment = res.body.data.comments.at(-1);
    expect(comment.authorName).toBe(org.staff1.fullName);
    expect(comment.author.fullName).toBe(org.staff1.fullName);
    expect(new Date(comment.createdAt).getTime()).toBeGreaterThan(0);

    const note = (await notificationsFor(org.manager)).find((n) => n.type === 'task_comment');
    expect(note).toMatchObject({ entityType: 'task', actorName: org.staff1.fullName });
    expect(String(note.entityId)).toBe(taskId);
  });

  test('the assignee puts it on hold and then completes it; each step reaches the manager', async () => {
    await as('staff1').put(`/api/tasks/${taskId}/status`, { status: 'on_hold', notes: 'Waiting on artwork' });
    const done = await as('staff1').put(`/api/tasks/${taskId}/status`, { status: 'completed' });
    expect(done.status).toBe(200);

    const task = await Task.findById(taskId);
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.history.map((h) => [h.type, h.to])).toEqual([
      ['created', org.staff1.fullName],
      ['status', 'on_hold'],
      ['status', 'completed']
    ]);
    expect(task.history[1].note).toBe('Waiting on artwork');
    expect(task.history[2].byName).toBe(org.staff1.fullName);

    const statusNotes = (await notificationsFor(org.manager)).filter((n) => n.type === 'task_status');
    expect(statusNotes.map((n) => n.title)).toEqual([expect.stringMatching(/on hold/), expect.stringMatching(/completed/)]);
  });

  test('reopening clears the completion time', async () => {
    await as('manager').put(`/api/tasks/${taskId}/status`, { status: 'in_progress' });
    expect((await Task.findById(taskId)).completedAt).toBeUndefined();
  });

  test('the manager reassigns it; the new assignee is notified and the trail records it', async () => {
    const res = await as('manager').put(`/api/tasks/${taskId}`, { title: 'Approve proof for Lotus brochure', assignedTo: String(org.staff2._id) });
    expect(res.status).toBe(200);
    expect(res.body.data.assignedTo.fullName).toBe(org.staff2.fullName);
    expect((await notificationsFor(org.staff2)).map((n) => n.type)).toContain('task_reassigned');
    expect((await Task.findById(taskId)).history.at(-1)).toMatchObject({ type: 'reassigned', to: org.staff2.fullName });
    // The previous assignee no longer sees it.
    expect((await as('staff1').get(`/api/tasks/${taskId}`)).status).toBe(404);
  });
});

describe('who sees the whole team', () => {
  test('a manager without "view all staff data" sees only tasks they assigned', async () => {
    const adminTask = await make.task(org.admin, org.staff2, { title: 'Admin-only task' });
    const ids = (await as('manager').get('/api/tasks')).body.data.map((t) => t._id);
    expect(ids).not.toContain(String(adminTask._id));
  });

  test('the admin sees every task in the business', async () => {
    const managerTasks = await Task.find({ userId: org.manager._id }).distinct('_id');
    const ids = (await as('admin').get('/api/tasks?limit=100')).body.data.map((t) => t._id);
    for (const id of managerTasks) expect(ids).toContain(String(id));
  });

  test('a manager with "view all staff data" and Staff & Tasks also sees every task', async () => {
    await User.updateOne({ _id: org.manager._id }, { canViewAllData: true });
    const adminTasks = await Task.find({ userId: org.admin._id }).distinct('_id');
    const ids = (await as('manager').get('/api/tasks?limit=100')).body.data.map((t) => t._id);
    for (const id of adminTasks) expect(ids).toContain(String(id));
    await User.updateOne({ _id: org.manager._id }, { canViewAllData: false });
  });
});

describe('schedules', () => {
  test('staff read their own schedule but not a colleague\'s', async () => {
    expect((await as('staff1').get(`/api/staff/${org.staff1._id}/schedule`)).status).toBe(200);
    expect((await as('staff1').get(`/api/staff/${org.staff2._id}/schedule`)).status).toBe(403);
  });

  test('only Manage Schedule can set a schedule', async () => {
    const body = { schedules: [{ dayOfWeek: 'Monday', startTime: '09:00', endTime: '18:00', shiftType: 'morning' }] };
    expect((await as('staff1').post(`/api/staff/${org.staff1._id}/schedule`, body)).status).toBe(403);
    const res = await as('admin').post(`/api/staff/${org.staff1._id}/schedule`, body);
    expect(res.status).toBe(201);
    const own = await as('staff1').get(`/api/staff/${org.staff1._id}/schedule`);
    expect(own.body.data).toHaveLength(1);
  });
});

describe('notifications', () => {
  test('a user can only mark their own notifications read', async () => {
    const theirs = await Notification.findOne({ recipient: org.staff2._id });
    expect((await as('staff1').post(`/api/notifications/${theirs._id}/read`)).status).toBe(404);
    expect((await as('staff2').post(`/api/notifications/${theirs._id}/read`)).status).toBe(200);
    expect((await Notification.findById(theirs._id)).readAt).toBeInstanceOf(Date);
  });

  test('the list returns your messages, unread count and live alerts you are allowed to see', async () => {
    await make.task(org.admin, org.staff1, { title: 'Overdue plate check', dueDate: new Date(Date.now() - 864e5) });
    const res = await as('staff1').get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.data.alerts.map((a) => a.id)).toEqual(['my-overdue-tasks']);
    expect(res.body.data.items.every((n) => n.recipient === String(org.staff1._id))).toBe(true);

    // The admin also sees team-level and business alerts.
    const admin = await as('admin').get('/api/notifications');
    expect(admin.body.data.alerts.map((a) => a.id)).toEqual(expect.arrayContaining(['team-overdue-tasks']));
  });

  test('read-all clears your unread count', async () => {
    await as('manager').post('/api/notifications/read-all');
    expect((await as('manager').get('/api/notifications')).body.data.unreadCount).toBe(0);
  });
});

describe('my jobs', () => {
  test('a staff member without Jobs sees the jobs they handle or have tasks on, nothing else', async () => {
    const cust = await make.customer(org.admin);
    const handled = await make.job(org.admin, cust, { title: 'Handled by staff one', assignedTo: { handlerId: org.staff1._id, handlerName: org.staff1.fullName } });
    const viaTask = await make.job(org.admin, cust, { title: 'Has a task for staff one' });
    await make.task(org.admin, org.staff1, { title: 'Cut and pack', jobId: viaTask._id });
    await make.job(org.admin, cust, { title: 'Someone else\'s job' });

    const res = await as('staff1').get('/api/jobs/mine');
    expect(res.status).toBe(200);
    expect(res.body.data.jobs.map((j) => j.title).sort()).toEqual([handled.title, viaTask.title].sort());
    expect((await as('staff1').get('/api/jobs')).status).toBe(403);
  });
});
