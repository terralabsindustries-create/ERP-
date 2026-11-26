/**
 * GET /api/customers?search= — the search behind every customer picker:
 * partial, case-insensitive, anywhere in the name, by company or phone,
 * literal (no regex injection), ranked prefix-first, and never across orgs.
 */
const request = require('supertest');
const app = require('../src/app');
const Customer = require('../src/models/Customer');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a;
let b;

beforeAll(async () => {
  await connectTestDb('custsearch');
  a = await createOrg('csa', { staffPermissions: ['Customers', 'Invoicing'] });
  b = await createOrg('csb', { staffPermissions: ['Customers'] });
  await make.customer(a.admin, { name: 'Rahul Sharma', company: 'Carbon Prints', phone: '98470 00001' });
  await make.customer(a.admin, { name: 'Abrar Khan', company: 'Khan Traders', phone: '+91 99999-11111' });
  await make.customer(a.admin, { name: 'Ravi (Main St)', phone: '9000012345' });
  await make.customer(a.admin, { name: 'Old Client', status: 'inactive' });
  await make.customer(b.admin, { name: 'Rahul Other Org', phone: '9847000001' });
});
afterAll(disconnectTestDb);

const search = (q, token = a.tokens.admin, extra = '') =>
  request(app).get(`/api/customers?limit=20&search=${encodeURIComponent(q)}${extra}`).set(auth(token));
const names = (res) => res.body.data.customers.map((c) => c.name);

test('first few characters of a name', async () => {
  const res = await search('rah');
  expect(res.status).toBe(200);
  expect(names(res)).toEqual(['Rahul Sharma']);
});

test('characters from the middle of a name, any case', async () => {
  expect(names(await search('SHAR'))).toEqual(['Rahul Sharma']);
  expect(names(await search('hArMa'))).toEqual(['Rahul Sharma']);
});

test('by company name', async () => {
  expect(names(await search('traders'))).toEqual(['Abrar Khan']);
});

test('by phone, whatever way the number was saved or typed', async () => {
  expect(names(await search('9847000001'))).toEqual(['Rahul Sharma']);
  expect(names(await search('98470 00001'))).toEqual(['Rahul Sharma']);
  expect(names(await search('9999911111'))).toEqual(['Abrar Khan']);
  expect(names(await search('+91 99999'))).toEqual(['Abrar Khan']);
});

test('regex characters are matched literally, not as a pattern', async () => {
  const res = await search('(Main');
  expect(res.status).toBe(200);
  expect(names(res)).toEqual(['Ravi (Main St)']);
  expect((await search('.*')).body.data.customers).toHaveLength(0);
  expect((await search('+')).status).toBe(200);
});

test('names that start with the text come first, then alphabetical', async () => {
  // "ra" starts Rahul and Ravi, and sits inside Abrar.
  expect(names(await search('ra'))).toEqual(['Rahul Sharma', 'Ravi (Main St)', 'Abrar Khan']);
});

test('a customer that does not exist gives an empty list', async () => {
  const res = await search('zzzz-nobody');
  expect(res.status).toBe(200);
  expect(res.body.data.customers).toEqual([]);
});

test('never returns another organisation’s customers', async () => {
  expect(names(await search('rahul'))).toEqual(['Rahul Sharma']);
  expect(names(await search('rahul', b.tokens.admin))).toEqual(['Rahul Other Org']);
});

test('inactive customers only when asked for', async () => {
  expect(names(await search('old'))).toEqual([]);
  expect(names(await search('old', a.tokens.admin, '&status=all'))).toEqual(['Old Client']);
});

test('stays fast and unique with thousands of customers', async () => {
  const scope = { createdBy: a.admin._id, userId: a.admin._id, dataScope: a.admin.dataScope, status: 'active' };
  await Customer.insertMany(
    Array.from({ length: 3000 }, (_, i) => ({ ...scope, name: `Bulk Customer ${String(i).padStart(4, '0')}`, phone: `70${String(i).padStart(8, '0')}` }))
  );
  const started = Date.now();
  const res = await search('customer 29');
  expect(res.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(2000);
  const list = res.body.data.customers;
  expect(list).toHaveLength(20);
  expect(new Set(list.map((c) => c._id)).size).toBe(20);
  expect(res.body.data.pagination.totalCustomers).toBe(100); // Bulk Customer 2900–2999
  expect(list[0].name).toBe('Bulk Customer 2900');
});
