/**
 * Rush orders: taking one, the views and counts behind the page, starting,
 * completing and cancelling, converting one into a real job (through the jobs
 * API, the way the page does), and that one business never reaches another's.
 */
const request = require('supertest');
const app = require('../src/app');
const EmergencyOrder = require('../src/models/EmergencyOrder');
const Job = require('../src/models/Job');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

const HOUR = 3600e3;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

let a;
let b;
let cust;
let bCust;
let bJob;

beforeAll(async () => {
  await connectTestDb('rushorders');
  a = await createOrg('ra', { staffPermissions: ['Emergency Orders', 'Emergency Orders: View'] });
  b = await createOrg('rb');
  cust = await make.customer(a.admin, { name: 'Meera Pillai', phone: '9847011001' });
  bCust = await make.customer(b.admin, { name: 'B Secret Customer' });
  bJob = await make.job(b.admin, bCust, { title: 'B Secret Job' });
});
afterAll(disconnectTestDb);

const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  del: (url) => request(app).delete(url).set(auth(token))
});

const payload = (extra = {}) => ({
  customerName: 'Walk-in: Joseph',
  customerPhone: '+91 98470 22222',
  orderDetails: '200 visiting cards, matte, both sides',
  estimatedAmount: 1500,
  advancePaid: 500,
  priority: 'urgent',
  expectedCompletion: inHours(3),
  notes: 'Needs them before the evening meeting',
  ...extra
});

const create = async (extra) => {
  const res = await as(a.tokens.admin).post('/api/emergency-orders', payload(extra));
  expect(res.status).toBe(201);
  return res.body.data.emergencyOrder;
};

describe('taking a rush order', () => {
  test('creates it with an order number and the business scope', async () => {
    const o = await create();
    expect(o.orderId).toMatch(/^RO-\d{4}-\d{5}$/);
    expect(o).toMatchObject({ status: 'pending', customerName: 'Walk-in: Joseph', estimatedAmount: 1500, advancePaid: 500, priority: 'urgent' });
    const saved = await EmergencyOrder.findById(o._id);
    expect(saved.dataScope).toBe(a.dataScope);
  });

  test('numbers are unique and follow on', async () => {
    const one = await create();
    const two = await create();
    const n = (o) => parseInt(o.orderId.split('-')[2], 10);
    expect(n(two)).toBe(n(one) + 1);
  });

  test('can be taken for an existing customer', async () => {
    const o = await create({ customerId: String(cust._id), customerName: cust.name, customerPhone: cust.phone });
    expect(o.customerId._id).toBe(String(cust._id));
  });

  test.each([
    ['no customer name', { customerName: '' }, 'Enter the customer name'],
    ['a bad phone', { customerPhone: '123' }, 'Enter a valid phone number'],
    ['no details', { orderDetails: '  ' }, 'Describe what the customer needs'],
    ['a negative amount', { estimatedAmount: -1 }, 'Enter the estimated amount (zero or more)'],
    ['an advance above the estimate', { advancePaid: 2000 }, 'The advance is more than the estimated amount'],
    ['no needed-by time', { expectedCompletion: '' }, 'Choose when it is needed by'],
    ['an unknown priority', { priority: 'whenever' }, 'Choose a priority from the list'],
    ['a bad email', { customerEmail: 'not-an-email' }, 'Enter a valid email address']
  ])('refuses %s with 400', async (_label, extra, message) => {
    const before = await EmergencyOrder.countDocuments();
    const res = await as(a.tokens.admin).post('/api/emergency-orders', payload(extra));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(await EmergencyOrder.countDocuments()).toBe(before);
  });

  test("another business's customer can't be picked", async () => {
    const res = await as(a.tokens.admin).post('/api/emergency-orders', payload({ customerId: String(bCust._id) }));
    expect(res.status).toBe(404);
  });

  test('a view-only login cannot take one', async () => {
    expect((await as(a.tokens.staff1).post('/api/emergency-orders', payload())).status).toBe(403);
  });
});

