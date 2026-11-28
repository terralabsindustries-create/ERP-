/**
 * Who sees which job tickets (src/utils/jobAccess.js): a designer sees only
 * the job tickets they created — in the list, search, details, counts and
 * everywhere a job can be reached by id — while the admin, managers and
 * accounts see all of the business's. Ownership never changes on an edit, and
 * another business sees none of them.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Job = require('../src/models/Job');
const { generateToken } = require('../src/middleware/auth');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth, uniq } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
const people = {};
const as = (who) => {
  const token = people[who] ? people[who].token : who;
  return {
    get: (url) => request(app).get(url).set(auth(token)),
    post: (url, body) => request(app).post(url).set(auth(token)).send(body),
    put: (url, body) => request(app).put(url).set(auth(token)).send(body),
    delete: (url) => request(app).delete(url).set(auth(token))
  };
};
const JOB_WORK = ['Dashboard', 'Jobs', 'Jobs: View', 'Jobs: Create & Edit', 'Jobs: Change Status', 'Jobs: Delete', 'Customers', 'Customers: View', 'Invoicing', 'Invoicing: View', 'Invoicing: Create & Edit', 'Calendar', 'Calendar: Create & Edit'];

async function login(key, role, extra = {}) {
  const user = await User.create({
    email: `${key}-${uniq()}@example.test`, password: 'Passw0rd!', fullName: `Visibility ${key}`, role,
    dataScope: org.dataScope, companyName: 'Visibility Printers', status: 'active', isActive: true, permissions: JOB_WORK, ...extra
  });
  people[key] = { user, token: generateToken(user._id) };
}
const jobs = {};
async function job(owner, title) {
  const res = await as(owner).post('/api/jobs', { title, customerId: String(cust._id), dueDate: new Date().toISOString(), items: [{ itemName: 'Flex', itemType: 'Numbers', unit: 'pieces', quantity: 1, unitPrice: 100, gstRate: 18 }] });
  expect(res.status).toBe(201);
  jobs[title] = res.body.data.job;
  return res.body.data.job;
}
const titles = async (who, query = '') => {
  const res = await as(who).get(`/api/jobs?limit=100${query}`);
  expect(res.status).toBe(200);
  return { titles: res.body.data.jobs.map((j) => j.title).sort(), total: res.body.data.pagination.totalJobs };
};

beforeAll(async () => {
  await connectTestDb('job_visibility');
  org = await createOrg('jobvis');
  other = await createOrg('jobvisother');
  people.admin = { user: org.admin, token: org.tokens.admin };
  cust = await make.customer(org.admin, { name: 'Lotus Events' });
  await login('designerA', 'designer');
  await login('designerB', 'designer');
  await login('manager', 'manager', { canViewAllData: true }); // "Can view all data" switched on
  await login('accounts', 'accountant', { canViewAllData: true });
  await login('plainManager', 'manager'); // switch off: sees only their own
  await login('staffOff', 'staff'); // switch off
  await login('staffOn', 'staff', { canViewAllData: true });
  await login('leadDesigner', 'designer', { canViewAllData: true });

  await job('designerA', 'A — wedding banner');
  await job('designerA', 'A — shop sign');
  await job('designerB', 'B — menu cards');
  await job('admin', 'Admin — letterheads');
  await job('manager', 'Manager — brochures');
});
afterAll(disconnectTestDb);

const ALL = ['A — shop sign', 'A — wedding banner', 'Admin — letterheads', 'B — menu cards', 'Manager — brochures'];

describe('listing job tickets', () => {
  test('designer A sees only their own, with a count to match', async () => {
    expect(await titles('designerA')).toEqual({ titles: ['A — shop sign', 'A — wedding banner'], total: 2 });
  });

  test('designer B sees only their own', async () => {
    expect(await titles('designerB')).toEqual({ titles: ['B — menu cards'], total: 1 });
  });

  test.each([['admin'], ['manager'], ['accounts'], ['leadDesigner']])('%s sees every job ticket', async (who) => {
    expect(await titles(who)).toEqual({ titles: ALL, total: 5 });
  });

  test('search, filters and query parameters stay inside what the designer may see', async () => {
    expect((await titles('designerA', '&search=menu')).titles).toEqual([]);
    expect((await titles('designerA', `&customerId=${cust._id}`)).total).toBe(2);
    // An owner id in the request is not trusted.
    expect((await titles('designerA', `&userId=${people.designerB.user._id}`)).titles).not.toContain('B — menu cards');
    expect((await titles('designerA', `&createdBy=${people.designerB.user._id}`)).total).toBe(2);
    expect((await titles('manager', '&search=menu')).titles).toEqual(['B — menu cards']);
  });

  test("a customer's job list shows a designer only their own", async () => {
    const res = await as('designerA').get(`/api/customers/${cust._id}/jobs`);
    expect(res.status).toBe(200);
    expect(res.body.data.jobs.map((j) => j.title).sort()).toEqual(['A — shop sign', 'A — wedding banner']);
    expect((await as('accounts').get(`/api/customers/${cust._id}/jobs`)).body.data.jobs).toHaveLength(5);
  });
});

describe("another designer's job ticket by id", () => {
  const bJob = () => jobs['B — menu cards'];

  test('cannot be opened, edited, moved, assigned or deleted', async () => {
    const a = as('designerA');
    const id = bJob()._id;
    expect((await a.get(`/api/jobs/${id}`)).status).toBe(404);
    expect((await a.put(`/api/jobs/${id}`, { title: 'Taken over', customerId: String(cust._id) })).status).toBe(404);
    expect((await a.post(`/api/jobs/${id}/update-status`, { status: 'completed' })).status).toBe(404);
    expect((await a.post(`/api/jobs/${id}/assign`, { operatorId: String(people.designerA.user._id), operatorName: 'A' })).status).toBe(404);
    expect((await a.post(`/api/jobs/${id}/update-flow-stage`, { stage: 'design_approved' })).status).toBe(404);
    expect((await a.delete(`/api/jobs/${id}`)).status).toBe(404);
    expect(await Job.findById(id).lean()).toMatchObject({ title: 'B — menu cards', status: bJob().status });
  });

  test('their own job ticket opens normally', async () => {
    expect((await as('designerA').get(`/api/jobs/${jobs['A — shop sign']._id}`)).status).toBe(200);
  });

  test('managers, admin and accounts can open it', async () => {
    for (const who of ['manager', 'admin', 'accounts']) {
      expect((await as(who).get(`/api/jobs/${bJob()._id}`)).status).toBe(200);
    }
  });
});

describe('counts and statistics', () => {
  test('job ticket statistics cover only what the designer may see', async () => {
    const mine = (await as('designerA').get('/api/jobs/stats/dashboard')).body.data.stats;
    const all = (await as('admin').get('/api/jobs/stats/dashboard')).body.data.stats;
    expect(mine.totalJobs).toBe(2);
    expect(all.totalJobs).toBe(5);
  });

  test('dashboard job counts follow the same rule', async () => {
    const mine = (await as('designerA').get('/api/dashboard/stats')).body.stats;
    const all = (await as('manager').get('/api/dashboard/stats')).body.stats;
    expect(mine).toMatchObject({ todaysJobs: 2, openJobs: 2 });
    expect(all).toMatchObject({ todaysJobs: 5, openJobs: 5 });
  });

  test('jobs waiting for an invoice: a designer sees only their own', async () => {
    const mine = (await as('designerA').get('/api/invoices/pending-jobs?limit=100')).body.data;
    const all = (await as('accounts').get('/api/invoices/pending-jobs?limit=100')).body.data;
    expect(mine.pagination.totalJobs).toBe(2);
    expect(all.pagination.totalJobs).toBe(5);
  });
});

describe('ownership and existing workflows', () => {
  test("an edit by someone else keeps the creator, and a request cannot change it or the business", async () => {
    const id = jobs['A — wedding banner']._id;
    const res = await as('manager').put(`/api/jobs/${id}`, {
      title: 'A — wedding banner (revised)', customerId: String(cust._id),
      userId: String(people.designerB.user._id), createdBy: String(people.designerB.user._id), dataScope: other.dataScope
    });
    expect(res.status).toBe(200);
    const stored = await Job.findById(id).lean();
    expect(String(stored.userId)).toBe(String(people.designerA.user._id));
    expect(String(stored.createdBy)).toBe(String(people.designerA.user._id));
    expect(stored.dataScope).toBe(org.dataScope);
    expect((await titles('designerA')).titles).toContain('A — wedding banner (revised)');
    jobs['A — wedding banner (revised)'] = jobs['A — wedding banner'];
  });

  test('a new job ticket cannot claim another creator', async () => {
    const res = await as('designerA').post('/api/jobs', { title: 'A — claimed', customerId: String(cust._id), userId: String(people.designerB.user._id), createdBy: String(people.designerB.user._id) });
    expect(res.status).toBe(201);
    const stored = await Job.findById(res.body.data.job._id).lean();
    expect(String(stored.userId)).toBe(String(people.designerA.user._id));
    expect((await titles('designerB')).titles).not.toContain('A — claimed');
  });

  test('a designer can still change the status of their own job and accounts can invoice it', async () => {
    const id = jobs['A — shop sign']._id;
    expect((await as('designerA').post(`/api/jobs/${id}/update-status`, { status: 'design_in_progress' })).status).toBe(200);
    const inv = await as('accounts').post('/api/invoices', {
      jobId: id, customerId: String(cust._id), status: 'sent',
      items: [{ itemName: 'Flex', quantity: 1, unit: 'pieces', unitPrice: 100, gstRate: 18 }]
    });
    expect(inv.status).toBe(201);
    expect(inv.body.data.invoice.totalAmount).toBe(118);
  });
});

describe('another business', () => {
  test('sees none of these job tickets, even by id', async () => {
    const them = as(other.tokens.admin);
    expect((await them.get('/api/jobs?limit=100')).body.data.jobs.map((j) => j.title)).toEqual([]);
    expect((await them.get(`/api/jobs/${jobs['B — menu cards']._id}`)).status).toBe(404);
    expect((await them.get('/api/jobs/stats/dashboard')).body.data.stats.totalJobs).toBe(0);
  });

  test("cannot link a calendar event to this business's job", async () => {
    const res = await as(other.tokens.admin).post('/api/calendar/events', {
      title: 'Snoop', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 3600e3).toISOString(), jobId: jobs['B — menu cards']._id
    });
    expect(res.status).toBe(404);
  });
});

// Tickets other people made (earlier tests rename some, so only the stable ones are named).
const EVERYONES = ['A — shop sign', 'Admin — letterheads', 'B — menu cards', 'Manager — brochures'];

describe('the "Can view all data" switch decides who sees everyone\'s job tickets', () => {
  test('off: a manager or staff member sees only the tickets they created, whatever their role', async () => {
    await job('plainManager', 'PM — own ticket');
    await job('staffOff', 'Staff — own ticket');
    expect((await titles('plainManager')).titles).toEqual(['PM — own ticket']);
    expect((await titles('staffOff')).titles).toEqual(['Staff — own ticket']);
    expect((await as('staffOff').get(`/api/jobs/${jobs['A — shop sign']._id}`)).status).toBe(404);
  });
  test('on: staff, managers and accountants see every ticket', async () => {
    const all = (await titles('staffOn')).titles;
    expect(all).toEqual(expect.arrayContaining(EVERYONES));
    expect((await as('staffOn').get(`/api/jobs/${jobs['A — shop sign']._id}`)).status).toBe(200);
  });
  test('the admin turns it on or off from User Management and it takes effect at once', async () => {
    const id = people.staffOff.user._id;
    expect((await as('admin').put(`/api/users/${id}`, { canViewAllData: true })).status).toBe(200);
    expect((await titles('staffOff')).titles).toEqual(expect.arrayContaining(EVERYONES));
    expect((await as('admin').put(`/api/users/${id}`, { canViewAllData: false })).status).toBe(200);
    expect((await titles('staffOff')).titles).toEqual(['Staff — own ticket']);
  });
  test('a login without the switch cannot grant it', async () => {
    const res = await as('plainManager').put(`/api/users/${people.staffOff.user._id}`, { canViewAllData: true });
    expect([403, 404]).toContain(res.status);
  });
});
