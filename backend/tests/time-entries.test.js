/**
 * Design time: the timer (start, pause, resume, stop), one timer per person,
 * time added by hand, who can see and change which entries, and that another
 * business never sees them.
 */
const request = require('supertest');
const app = require('../src/app');
const TimeEntry = require('../src/models/TimeEntry');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

const MIN = 60000;
const TRACK = ['Designer Timer', 'Designer Timer: View', 'Designer Timer: Track Time'];

let org;
let other;
let job;
let job2;
let otherJob;

const as = (who) => auth(org.tokens[who]);
const api = (method, url, who, payload) => {
  const r = request(app)[method](`/api/time-entries${url}`).set(as(who));
  return payload ? r.send(payload) : r;
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

beforeAll(async () => {
  await connectTestDb('time_entries');
  await TimeEntry.init(); // the one-open-timer index must exist before the tests race it
  org = await createOrg('t', {
    staffPermissions: TRACK,
    managerPermissions: ['Dashboard', 'Jobs', 'Staff & Tasks', ...TRACK]
  });
  other = await createOrg('o');
  const cust = await make.customer(org.admin);
  job = await make.job(org.admin, cust, { title: 'Wedding cards for Anil' });
  job2 = await make.job(org.admin, cust, { title: 'Shop banner 6x3' });
  otherJob = await make.job(other.admin, await make.customer(other.admin), { title: 'Other shop flyer' });
});
afterAll(disconnectTestDb);

beforeEach(() => TimeEntry.deleteMany({}));

describe('the timer', () => {
  test('start derives the names from the login, job and description, and survives a reload via /active', async () => {
    const res = await api('post', '/start', 'staff1', { jobId: job._id, description: 'Front cover layout', billable: false });
    expect(res.status).toBe(201);
    const e = res.body.data.timeEntry;
    expect(e).toMatchObject({
      status: 'running',
      staffName: org.staff1.fullName,
      jobTitle: 'Wedding cards for Anil',
      taskName: 'Front cover layout',
      description: 'Front cover layout',
      billable: false,
      source: 'timer',
      duration: 0,
      dataScope: org.dataScope,
      userId: String(org.staff1._id),
      staffId: String(org.staff1._id)
    });

    const active = await api('get', '/active', 'staff1');
    expect(active.status).toBe(200);
    expect(active.body.data.activeTimer._id).toBe(e._id);
    // /active is the caller's own timer only.
    expect((await api('get', '/active', 'staff2')).body.data.activeTimer).toBeNull();
    expect((await api('get', '/active', 'manager')).body.data.activeTimer).toBeNull();
  });

  test('pause and resume, then stop: duration is the minutes worked, without the paused time', async () => {
    const { body } = await api('post', '/start', 'staff1', { jobId: job._id, description: 'Logo cleanup' });
    const id = body.data.timeEntry._id;
    await TimeEntry.updateOne({ _id: id }, { startTime: new Date(Date.now() - 90 * MIN) });

    const paused = await api('post', `/${id}/pause`, 'staff1');
    expect(paused.status).toBe(200);
    expect(paused.body.data.timeEntry.status).toBe('paused');
    expect((await api('post', `/${id}/pause`, 'staff1')).status).toBe(400);
    // The pause began 40 minutes ago.
    await TimeEntry.updateOne({ _id: id }, { 'breaks.0.startTime': new Date(Date.now() - 40 * MIN) });

    const resumed = await api('post', `/${id}/resume`, 'staff1');
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.timeEntry.status).toBe('running');
    expect(resumed.body.data.timeEntry.minutesSoFar).toBe(50);

    const stopped = await api('post', `/${id}/stop`, 'staff1');
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.timeEntry).toMatchObject({ status: 'completed', duration: 50, isActive: false });
    expect(stopped.body.data.timeEntry.endTime).toBeTruthy();
    expect((await api('post', `/${id}/stop`, 'staff1')).status).toBe(400);
    expect((await api('post', `/${id}/resume`, 'staff1')).status).toBe(400);
    expect((await api('get', '/active', 'staff1')).body.data.activeTimer).toBeNull();
  });

  test('stopping a paused timer ends it where the pause began', async () => {
    const { body } = await api('post', '/start', 'staff1', { jobId: job._id });
    const id = body.data.timeEntry._id;
    expect(body.data.timeEntry.taskName).toBe('Design work');
    await TimeEntry.updateOne({ _id: id }, { startTime: new Date(Date.now() - 60 * MIN) });
    await api('post', `/${id}/pause`, 'staff1');
    await TimeEntry.updateOne({ _id: id }, { 'breaks.0.startTime': new Date(Date.now() - 15 * MIN) });

    const res = await api('post', `/${id}/stop`, 'staff1');
    expect(res.body.data.timeEntry.duration).toBe(45);
    expect(res.body.data.timeEntry.breaks).toEqual([]);
  });

  test('one timer per person: starting another stops the previous one and says so', async () => {
    const first = (await api('post', '/start', 'staff1', { jobId: job._id, description: 'Cover' })).body.data.timeEntry;
    await TimeEntry.updateOne({ _id: first._id }, { startTime: new Date(Date.now() - 30 * MIN) });

    const res = await api('post', '/start', 'staff1', { jobId: job2._id, description: 'Banner' });
    expect(res.status).toBe(201);
    expect(res.body.data.stopped).toMatchObject({ _id: first._id, status: 'completed', duration: 30 });
    expect(res.body.data.timeEntry.jobTitle).toBe('Shop banner 6x3');
    expect(await TimeEntry.countDocuments({ staffId: org.staff1._id, isActive: true })).toBe(1);

    // Someone else's timer is untouched.
    await api('post', '/start', 'staff2', { jobId: job._id });
    expect(await TimeEntry.countDocuments({ isActive: true })).toBe(2);

    // The database refuses a second open timer for the same person.
    await expect(
      TimeEntry.create({ jobId: job._id, jobTitle: 'x', taskName: 'x', staffId: org.staff1._id, staffName: 'x', startTime: new Date(), status: 'running', userId: org.staff1._id })
    ).rejects.toMatchObject({ code: 11000 });
  });

  test('a task links the entry to the task and its job; tasks of another job or not visible are refused', async () => {
    const task = await make.task(org.admin, org.staff1, { title: 'Proof corrections', jobId: job._id, jobTitle: job.title });
    const res = await api('post', '/start', 'staff1', { jobId: job._id, taskId: task._id, description: 'Second round' });
    expect(res.status).toBe(201);
    expect(res.body.data.timeEntry).toMatchObject({ taskId: String(task._id), taskName: 'Proof corrections', description: 'Second round' });

    expect((await api('post', '/start', 'staff1', { jobId: job2._id, taskId: task._id })).status).toBe(400);
    expect((await api('post', '/start', 'staff2', { jobId: job._id, taskId: task._id })).status).toBe(404);
  });

  test('pause and resume act only on the caller\'s own timer', async () => {
    const id = (await api('post', '/start', 'staff1', { jobId: job._id })).body.data.timeEntry._id;
    expect((await api('post', `/${id}/pause`, 'staff2')).status).toBe(404);
    expect((await api('post', `/${id}/pause`, 'manager')).status).toBe(404);
  });
});

