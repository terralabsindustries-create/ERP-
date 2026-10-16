/**
 * Server-side permission enforcement: what a login can reach is decided by its
 * permissions on the API, not by what the sidebar shows.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
beforeAll(async () => {
  await connectTestDb('access');
  org = await createOrg('acl', { staffPermissions: ['Dashboard'] });
});
afterAll(disconnectTestDb);

const asStaff = (method, url) => request(app)[method](url).set(auth(org.tokens.staff1));
const grant = (user, permissions) => User.updateOne({ _id: user._id }, { permissions });

describe('a staff login with no module permissions', () => {
  // Reads that used to succeed for any logged-in user.
  test.each([
    '/api/accounts/ledger',
    '/api/accounts/balances',
    '/api/hr/employees',
    '/api/hr/payroll',
    '/api/hr/attendance',
    '/api/hr/leaves',
    '/api/invoices',
    '/api/payments',
    '/api/purchase-bills',
    '/api/vendors',
    '/api/customers',
    '/api/jobs',
    '/api/inventory',
    '/api/reports/revenue',
    '/api/activity-log',
    '/api/payment-reminders',
    '/api/whatsapp/settings',
    '/api/costs',
    '/api/team/overview',
    '/api/portal/access'
  ])('is refused GET %s', async (url) => {
    const res = await asStaff('get', url);
    expect(res.status).toBe(403);
  });

  test.each([
    ['put', '/api/settings'],
    ['put', '/api/settings/business'],
    ['post', '/api/whatsapp/settings'],
    ['delete', '/api/embedded-signup/reset'],
    ['put', '/api/payment-reminders/settings'],
    ['post', '/api/payment-reminders/send-bulk'],
    ['post', '/api/customers'],
    ['post', '/api/payments'],
    ['post', '/api/tasks']
  ])('is refused %s %s', async (method, url) => {
    const res = await asStaff(method, url).send({});
    expect(res.status).toBe(403);
  });

  test('still reaches its own work: tasks, my jobs, notifications, profile', async () => {
    for (const url of ['/api/auth/me', '/api/tasks', '/api/jobs/mine', '/api/notifications', '/api/dashboard/stats', `/api/staff/${org.staff1._id}/schedule`]) {
      const res = await asStaff('get', url);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  test('dashboard stats leave out every section it has no permission for', async () => {
    const res = await asStaff('get', '/api/dashboard/stats');
    const s = res.body.stats;
    for (const key of ['receivables', 'invoicedThisMonth', 'cashBalance', 'bankBalance', 'collectedToday', 'lowStockItems', 'todaysJobs', 'totalCustomers']) {
      expect([key, s[key]]).toEqual([key, null]);
    }
  });
});

describe('granting a module opens exactly that module', () => {
  afterEach(() => grant(org.staff1, ['Dashboard']));

  test('Payments (view only) can list but not record payments', async () => {
    await grant(org.staff1, ['Dashboard', 'Payments', 'Payments: View']);
    expect((await asStaff('get', '/api/payments')).status).toBe(200);
    expect((await asStaff('post', '/api/payments').send({})).status).toBe(403);
  });

  test('a legacy module-only grant keeps every action in that module', async () => {
    // Logins created before granular actions hold just the module name.
    await grant(org.staff1, ['Dashboard', 'Customers']);
    const res = await asStaff('post', '/api/customers').send({ name: 'Legacy Grant Ltd', phone: '9811111111' });
    expect(res.status).toBe(201);
  });

  test('Customers: View cannot delete', async () => {
    const c = await make.customer(org.admin);
    await grant(org.staff1, ['Dashboard', 'Customers', 'Customers: View']);
    expect((await asStaff('delete', `/api/customers/${c._id}`)).status).toBe(403);
  });

  test('lookup lists used inside other screens follow the screen permission', async () => {
    // Someone creating job tickets needs the customer list, HSN codes and stock items.
    await grant(org.staff1, ['Dashboard', 'Jobs', 'Jobs: View', 'Jobs: Create & Edit']);
    for (const url of ['/api/customers', '/api/hsn-codes', '/api/inventory', '/api/jobs']) {
      expect([url, (await asStaff('get', url)).status]).toEqual([url, 200]);
    }
    expect((await asStaff('get', '/api/invoices')).status).toBe(403);
  });

  test('HR access without View Salary hides salary figures', async () => {
    const Employee = require('../src/models/Employee');
    await Employee.create({ name: 'Press Operator', salary: { basic: 25000 }, userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope, status: 'active' });
    await grant(org.staff1, ['Dashboard', 'Human Resources', 'Human Resources: View']);
    const res = await asStaff('get', '/api/hr/employees');
    expect(res.status).toBe(200);
    expect(res.body.data.employees[0].salary).toBeUndefined();

    const admin = await request(app).get('/api/hr/employees').set(auth(org.tokens.admin));
    expect(admin.body.data.employees[0].salary.basic).toBe(25000);
  });

  test('No-GST invoices need their own permission', async () => {
    const c = await make.customer(org.admin);
    const hidden = await make.invoice(org.admin, c, { noGst: true });
    await grant(org.manager, ['Dashboard', 'Invoicing', 'Invoicing: View']);
    const list = await request(app).get('/api/invoices').set(auth(org.tokens.manager));
    expect(list.body.data.invoices.map((i) => i._id)).not.toContain(String(hidden._id));
    expect((await request(app).get(`/api/invoices/${hidden._id}`).set(auth(org.tokens.manager))).status).toBe(404);
  });
});

describe('admin', () => {
  test('passes every module guard', async () => {
    for (const url of ['/api/payments', '/api/accounts/ledger', '/api/hr/employees', '/api/reports/revenue', '/api/team/overview']) {
      expect([url, (await request(app).get(url).set(auth(org.tokens.admin))).status]).toEqual([url, 200]);
    }
  });
});

describe('unauthenticated mail endpoints are closed', () => {
  test('POST /api/email/send needs a real login', async () => {
    const res = await request(app).post('/api/email/send').set('Authorization', 'Bearer not-a-token').send({ to: 'x@example.test', subject: 's', template: 'staff-welcome' });
    expect(res.status).toBe(401);
  });

  test('POST /api/email/test-public is not available outside development', async () => {
    const res = await request(app).post('/api/email/test-public').send({ to: 'x@example.test' });
    expect(res.status).toBe(404);
  });
});
