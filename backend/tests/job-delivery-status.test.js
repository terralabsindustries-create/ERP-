/**
 * GET /api/jobs carries each job's deliveries (newest first, cancelled ones
 * left out) so Job Tickets can show the delivery state beside the payment
 * state; only for logins with the Delivery permission.
 */
const request = require('supertest');
const app = require('../src/app');
const Delivery = require('../src/models/Delivery');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let delivered;
let pending;
let none;

beforeAll(async () => {
  await connectTestDb('job_delivery_status');
  await Delivery.init();
  org = await createOrg('jd', { managerPermissions: ['Dashboard', 'Jobs', 'Customers', 'Invoicing'] });
  const cust = await make.customer(org.admin);
  delivered = await make.job(org.admin, cust, { status: 'completed', title: 'Delivered job' });
  pending = await make.job(org.admin, cust, { status: 'completed', title: 'Pending job' });
  none = await make.job(org.admin, cust, { status: 'completed', title: 'No delivery job' });
  await make.invoice(org.admin, cust, { jobId: delivered._id });
  const older = await make.delivery(org.admin, cust, delivered, { status: 'failed' });
  await Delivery.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 864e5) } });
  await make.delivery(org.admin, cust, delivered, { status: 'delivered', deliveryProof: { deliveredAt: new Date() } });
  await make.delivery(org.admin, cust, pending, { status: 'cancelled' });
  await make.delivery(org.admin, cust, pending, { status: 'in_transit' });
});
afterAll(disconnectTestDb);

const list = async (token) => {
  const res = await request(app).get('/api/jobs?limit=50').set(auth(token));
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.data.jobs.map((j) => [j.title, j]));
};

test('each job lists its deliveries, newest first, without cancelled ones', async () => {
  const jobs = await list(org.tokens.admin);
  expect(jobs['Delivered job'].deliveries.map((d) => d.status)).toEqual(['delivered', 'failed']);
  expect(jobs['Delivered job'].deliveries[0].deliveryProof.deliveredAt).toBeTruthy();
  expect(jobs['Delivered job'].invoices).toHaveLength(1); // payment state still comes alongside
  expect(jobs['Pending job'].deliveries.map((d) => d.status)).toEqual(['in_transit']);
  expect(jobs['No delivery job'].deliveries).toEqual([]);
});

test('logins without the Delivery permission do not get deliveries', async () => {
  const jobs = await list(org.tokens.manager);
  expect(jobs['Delivered job'].deliveries).toBeUndefined();
});