describe('time added by hand', () => {
  test('start and end times give the duration; a duration alone is kept as entered', async () => {
    const a = await api('post', '/', 'staff1', { jobId: job._id, description: 'Visiting card variants', startTime: hoursAgo(5), endTime: hoursAgo(3) });
    expect(a.status).toBe(201);
    expect(a.body.data.timeEntry).toMatchObject({ status: 'completed', source: 'manual', duration: 120, billable: true, staffName: org.staff1.fullName });

    const b = await api('post', '/', 'staff1', { jobId: job2._id, description: 'Phone call with printer', startTime: hoursAgo(26), duration: 25, billable: false });
    expect(b.status).toBe(201);
    expect(b.body.data.timeEntry).toMatchObject({ duration: 25, endTime: null, billable: false });

    const list = await api('get', '/', 'staff1');
    expect(list.status).toBe(200);
    expect(list.body.data.timeEntries.map((e) => e.description)).toEqual(['Visiting card variants', 'Phone call with printer']);
    expect(list.body.data.totals).toEqual({ count: 2, minutes: 145, billableMinutes: 120 });

    // Filters: date range (to is exclusive) and job.
    const recent = await api('get', `/?from=${hoursAgo(6)}&to=${hoursAgo(0)}`, 'staff1');
    expect(recent.body.data.timeEntries).toHaveLength(1);
    const byJob = await api('get', `/?jobId=${job2._id}`, 'staff1');
    expect(byJob.body.data.timeEntries.map((e) => e.jobTitle)).toEqual(['Shop banner 6x3']);
  });

  test('invalid input is refused with 400', async () => {
    const base = { jobId: job._id, startTime: hoursAgo(2), endTime: hoursAgo(1) };
    const bad = [
      { ...base, jobId: undefined },
      { ...base, jobId: 'not-an-id' },
      { ...base, startTime: undefined },
      { ...base, startTime: 'yesterday' },
      { ...base, endTime: hoursAgo(3) },
      { ...base, endTime: undefined },
      { ...base, endTime: undefined, duration: 0 },
      { ...base, endTime: undefined, duration: 2000 },
      { ...base, startTime: new Date(Date.now() + 3600e3).toISOString(), endTime: new Date(Date.now() + 7200e3).toISOString() },
      { ...base, startTime: hoursAgo(30), endTime: hoursAgo(1) },
      { ...base, billable: 'maybe' },
      { ...base, taskId: 'nope' },
      { ...base, description: 'x'.repeat(501) }
    ];
    for (const payload of bad) {
      const res = await api('post', '/', 'staff1', payload);
      expect([res.status, payload]).toEqual([400, payload]);
      expect(res.body.message).toBeTruthy();
    }
    expect((await api('post', '/start', 'staff1', {})).status).toBe(400);
    expect((await api('get', '/?from=soon', 'staff1')).status).toBe(400);
    expect((await api('get', '/active-ish', 'staff1')).status).toBe(400);
    expect(await TimeEntry.countDocuments({})).toBe(0);
  });

  test('editing the times recomputes the minutes; a running timer\'s end cannot be edited', async () => {
    const id = (await api('post', '/', 'staff1', { jobId: job._id, description: 'Brochure', startTime: hoursAgo(4), endTime: hoursAgo(3) })).body.data.timeEntry._id;
    const res = await api('put', `/${id}`, 'staff1', { endTime: hoursAgo(2), description: 'Brochure, both sides', billable: false, jobId: job2._id });
    expect(res.status).toBe(200);
    expect(res.body.data.timeEntry).toMatchObject({ duration: 120, description: 'Brochure, both sides', taskName: 'Brochure, both sides', billable: false, jobTitle: 'Shop banner 6x3' });
    expect((await api('put', `/${id}`, 'staff1', { endTime: hoursAgo(5) })).status).toBe(400);

    const running = (await api('post', '/start', 'staff1', { jobId: job._id })).body.data.timeEntry._id;
    expect((await api('put', `/${running}`, 'staff1', { endTime: hoursAgo(0) })).status).toBe(400);
    const moved = await api('put', `/${running}`, 'staff1', { startTime: new Date(Date.now() - 20 * MIN).toISOString() });
    expect(moved.status).toBe(200);
    expect(moved.body.data.timeEntry.minutesSoFar).toBe(20);
  });

  test('delete removes the entry', async () => {
    const id = (await api('post', '/', 'staff1', { jobId: job._id, startTime: hoursAgo(2), duration: 30 })).body.data.timeEntry._id;
    expect((await api('delete', `/${id}`, 'staff1')).status).toBe(200);
    expect(await TimeEntry.findById(id)).toBeNull();
    expect((await api('delete', `/${id}`, 'staff1')).status).toBe(404);
  });
});

