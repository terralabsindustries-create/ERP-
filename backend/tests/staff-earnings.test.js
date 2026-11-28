/**
 * GET /api/jobs/staff/stats: a staff member's design-charge earnings are the
 * design charges WITHOUT GST on the job tickets they created; cancelled jobs
 * and other people's jobs don't count. GST and the inclusive figure come alongside.
 */
const request = require('supertest');
const app = require('../src/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
const dc = (amount, gstRate = 18) => ({ designCharge: { amount, gstRate, gstAmount: (amount * gstRate) / 100, totalAmount: amount + (amount * gstRate) / 100 } });

beforeAll(async () => {
  await connectTestDb('staff_earnings');
  org = await createOrg('se', { staffPermissions: ['Dashboard', 'Jobs'] });
  const cust = await make.customer(org.admin);
  await make.job(org.staff1, cust, dc(1000));
  await make.job(org.staff1, cust, dc(120.5, 5));
  await make.job(org.staff1, cust, { status: 'cancelled', ...dc(9999) });
  await make.job(org.staff2, cust, dc(7777));
});
afterAll(disconnectTestDb);

test('earnings are design charges without GST, cancelled jobs excluded', async () => {
  const res = await request(app).get('/api/jobs/staff/stats?period=all').set(auth(org.tokens.staff1));
  expect(res.status).toBe(200);
  expect(res.body.data.totalDesignCharge).toBe(1120.5);
  expect(res.body.data.designChargeGst).toBe(186.03);
  expect(res.body.data.designChargeWithGst).toBe(1306.53);
});

test('job counts: created, proof approved, pending approval, cancelled apart', async () => {
  const cust = await make.customer(org.admin);
  await make.job(org.staff2, cust, { status: 'design_approved' });
  await make.job(org.staff2, cust, { status: 'delivered' });
  await make.job(org.staff2, cust, { status: 'inquiry' });
  await make.job(org.staff2, cust, { status: 'cancelled' });
  const res = await request(app).get('/api/jobs/staff/stats?period=all').set(auth(org.tokens.staff2));
  expect(res.status).toBe(200);
  // + the design_in_progress job from beforeAll (pending)
  expect(res.body.data.jobs).toEqual({ created: 4, approved: 2, pending: 2, cancelled: 1 });
});
