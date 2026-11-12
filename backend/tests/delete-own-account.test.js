/**
 * The owner (admin) deleting their own account closes the business: every
 * login and record in it goes, and no other business is touched. Nobody else
 * can delete their own login.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Job = require('../src/models/Job');
const Invoice = require('../src/models/Invoice');
const Task = require('../src/models/Task');
const Event = require('../src/models/Event');
const NumberSequence = require('../src/models/NumberSequence');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
const closeAccount = (token, body) =>
  request(app).post('/api/users/me/delete-account').set(auth(token)).send(body);

const seed = async (o) => {
  const cust = await make.customer(o.admin);
  await make.job(o.manager, cust);
  await make.invoice(o.admin, cust);
  await make.task(o.manager, o.staff1);
  await make.event(o.staff2);
  await NumberSequence.create({ _id: `invoice:${o.dataScope}:202611`, value: 4 });
};

beforeAll(async () => {
  await connectTestDb('closeacct');
  org = await createOrg('ca');
  other = await createOrg('cb');
  await seed(org);
  await seed(other);
});
afterAll(disconnectTestDb);

const counts = async (o) => {
  const ids = [o.admin, o.manager, o.staff1, o.staff2].map((u) => u._id);
  return {
    users: await User.countDocuments({ dataScope: o.dataScope }),
    customers: await Customer.countDocuments({ dataScope: o.dataScope }),
    jobs: await Job.countDocuments({ dataScope: o.dataScope }),
    invoices: await Invoice.countDocuments({ dataScope: o.dataScope }),
    tasks: await Task.countDocuments({ userId: { $in: ids } }),
    events: await Event.countDocuments({ userId: { $in: ids } }),
    sequences: await NumberSequence.countDocuments({ _id: { $regex: o.dataScope } })
  };
};

test('managers and staff cannot delete their own login', async () => {
  for (const who of ['manager', 'staff1']) {
    const res = await closeAccount(org.tokens[who], { password: 'Passw0rd!', confirmText: 'DELETE' });
    expect(res.status).toBe(403);
  }
  expect((await counts(org)).users).toBe(4);
});

test('the owner must give their password and type DELETE', async () => {
  expect((await closeAccount(org.tokens.admin, { password: 'Passw0rd!', confirmText: 'delete' })).status).toBe(400);
  const wrong = await closeAccount(org.tokens.admin, { password: 'nope', confirmText: 'DELETE' });
  expect(wrong.status).toBe(400); // not 401: a typo must not sign them out
  expect((await counts(org)).customers).toBe(1);
});

test('the old delete route still refuses the owner deleting themselves', async () => {
  const res = await request(app).delete(`/api/users/${org.admin._id}`).set(auth(org.tokens.admin));
  expect(res.status).toBe(400);
});

test('the owner deletes their account and the whole business, and nothing else', async () => {
  const before = await counts(other);
  const res = await closeAccount(org.tokens.admin, { password: 'Passw0rd!', confirmText: 'DELETE' });
  expect(res.status).toBe(200);

  expect(await counts(org)).toEqual({ users: 0, customers: 0, jobs: 0, invoices: 0, tasks: 0, events: 0, sequences: 0 });
  expect(await counts(other)).toEqual(before);

  // Their tokens no longer work, and the email is free to sign up again.
  expect((await request(app).get('/api/auth/me').set(auth(org.tokens.admin))).status).toBe(401);
  expect((await request(app).get('/api/auth/me').set(auth(org.tokens.staff1))).status).toBe(401);
  expect(await User.findOne({ email: org.admin.email })).toBeNull();
});