describe('who sees and changes what', () => {
  let mine;
  let theirs;
  beforeEach(async () => {
    mine = (await api('post', '/', 'staff1', { jobId: job._id, description: 'Staff one work', startTime: hoursAgo(3), duration: 60 })).body.data.timeEntry;
    theirs = (await api('post', '/start', 'staff2', { jobId: job2._id, description: 'Staff two work' })).body.data.timeEntry;
  });

  test('staff see and change only their own entries', async () => {
    const list = await api('get', '/', 'staff1');
    expect(list.body.data.timeEntries.map((e) => e._id)).toEqual([mine._id]);
    // Asking for someone else's entries returns nothing.
    expect((await api('get', `/?staffId=${org.staff2._id}`, 'staff1')).body.data.timeEntries).toEqual([]);

    expect((await api('get', `/${theirs._id}`, 'staff1')).status).toBe(404);
    expect((await api('put', `/${theirs._id}`, 'staff1', { description: 'hijack' })).status).toBe(404);
    expect((await api('post', `/${theirs._id}/stop`, 'staff1')).status).toBe(404);
    expect((await api('delete', `/${theirs._id}`, 'staff1')).status).toBe(404);
    expect(await TimeEntry.findById(theirs._id)).toMatchObject({ description: 'Staff two work', status: 'running' });

    const people = await api('get', '/people', 'staff1');
    expect(people.body.data.canSeeTeam).toBe(false);
    expect(people.body.data.people.map((p) => p.fullName)).toEqual([org.staff1.fullName]);

    const stats = await api('get', '/stats/summary', 'staff1');
    expect(stats.body.data.stats.team).toBeNull();
    expect(stats.body.data.stats.me).toMatchObject({ todayMinutes: expect.any(Number), weekMinutes: expect.any(Number) });
  });

  test('a manager who sees all staff data sees the team, who is on the clock, and can fix or stop entries', async () => {
    const list = await api('get', '/', 'manager');
    expect(list.body.data.timeEntries.map((e) => e._id).sort()).toEqual([mine._id, theirs._id].sort());
    const one = await api('get', `/?staffId=${org.staff2._id}&status=open`, 'manager');
    expect(one.body.data.timeEntries.map((e) => e._id)).toEqual([theirs._id]);

    const people = await api('get', '/people', 'manager');
    expect(people.body.data.canSeeTeam).toBe(true);
    expect(people.body.data.people.map((p) => p.fullName)).toEqual(expect.arrayContaining([org.staff1.fullName, org.staff2.fullName]));

    const stats = await api('get', '/stats/summary', 'manager');
    expect(stats.status).toBe(200);
    expect(stats.body.data.stats.team.onClock.map((p) => p.staffName)).toEqual([org.staff2.fullName]);

    expect((await api('put', `/${mine._id}`, 'manager', { billable: false })).body.data.timeEntry.billable).toBe(false);
    const stopped = await api('post', `/${theirs._id}/stop`, 'manager');
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.timeEntry.status).toBe('completed');
  });

  test('staff stats count their own time, billable apart', async () => {
    await api('post', '/', 'staff1', { jobId: job2._id, description: 'Internal', startTime: new Date(Date.now() - 30 * MIN).toISOString(), duration: 20, billable: false });
    const dayStart = new Date(Date.now() - 4 * 3600e3).toISOString();
    const res = await api('get', `/stats/summary?dayStart=${dayStart}&weekStart=${dayStart}`, 'staff1');
    expect(res.body.data.stats.me).toMatchObject({ todayMinutes: 80, weekMinutes: 80, billableWeekMinutes: 60, weekEntries: 2 });
    expect(res.body.data.stats.me.topJob).toMatchObject({ jobTitle: 'Wedding cards for Anil', minutes: 60 });
    expect((await api('get', '/stats/summary?dayStart=today', 'staff1')).status).toBe(400);
  });

  test('another business cannot see or change the entries, nor log time on its jobs', async () => {
    const theirAdmin = (method, url, payload) => {
      const r = request(app)[method](`/api/time-entries${url}`).set(auth(other.tokens.admin));
      return payload ? r.send(payload) : r;
    };
    expect((await theirAdmin('get', '/')).body.data.timeEntries).toEqual([]);
    expect((await theirAdmin('get', `/${mine._id}`)).status).toBe(404);
    expect((await theirAdmin('put', `/${mine._id}`, { description: 'x' })).status).toBe(404);
    expect((await theirAdmin('post', `/${theirs._id}/stop`)).status).toBe(404);
    expect((await theirAdmin('delete', `/${mine._id}`)).status).toBe(404);
    expect((await theirAdmin('get', '/stats/summary')).body.data.stats.team.onClock).toEqual([]);
    const people = (await theirAdmin('get', '/people')).body.data.people.map((p) => p.fullName);
    expect(people).not.toContain(org.staff1.fullName);

    // Our staff cannot log time against the other business's job.
    expect((await api('post', '/start', 'staff1', { jobId: otherJob._id })).status).toBe(404);
    expect((await api('post', '/', 'staff1', { jobId: otherJob._id, startTime: hoursAgo(2), duration: 10 })).status).toBe(404);

    // A login without Design time is turned away by the module guard.
    expect((await request(app).get('/api/time-entries').set(auth(other.tokens.staff1))).status).toBe(403);
  });

  test('the Team overview counts the stopped minutes', async () => {
    const res = await request(app).get('/api/team/overview?days=7').set(as('manager'));
    expect(res.status).toBe(200);
    const row = res.body.data.members.find((m) => m.user._id === String(org.staff1._id));
    expect(row.timeLoggedMinutes).toBe(60);
    const detail = await request(app).get(`/api/team/members/${org.staff1._id}?days=7`).set(as('manager'));
    expect(detail.body.data.timeEntries).toEqual([expect.objectContaining({ jobTitle: 'Wedding cards for Anil', taskName: 'Staff one work', duration: 60, status: 'completed' })]);
  });
});