describe('lists and views', () => {
  test('due within 24 hours includes overdue ones and leaves out later ones', async () => {
    const soon = await create({ expectedCompletion: inHours(5) });
    const late = await create({ expectedCompletion: inHours(-2) });
    const later = await create({ expectedCompletion: inHours(72) });

    const res = await as(a.tokens.admin).get('/api/emergency-orders?view=due');
    expect(res.status).toBe(200);
    const ids = res.body.data.emergencyOrders.map((o) => o._id);
    expect(ids).toEqual(expect.arrayContaining([soon._id, late._id]));
    expect(ids).not.toContain(later._id);
    const { summary } = res.body.data;
    expect(summary.due).toBe(ids.length);
    expect(summary.overdue).toBeGreaterThanOrEqual(1);
    expect(summary.open).toBeGreaterThanOrEqual(3);
    expect(summary.openEstimated).toBeGreaterThan(0);
    expect(summary.openAdvance).toBeGreaterThan(0);

    // Open orders are listed soonest first.
    const open = await as(a.tokens.admin).get('/api/emergency-orders?view=open&limit=100');
    const times = open.body.data.emergencyOrders.map((o) => o.expectedCompletion);
    expect([...times].sort()).toEqual(times);
  });

  test('a view-only login can read the list; search works', async () => {
    const o = await create({ customerName: 'Sreedevi Menon' });
    const res = await as(a.tokens.staff1).get('/api/emergency-orders?search=sreedevi');
    expect(res.status).toBe(200);
    expect(res.body.data.emergencyOrders.map((x) => x._id)).toEqual([o._id]);
    const byNumber = await as(a.tokens.admin).get(`/api/emergency-orders?search=${o.orderId}`);
    expect(byNumber.body.data.emergencyOrders.map((x) => x._id)).toEqual([o._id]);
  });

  test('a bad view is refused', async () => {
    expect((await as(a.tokens.admin).get('/api/emergency-orders?view=later')).status).toBe(400);
  });
});

