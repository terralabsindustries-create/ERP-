/**
 * Dispatch & delivery: scheduling a delivery for a job, the views and counts
 * behind the page, the status flow (dispatch, delivered, failed, reschedule,
 * cancel), edits, deletes, and that one business never reaches another's.
 */
const request = require('supertest');
const app = require('../src/app');
const Delivery = require('../src/models/Delivery');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

const DAY = 864e5;
const dateStr = (offsetDays = 0) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const TODAY = dateStr(0);

let a;
let b;
let cust;
let job;
let bJob;

beforeAll(async () => {
  await connectTestDb('dispatch');
  a = await createOrg('da', { staffPermissions: ['Delivery', 'Delivery: View', 'Delivery: Update Status'] });
  b = await createOrg('db');
  cust = await make.customer(a.admin, { name: 'Lakeside Cafe', address: '12 Market Road, Kochi, Kerala' });
  job = await make.job(a.admin, cust, { title: 'Menu cards — 500 pcs' });
  const bCust = await make.customer(b.admin, { name: 'B Secret Customer' });
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
  jobId: String(job._id),
  deliveryAddress: { street: '12 Market Road', city: 'Kochi', state: 'Kerala', pincode: '682011', landmark: 'Near the boat jetty' },
  contactInfo: { name: 'Anil', phone: '+91 98470 00001' },
  deliveryDate: TODAY,
  deliveryTimeSlot: 'Morning (9AM-12PM)',
  priority: 'high',
  items: [{ description: 'Menu cards, boxed', quantity: 2 }],
  charges: { deliveryFee: 150 },
  paymentMethod: 'COD',
  codAmount: 2500,
  deliveryNotes: 'Call before coming',
  ...extra
});

const create = async (extra) => {
  const res = await as(a.tokens.admin).post('/api/deliveries', payload(extra));
  expect(res.status).toBe(201);
  return res.body.data.delivery;
};

describe('scheduling a delivery', () => {
  test('creates it with a challan number, the job and customer, and the business scope', async () => {
    const d = await create();
    expect(d.deliveryId).toMatch(/^DLV-\d{4}-\d{5}$/);
    expect(d.customerName).toBe('Lakeside Cafe');
    expect(d.jobTitle).toBe('Menu cards — 500 pcs');
    expect(d.jobId.title).toBe('Menu cards — 500 pcs');
    expect(d.status).toBe('scheduled');
    expect(d.deliveryDate.slice(0, 10)).toBe(TODAY);
    expect(d.charges.totalCharges).toBe(150);
    expect(d.codAmount).toBe(2500);
    expect(d.items).toEqual([expect.objectContaining({ description: 'Menu cards, boxed', quantity: 2 })]);
    expect(d.history).toHaveLength(1);

    const saved = await Delivery.findById(d._id);
    expect(saved.dataScope).toBe(a.dataScope);
    expect(String(saved.userId)).toBe(String(a.admin._id));
  });

  test('numbers are unique and follow on', async () => {
    const one = await create();
    const two = await create({ paymentMethod: 'Prepaid', codAmount: 0 });
    const n = (d) => parseInt(d.deliveryId.split('-')[2], 10);
    expect(n(two)).toBe(n(one) + 1);
    expect(two.codAmount).toBe(0);
  });

  test.each([
    ['no packages', { items: [] }, 'Add at least one package'],
    ['a short pincode', { deliveryAddress: { street: '1 Road', city: 'Kochi', state: 'Kerala', pincode: '6820' } }, 'Pincode must be 6 digits'],
    ['no street', { deliveryAddress: { street: ' ', city: 'Kochi', state: 'Kerala', pincode: '682011' } }, 'Enter the street address'],
    ['a bad phone', { contactInfo: { phone: '12345' } }, 'Enter a valid contact phone number'],
    ['no date', { deliveryDate: '' }, 'Choose the delivery date'],
    ['cash on delivery without an amount', { paymentMethod: 'COD', codAmount: 0 }, 'Enter the amount to collect on delivery'],
    ['a negative delivery charge', { charges: { deliveryFee: -5 } }, 'Delivery charge cannot be negative'],
    ['an unknown time slot', { deliveryTimeSlot: 'Midnight' }, 'Choose a time slot from the list'],
    ['a package without a quantity', { items: [{ description: 'Box', quantity: 0 }] }, 'Each package needs a quantity of at least 1'],
    ['no job', { jobId: 'nope' }, 'Choose the job this delivery is for']
  ])('refuses %s with 400', async (_label, extra, message) => {
    const before = await Delivery.countDocuments();
    const res = await as(a.tokens.admin).post('/api/deliveries', payload(extra));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(await Delivery.countDocuments()).toBe(before);
  });

  test("another business's job can't be used", async () => {
    const res = await as(a.tokens.admin).post('/api/deliveries', payload({ jobId: String(bJob._id) }));
    expect(res.status).toBe(404);
    expect(await Delivery.countDocuments({ jobId: bJob._id })).toBe(0);
  });

  test('a login with only Update Status cannot schedule one', async () => {
    const res = await as(a.tokens.staff1).post('/api/deliveries', payload());
    expect(res.status).toBe(403);
  });
});

