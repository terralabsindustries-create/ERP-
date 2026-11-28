/** GSTIN format + check-digit validation on customers, vendors and settings. */
const request = require('supertest');
const app = require('../src/app');
const { gstinError, checkChar } = require('../src/utils/gstin');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

const VALID = '27AAPFU0939F1ZV';
let org;
beforeAll(async () => {
  await connectTestDb('gstin');
  org = await createOrg('gst', { staffPermissions: ['Customers', 'Vendors'] });
});
afterAll(disconnectTestDb);

describe('gstinError', () => {
  test('accepts a valid GSTIN, in any case/spacing, and blank', () => {
    expect(gstinError(VALID)).toBeNull();
    expect(gstinError(' 27aapfu0939f1zv ')).toBeNull();
    expect(gstinError('')).toBeNull();
    expect(gstinError(undefined)).toBeNull();
  });
  test('rejects wrong length, format and checksum', () => {
    expect(gstinError('ABC123')).toMatch(/15 characters/);
    expect(gstinError('99AAPFU0939F1ZV')).toMatch(/format/);
    expect(gstinError('27AAPFU0939F1ZX')).toMatch(/check digit/);
    expect(checkChar('27AAPFU0939F1Z')).toBe('V');
  });
});

describe('API', () => {
  const post = (path, body) => request(app).post(path).set(auth(org.tokens.admin)).send(body);

  test('customer: ABC123 is refused, valid and blank are accepted', async () => {
    const bad = await post('/api/customers', { name: 'Bad GST', gstNumber: 'ABC123' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/15 characters/);
    const ok = await post('/api/customers', { name: 'Good GST', gstNumber: VALID.toLowerCase() });
    expect(ok.status).toBe(201);
    const none = await post('/api/customers', { name: 'Unregistered' });
    expect(none.status).toBe(201);
  });

  test('customer update and vendor create enforce it too', async () => {
    const c = (await post('/api/customers', { name: 'Edit Me' })).body.data.customer;
    const upd = await request(app).put(`/api/customers/${c._id}`).set(auth(org.tokens.admin)).send({ name: 'Edit Me', gstNumber: '27AAPFU0939F1ZX' });
    expect(upd.status).toBe(400);
    const v = await post('/api/vendors', { name: 'Vend', gstNumber: 'ABC123' });
    expect(v.status).toBe(400);
    expect((await post('/api/vendors', { name: 'Vend', gstNumber: VALID })).status).toBe(201);
  });
});

describe('customer state', () => {
  const post = (body) => request(app).post('/api/customers').set(auth(org.tokens.admin)).send(body);
  test('a state is saved as its official name; an unknown one is refused; it is optional', async () => {
    const ok = await post({ name: 'Kerala Cust', gstNumber: VALID, state: 'kerala' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.customer.state).toBe('Kerala');
    expect((await post({ name: 'Nowhere', state: 'Atlantis' })).status).toBe(400);
    const none = await post({ name: 'No State' });
    expect(none.status).toBe(201);
    expect(none.body.data.customer.state).toBeUndefined();
  });
});

