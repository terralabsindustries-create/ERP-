/**
 * One business can never read or change another business's records, even by
 * guessing ids. Business B's admin owns the records; business A's admin (who
 * passes every permission check) tries to reach them.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Delivery = require('../src/models/Delivery');
const Payment = require('../src/models/Payment');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a;
let b;
let rec;

beforeAll(async () => {
  await connectTestDb('isolation');
  a = await createOrg('a');
  b = await createOrg('b');
  const cust = await make.customer(b.admin, { name: 'B Secret Customer' });
  const j = await make.job(b.admin, cust, { title: 'B Secret Job' });
  rec = {
    cust,
    job: j,
    invoice: await make.invoice(b.admin, cust, { invoiceNumber: 'B-SECRET-1' }),
    delivery: await make.delivery(b.admin, cust, j),
    event: await make.event(b.admin, { title: 'B Secret Event' }),
    rule: await make.discountRule(b.admin, { name: 'B Secret Rule' }),
    payment: await make.payment(b.admin, cust, { dataScope: b.dataScope }),
    task: await make.task(b.admin, b.staff1, { title: 'B Secret Task' })
  };
});
afterAll(disconnectTestDb);

const asA = (method, url) => request(app)[method](url).set(auth(a.tokens.admin));
const noSecrets = (res) => expect(JSON.stringify(res.body)).not.toMatch(/B Secret|B-SECRET/);

describe('lists only ever contain your own business', () => {
  test.each([
    '/api/customers',
    '/api/jobs',
    '/api/invoices',
    '/api/payments',
    '/api/deliveries',
    '/api/calendar/events',
    '/api/discounts/rules',
    '/api/proofs',
    '/api/costs',
    '/api/emergency-orders',
    '/api/files',
    '/api/tasks',
    '/api/users',
    '/api/activity-log',
    '/api/team/overview',
    '/api/notifications'
  ])('GET %s', async (url) => {
    const res = await asA('get', url);
    expect(res.status).toBe(200);
    noSecrets(res);
  });

  test('inventory analytics are counted per business', async () => {
    await make.stockItem(b.admin, { name: 'B Secret Paper', quantity: 900 });
    const res = await asA('get', '/api/inventory/analytics');
    expect(res.status).toBe(200);
    noSecrets(res);
    expect(res.body.data.analytics.totalItems || 0).toBe(0);
  });
});

describe('records addressed by id are not found', () => {
  test.each([
    ['customers', () => rec.cust._id],
    ['jobs', () => rec.job._id],
    ['invoices', () => rec.invoice._id],
    ['payments', () => rec.payment._id],
    ['deliveries', () => rec.delivery._id],
    ['calendar/events', () => rec.event._id],
    ['discounts/rules', () => rec.rule._id],
    ['tasks', () => rec.task._id]
  ])('GET /api/%s/:id', async (path, id) => {
    const res = await asA('get', `/api/${path}/${id()}`);
    expect(res.status).toBe(404);
    noSecrets(res);
  });

  test('status changes on another business are refused', async () => {
    expect((await asA('put', `/api/deliveries/${rec.delivery._id}/status`).send({ status: 'delivered' })).status).toBe(404);
    expect((await asA('put', `/api/calendar/events/${rec.event._id}/status`).send({ status: 'completed' })).status).toBe(404);
    expect((await Delivery.findById(rec.delivery._id)).status).toBe('scheduled');
  });

  test('payments in another business cannot be edited or deleted', async () => {
    expect((await asA('put', `/api/payments/${rec.payment._id}`).send({ amount: 1 })).status).toBe(404);
    expect((await asA('delete', `/api/payments/${rec.payment._id}`)).status).toBe(404);
    expect((await Payment.findById(rec.payment._id)).amount).toBe(500);
  });

  test('discount calculation uses only your own business\'s rules, and only current ones', async () => {
    // rec.rule is business B's 5% rule; business A has none of its own yet.
    const cust = await make.customer(a.admin);
    const calc = () => asA('post', '/api/discounts/calculate').send({ customerId: String(cust._id), amount: 1000 });
    let res = await calc();
    expect(res.status).toBe(200);
    expect(res.body.data.discountAmount).toBe(0);
    noSecrets(res);

    // An expired rule does not apply (the three date/amount conditions used to
    // collapse into one, so only the minimum-amount check was applied).
    await make.discountRule(a.admin, { name: 'A Expired', value: 50, validUntil: new Date(Date.now() - 864e5) });
    res = await calc();
    expect(res.body.data.discountAmount).toBe(0);

    await make.discountRule(a.admin, { name: 'A Current', value: 10 });
    res = await calc();
    expect(res.body.data.discountAmount).toBe(100);
    expect(res.body.data.appliedRule.name).toBe('A Current');
  });

  test('tasks in another business cannot be updated, commented on or deleted', async () => {
    expect((await asA('put', `/api/tasks/${rec.task._id}/status`).send({ status: 'completed' })).status).toBe(404);
    expect((await asA('post', `/api/tasks/${rec.task._id}/comments`).send({ text: 'hi' })).status).toBe(404);
    expect((await asA('delete', `/api/tasks/${rec.task._id}`)).status).toBe(404);
  });
});

describe('user accounts in another business', () => {
  test('cannot be read', async () => {
    expect((await asA('get', `/api/users/${b.staff1._id}`)).status).toBe(404);
  });

  test('cannot be edited, re-passworded, disabled or deleted', async () => {
    expect((await asA('put', `/api/users/${b.staff1._id}`).send({ fullName: 'Hijacked' })).status).toBe(404);
    expect((await asA('put', `/api/users/${b.staff1._id}/password`).send({ currentPassword: 'x', newPassword: 'newpass123' })).status).toBe(404);
    expect((await asA('put', `/api/users/${b.staff1._id}/toggle-status`)).status).toBe(404);
    expect((await asA('delete', `/api/users/${b.staff1._id}`)).status).toBe(404);
    const still = await User.findById(b.staff1._id);
    expect(still.fullName).toBe(b.staff1.fullName);
    expect(still.isActive).toBe(true);
  });

  test('cannot be given tasks', async () => {
    const res = await asA('post', '/api/tasks').send({ title: 'Cross-business work', assignedTo: String(b.staff1._id) });
    expect(res.status).toBe(400);
  });

  test('schedules cannot be read', async () => {
    expect((await asA('get', `/api/staff/${b.staff1._id}/schedule`)).status).toBe(404);
  });

  test('team member detail is not found', async () => {
    expect((await asA('get', `/api/team/members/${b.staff1._id}`)).status).toBe(404);
  });
});

describe('managers inside a business', () => {
  test('cannot change the admin account', async () => {
    const res = await request(app).put(`/api/users/${a.admin._id}`).set(auth(a.tokens.manager)).send({ email: 'takeover@example.test' });
    expect(res.status).toBe(403);
  });

  test('need User Management: Edit Permissions to change other logins', async () => {
    const res = await request(app)
      .put(`/api/users/${a.staff1._id}`)
      .set(auth(a.tokens.manager))
      .send({ permissions: ['Dashboard', 'Jobs', 'Jobs: View'] });
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('User Management: Edit Permissions');
    // The rest of this block: a manager who does manage logins.
    await User.updateOne({ _id: a.manager._id }, { $addToSet: { permissions: { $each: ['User Management', 'User Management: View', 'User Management: Edit Permissions'] } } });
  });

  test('cannot grant permissions they do not hold', async () => {
    const res = await request(app)
      .put(`/api/users/${a.staff1._id}`)
      .set(auth(a.tokens.manager))
      .send({ permissions: ['Dashboard', 'Payroll', 'Payroll: View'] });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Payroll/);
  });

  test('can grant permissions they do hold', async () => {
    const res = await request(app)
      .put(`/api/users/${a.staff1._id}`)
      .set(auth(a.tokens.manager))
      .send({ permissions: ['Dashboard', 'Jobs', 'Jobs: View'] });
    expect(res.status).toBe(200);
    await User.updateOne({ _id: a.staff1._id }, { permissions: ['Dashboard'] });
  });
});