describe('lists and views', () => {
  test('today, upcoming and all views with counts', async () => {
    const later = await create({ deliveryDate: dateStr(3), paymentMethod: 'Prepaid', codAmount: 0 });
    const res = await as(a.tokens.admin).get(`/api/deliveries?view=today&today=${TODAY}`);
    expect(res.status).toBe(200);
    const { deliveries, summary, pagination } = res.body.data;
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.deliveryDate.slice(0, 10) <= TODAY)).toBe(true);
    expect(deliveries.find((d) => d._id === later._id)).toBeUndefined();
    expect(pagination.totalDeliveries).toBe(deliveries.length);
    expect(summary.today).toBe(deliveries.length);
    expect(summary.upcoming).toBeGreaterThanOrEqual(1);
    expect(summary.all).toBe(await Delivery.countDocuments({ dataScope: a.dataScope }));

    const up = await as(a.tokens.admin).get(`/api/deliveries?view=upcoming&today=${TODAY}`);
    expect(up.body.data.deliveries.map((d) => d._id)).toContain(later._id);
  });

  test('search finds by customer, delivery number and city', async () => {
    const d = await create();
    for (const q of ['lakeside', d.deliveryId, 'kochi']) {
      const res = await as(a.tokens.admin).get(`/api/deliveries?search=${encodeURIComponent(q)}`);
      expect(res.body.data.deliveries.map((x) => x._id)).toContain(d._id);
    }
    const none = await as(a.tokens.admin).get('/api/deliveries?search=zzzz-nothing');
    expect(none.body.data.deliveries).toHaveLength(0);
  });

  test('a bad view is refused', async () => {
    expect((await as(a.tokens.admin).get('/api/deliveries?view=sometime')).status).toBe(400);
  });

  test('the dashboard still counts scheduled deliveries', async () => {
    const res = await as(a.tokens.admin).get('/api/dashboard/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats.pendingDeliveries).toBeGreaterThan(0);
  });
});