describe('status changes', () => {
  test('start, then complete', async () => {
    const o = await create();
    const url = `/api/emergency-orders/${o._id}/status`;
    let res = await as(a.tokens.admin).put(url, { status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body.data.emergencyOrder.status).toBe('in_progress');
    expect(res.body.data.emergencyOrder.startedAt).toBeTruthy();

    res = await as(a.tokens.admin).put(url, { status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body.data.emergencyOrder.status).toBe('completed');
    expect(res.body.data.emergencyOrder.actualCompletion).toBeTruthy();

    expect((await as(a.tokens.admin).put(url, { status: 'completed' })).status).toBe(409);
    expect((await as(a.tokens.admin).put(url, { status: 'cancelled' })).status).toBe(409);

    const done = await as(a.tokens.admin).get('/api/emergency-orders?view=completed');
    expect(done.body.data.emergencyOrders.map((x) => x._id)).toContain(o._id);
    expect(done.body.data.summary.completedThisWeek).toBeGreaterThanOrEqual(1);
  });

  test('cancel', async () => {
    const o = await create();
    const res = await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}/status`, { status: 'cancelled', reason: 'Customer changed plans' });
    expect(res.status).toBe(200);
    expect(res.body.data.emergencyOrder).toMatchObject({ status: 'cancelled', cancelReason: 'Customer changed plans' });
    const view = await as(a.tokens.admin).get('/api/emergency-orders?view=cancelled');
    expect(view.body.data.emergencyOrders.map((x) => x._id)).toContain(o._id);
  });

  test('converted cannot be set by hand, nor an unknown status', async () => {
    const o = await create();
    expect((await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}/status`, { status: 'converted' })).status).toBe(400);
    expect((await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}/status`, { status: 'nope' })).status).toBe(400);
  });

  test('a view-only login cannot change status', async () => {
    const o = await create();
    expect((await as(a.tokens.staff1).put(`/api/emergency-orders/${o._id}/status`, { status: 'in_progress' })).status).toBe(403);
  });
});

describe('converting to a job', () => {
  test('creates a real job through the jobs API and links it', async () => {
    const o = await create();
    // What the page does: find or create the customer, create the job, then link it.
    const c = await as(a.tokens.admin).post('/api/customers', { name: o.customerName, phone: '9847022222' });
    expect(c.status).toBe(201);
    const j = await as(a.tokens.admin).post('/api/jobs', {
      title: 'Visiting cards — rush',
      customerId: c.body.data.customer._id,
      description: o.orderDetails,
      priority: 'urgent',
      dueDate: o.expectedCompletion,
      estimatedCost: o.estimatedAmount
    });
    expect(j.status).toBe(201);
    const jobId = j.body.data.job._id;

    const res = await as(a.tokens.admin).post(`/api/emergency-orders/${o._id}/convert`, { jobId });
    expect(res.status).toBe(200);
    const conv = res.body.data.emergencyOrder;
    expect(conv.status).toBe('converted');
    expect(conv.jobId).toMatchObject({ _id: jobId, title: 'Visiting cards — rush' });
    expect(conv.customerId._id).toBe(c.body.data.customer._id);
    expect(conv.convertedAt).toBeTruthy();
    expect(await Job.countDocuments({ _id: jobId, dataScope: a.dataScope })).toBe(1);

    // Only once, and it can no longer be edited.
    expect((await as(a.tokens.admin).post(`/api/emergency-orders/${o._id}/convert`, { jobId })).status).toBe(409);
    expect((await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}`, payload())).status).toBe(409);

    // Converted orders count as done.
    const done = await as(a.tokens.admin).get('/api/emergency-orders?view=completed');
    expect(done.body.data.emergencyOrders.map((x) => x._id)).toContain(o._id);
    expect(done.body.data.summary.converted).toBeGreaterThanOrEqual(1);
  });

  test("another business's job can't be linked, and a job id is required", async () => {
    const o = await create();
    expect((await as(a.tokens.admin).post(`/api/emergency-orders/${o._id}/convert`, { jobId: String(bJob._id) })).status).toBe(404);
    expect((await as(a.tokens.admin).post(`/api/emergency-orders/${o._id}/convert`, {})).status).toBe(400);
    expect((await EmergencyOrder.findById(o._id)).status).toBe('pending');
  });

  test("a cancelled order can't be converted", async () => {
    const o = await create();
    await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}/status`, { status: 'cancelled' });
    const j = await make.job(a.admin, cust);
    expect((await as(a.tokens.admin).post(`/api/emergency-orders/${o._id}/convert`, { jobId: String(j._id) })).status).toBe(409);
  });
});

describe('editing and deleting', () => {
  test('edit changes the details', async () => {
    const o = await create();
    const res = await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}`, payload({ orderDetails: '300 visiting cards', estimatedAmount: 2100, advancePaid: 1000, priority: 'high' }));
    expect(res.status).toBe(200);
    expect(res.body.data.emergencyOrder).toMatchObject({ orderId: o.orderId, orderDetails: '300 visiting cards', estimatedAmount: 2100, advancePaid: 1000, priority: 'high' });
  });

  test('edit validates like create', async () => {
    const o = await create();
    expect((await as(a.tokens.admin).put(`/api/emergency-orders/${o._id}`, payload({ customerPhone: 'abc' }))).status).toBe(400);
  });

  test('delete removes it', async () => {
    const o = await create();
    expect((await as(a.tokens.admin).del(`/api/emergency-orders/${o._id}`)).status).toBe(200);
    expect((await as(a.tokens.admin).get(`/api/emergency-orders/${o._id}`)).status).toBe(404);
  });
});

describe('another business', () => {
  let o;
  beforeAll(async () => {
    o = await create({ customerName: 'A Private Customer' });
  });

  test('cannot see the order', async () => {
    const list = await as(b.tokens.admin).get('/api/emergency-orders');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/A Private Customer/);
    expect(list.body.data.summary.all).toBe(0);
    expect((await as(b.tokens.admin).get(`/api/emergency-orders/${o._id}`)).status).toBe(404);
  });

  test('cannot change, edit, convert or delete it', async () => {
    expect((await as(b.tokens.admin).put(`/api/emergency-orders/${o._id}/status`, { status: 'cancelled' })).status).toBe(404);
    expect((await as(b.tokens.admin).put(`/api/emergency-orders/${o._id}`, payload())).status).toBe(404);
    expect((await as(b.tokens.admin).post(`/api/emergency-orders/${o._id}/convert`, { jobId: String(bJob._id) })).status).toBe(404);
    expect((await as(b.tokens.admin).del(`/api/emergency-orders/${o._id}`)).status).toBe(404);
    const saved = await EmergencyOrder.findById(o._id);
    expect(saved.status).toBe('pending');
    expect(saved.customerName).toBe('A Private Customer');
  });
});
