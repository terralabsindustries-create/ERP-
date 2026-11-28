/**
 * Customers and job tickets are searched, filtered, sorted and paged on the
 * server: results and totals cover every record, not the page shown.
 */
const request = require('supertest');
const app = require('../src/app');
const Customer = require('../src/models/Customer');
const Job = require('../src/models/Job');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
const TYPES = ['Walk-in', 'Agency', 'Business', 'Individual', 'Corporate'];

beforeAll(async () => {
  await connectTestDb('serverpaging');
  org = await createOrg('sp');
  other = await createOrg('spo');
  const own = { userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope };
  await Customer.insertMany(Array.from({ length: 1500 }, (_, i) => ({
    name: `${i % 2 ? 'zeta' : 'Alpha'} Customer ${String(i).padStart(4, '0')}`,
    phone: `98${String(10000000 + i)}`, customerType: TYPES[i % 5], status: i % 10 === 0 ? 'inactive' : 'active',
    gstNumber: i % 3 === 0 ? `27AAPFU${String(i).padStart(4, '0')}F1ZV` : undefined, gstVerified: i % 6 === 0,
    tags: i % 50 === 0 ? ['vip'] : [], ...own
  })));
  await Customer.insertMany(Array.from({ length: 50 }, (_, i) => ({ name: `Alpha Customer ${i}`, phone: '9000000000', userId: other.admin._id, createdBy: other.admin._id, dataScope: other.dataScope })));
  await Customer.init();
});
afterAll(disconnectTestDb);

const get = (url, token = org.tokens.admin) => request(app).get(url).set(auth(token));

describe('customers', () => {
  test('pages carry a total over all 1,500 and never another business', async () => {
    const res = await get('/api/customers?status=all&limit=50&page=2&sortBy=name&sortOrder=asc');
    expect(res.status).toBe(200);
    expect(res.body.data.customers).toHaveLength(50);
    expect(res.body.data.pagination).toMatchObject({ totalCustomers: 1500, total: 30, current: 2 });
  });

  test('name sort ignores case and is stable across pages', async () => {
    const p1 = (await get('/api/customers?status=all&limit=100&page=1&sortBy=name&sortOrder=asc')).body.data.customers.map((c) => c.name);
    const p2 = (await get('/api/customers?status=all&limit=100&page=2&sortBy=name&sortOrder=asc')).body.data.customers.map((c) => c.name);
    const both = [...p1, ...p2];
    expect(new Set(both).size).toBe(200);
    const lower = both.map((n) => n.toLowerCase());
    expect(lower).toEqual([...lower].sort());
  });

  test('search covers the whole dataset, not one page', async () => {
    const res = await get('/api/customers?status=all&limit=10&search=1499');
    expect(res.body.data.customers.map((c) => c.name)).toEqual(['zeta Customer 1499']);
    const phone = await get('/api/customers?status=all&limit=10&search=9810001499');
    expect(phone.body.data.pagination.totalCustomers).toBe(1);
    // GSTINs exist only on every third customer.
    expect((await get('/api/customers?status=all&limit=10&search=27AAPFU1498')).body.data.pagination.totalCustomers).toBe(0);
    expect((await get('/api/customers?status=all&limit=10&search=27AAPFU1494')).body.data.pagination.totalCustomers).toBe(1);
  });

  test('views, GST and tag filters count on the server', async () => {
    const view = async (v) => (await get(`/api/customers?view=${v}&limit=1`)).body.data.pagination.totalCustomers;
    const sum = await get('/api/customers/stats/summary');
    expect(sum.status).toBe(200);
    const { counts } = sum.body.data;
    expect(counts.all).toBe(1500);
    expect(counts.inactive).toBe(150);
    for (const v of ['walkin', 'agency', 'business', 'individual', 'inactive']) expect(await view(v)).toBe(counts[v]);
    expect(counts.walkin + counts.agency + counts.business + counts.individual + counts.inactive).toBe(1500);
    expect(sum.body.data.tags).toEqual(['vip']);
    expect((await get('/api/customers?status=all&tag=vip&limit=1')).body.data.pagination.totalCustomers).toBe(30);
    expect((await get('/api/customers?status=all&gst=verified&limit=1')).body.data.pagination.totalCustomers).toBe(250);
    expect((await get('/api/customers?status=all&gst=unverified&limit=1')).body.data.pagination.totalCustomers).toBe(250);
    expect((await get('/api/customers?status=all&gst=none&limit=1')).body.data.pagination.totalCustomers).toBe(1000);
  });

  test('unknown sort fields are refused', async () => {
    expect((await get('/api/customers?sortBy=password')).status).toBe(400);
  });

  test('bulk deactivate reports each record and stays inside the business', async () => {
    const mine = await Customer.find({ dataScope: org.dataScope, status: 'active' }).limit(2);
    const theirs = await Customer.findOne({ dataScope: other.dataScope });
    const res = await request(app).post('/api/customers/bulk').set(auth(org.tokens.admin))
      .send({ action: 'deactivate', ids: [String(mine[0]._id), String(mine[1]._id), String(theirs._id), 'bogus'] });
    expect(res.status).toBe(200);
    expect(res.body.data.succeeded).toHaveLength(2);
    expect(res.body.data.failed.map((f) => f.reason)).toEqual(['Not found in your business', 'Not found in your business']);
    expect((await Customer.findById(theirs._id)).status).toBe('active');
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Customers', 'Customers: View', 'Customers: Create & Edit'] });
    const denied = await request(app).post('/api/customers/bulk').set(auth(org.tokens.staff1)).send({ action: 'deactivate', ids: [String(mine[0]._id)] });
    expect(denied.status).toBe(403);
  });
});

describe('job tickets', () => {
  let cust;
  beforeAll(async () => {
    cust = await make.customer(org.admin, { name: 'Paging Press' });
    const statuses = ['inquiry', 'quotation_sent', 'design_in_progress', 'completed', 'delivered', 'cancelled'];
    const day = 864e5;
    await Job.insertMany(Array.from({ length: 120 }, (_, i) => ({
      title: `Paged job ${i}`, customerId: cust._id, status: statuses[i % 6], priority: ['low', 'medium', 'high', 'urgent'][i % 4],
      dueDate: new Date(Date.now() + ((i % 4) - 2) * day), createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 30))),
      userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope
    })));
  });

  test('stage groups, priority, date range and overdue filter on the server', async () => {
    const total = async (q) => (await get(`/api/jobs?limit=5&${q}`)).body.data.pagination.totalJobs;
    expect(await total('')).toBe(120);
    expect(await total('stage=pre_production')).toBe(40);
    expect(await total('stage=in_production')).toBe(20);
    expect(await total('stage=ready')).toBe(20);
    expect(await total('stage=closed')).toBe(40);
    expect(await total('priority=urgent')).toBe(30);
    expect(await total('from=2026-10-01&to=2026-10-10')).toBe(40);
    expect(await total('overdue=true')).toBeGreaterThan(0);
    expect(await total(`customerId=${cust._id}&search=Paged%20job%2011`)).toBe(11);
  });

  test('page summary counts every job', async () => {
    const res = await get('/api/jobs/stats/summary');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 120, completed: 40 });
  });

  test('a different business sees none of them', async () => {
    expect((await get('/api/jobs?limit=5', other.tokens.admin)).body.data.pagination.totalJobs).toBe(0);
  });
});