describe('status flow', () => {
  test('dispatch needs a driver; a driver login can dispatch and deliver', async () => {
    const d = await create();
    const url = `/api/deliveries/${d._id}/status`;
    let res = await as(a.tokens.staff1).put(url, { status: 'in_transit' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Add the driver before dispatching');

    res = await as(a.tokens.staff1).put(url, { status: 'in_transit', driverInfo: { name: 'Suresh', phone: '9847012345', vehicleNumber: 'kl 07 ab 1234' } });
    expect(res.status).toBe(200);
    expect(res.body.data.delivery.status).toBe('in_transit');
    expect(res.body.data.delivery.driverInfo).toMatchObject({ name: 'Suresh', vehicleNumber: 'KL 07 AB 1234' });
    expect(res.body.data.delivery.dispatchedAt).toBeTruthy();

    const inTransit = await as(a.tokens.admin).get('/api/deliveries?view=in_transit');
    expect(inTransit.body.data.deliveries.map((x) => x._id)).toContain(d._id);

    res = await as(a.tokens.staff1).put(url, { status: 'delivered' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Enter who received the delivery');

    res = await as(a.tokens.staff1).put(url, { status: 'delivered', receivedBy: 'Anil (manager)', note: 'Left at the counter' });
    expect(res.status).toBe(200);
    const done = res.body.data.delivery;
    expect(done.status).toBe('delivered');
    expect(done.deliveryProof).toMatchObject({ receivedBy: 'Anil (manager)', note: 'Left at the counter', deliveredBy: 'Suresh' });
    expect(done.history.map((h) => h.status)).toEqual(['scheduled', 'in_transit', 'delivered']);

    const list = await as(a.tokens.admin).get('/api/deliveries?view=delivered');
    expect(list.body.data.summary.deliveredThisWeek).toBeGreaterThanOrEqual(1);

    // Done is done: no more status changes or edits.
    expect((await as(a.tokens.admin).put(url, { status: 'failed', reason: 'x' })).status).toBe(409);
    expect((await as(a.tokens.admin).put(`/api/deliveries/${d._id}`, payload())).status).toBe(409);
  });

  test('a delivery time in the future is refused', async () => {
    const d = await create();
    const res = await as(a.tokens.admin).put(`/api/deliveries/${d._id}/status`, { status: 'delivered', receivedBy: 'Anil', deliveredAt: new Date(Date.now() + 2 * DAY).toISOString() });
    expect(res.status).toBe(400);
  });

  test('failed, then rescheduled to a new date as another attempt', async () => {
    const d = await create();
    const url = `/api/deliveries/${d._id}/status`;
    expect((await as(a.tokens.staff1).put(url, { status: 'failed' })).status).toBe(400);
    let res = await as(a.tokens.staff1).put(url, { status: 'failed', reason: 'Shop closed' });
    expect(res.status).toBe(200);
    expect(res.body.data.delivery).toMatchObject({ status: 'failed', failureReason: 'Shop closed' });

    const failedView = await as(a.tokens.admin).get('/api/deliveries?view=failed');
    expect(failedView.body.data.deliveries.map((x) => x._id)).toContain(d._id);
    expect(failedView.body.data.summary.failed).toBeGreaterThanOrEqual(1);

    res = await as(a.tokens.staff1).put(url, { status: 'scheduled', deliveryDate: dateStr(-2), today: TODAY });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('The new delivery date is in the past');

    res = await as(a.tokens.staff1).put(url, { status: 'scheduled', deliveryDate: dateStr(2), deliveryTimeSlot: 'Evening (3PM-6PM)', today: TODAY });
    expect(res.status).toBe(200);
    const again = res.body.data.delivery;
    expect(again.status).toBe('scheduled');
    expect(again.attempts).toBe(1);
    expect(again.rescheduleReason).toBe('Shop closed');
    expect(again.failureReason).toBeUndefined();
    expect(again.deliveryDate.slice(0, 10)).toBe(dateStr(2));
    expect(again.deliveryTimeSlot).toBe('Evening (3PM-6PM)');
  });

  test('cancelling needs Create & Edit, and a cancelled delivery shows with failed ones', async () => {
    const d = await create();
    const url = `/api/deliveries/${d._id}/status`;
    expect((await as(a.tokens.staff1).put(url, { status: 'cancelled' })).status).toBe(403);
    const res = await as(a.tokens.admin).put(url, { status: 'cancelled', reason: 'Customer will collect' });
    expect(res.status).toBe(200);
    expect(res.body.data.delivery).toMatchObject({ status: 'cancelled', cancelReason: 'Customer will collect' });
    const view = await as(a.tokens.admin).get('/api/deliveries?view=failed');
    expect(view.body.data.deliveries.map((x) => x._id)).toContain(d._id);
  });

  test('an unknown status is refused', async () => {
    const d = await create();
    expect((await as(a.tokens.admin).put(`/api/deliveries/${d._id}/status`, { status: 'lost' })).status).toBe(400);
  });
});

describe('editing and deleting', () => {
  test('edit changes the details and keeps the number', async () => {
    const d = await create();
    const res = await as(a.tokens.admin).put(`/api/deliveries/${d._id}`, payload({
      deliveryAddress: { street: '4 Broadway', city: 'Ernakulam', state: 'Kerala', pincode: '682031' },
      items: [{ description: 'Menu cards', quantity: 1 }, { description: 'Table tents', quantity: 20 }],
      paymentMethod: 'Prepaid',
      codAmount: 0,
      driverInfo: { name: 'Manoj' }
    }));
    expect(res.status).toBe(200);
    const e = res.body.data.delivery;
    expect(e.deliveryId).toBe(d.deliveryId);
    expect(e.deliveryAddress).toMatchObject({ street: '4 Broadway', city: 'Ernakulam', pincode: '682031' });
    expect(e.items).toHaveLength(2);
    expect(e.codAmount).toBe(0);
    expect(e.driverInfo.name).toBe('Manoj');
  });

  test('edit validates like create', async () => {
    const d = await create();
    const res = await as(a.tokens.admin).put(`/api/deliveries/${d._id}`, payload({ deliveryAddress: { street: 'x', city: 'y', state: 'Kerala', pincode: 'abcdef' } }));
    expect(res.status).toBe(400);
  });

  test('delete removes it', async () => {
    const d = await create();
    expect((await as(a.tokens.admin).del(`/api/deliveries/${d._id}`)).status).toBe(200);
    expect((await as(a.tokens.admin).get(`/api/deliveries/${d._id}`)).status).toBe(404);
  });

  test('a malformed id is not found rather than an error', async () => {
    expect((await as(a.tokens.admin).get('/api/deliveries/not-an-id')).status).toBe(404);
  });
});

describe('another business', () => {
  let d;
  beforeAll(async () => {
    d = await create();
  });

  test('cannot see the delivery in lists or by id', async () => {
    const list = await as(b.tokens.admin).get('/api/deliveries');
    expect(list.status).toBe(200);
    expect(list.body.data.deliveries).toHaveLength(0);
    expect(list.body.data.summary.all).toBe(0);
    expect((await as(b.tokens.admin).get(`/api/deliveries/${d._id}`)).status).toBe(404);
  });

  test('cannot change, edit or delete it', async () => {
    expect((await as(b.tokens.admin).put(`/api/deliveries/${d._id}/status`, { status: 'delivered', receivedBy: 'Someone' })).status).toBe(404);
    expect((await as(b.tokens.admin).put(`/api/deliveries/${d._id}`, payload({ jobId: String(bJob._id) }))).status).toBe(404);
    expect((await as(b.tokens.admin).del(`/api/deliveries/${d._id}`)).status).toBe(404);
    const saved = await Delivery.findById(d._id);
    expect(saved.status).toBe('scheduled');
    expect(saved.deliveryAddress.city).toBe('Kochi');
  });
});
