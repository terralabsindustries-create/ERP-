/**
 * Customer portal: staff issue a personal link, the customer opens it, and the
 * session only ever shows that customer's own records.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const CustomerFile = require('../src/models/CustomerFile');
const PortalAccess = require('../src/models/PortalAccess');
const PortalSession = require('../src/models/PortalSession');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let lotus;
let shah;
let lotusFile;
let shahFile;

beforeAll(async () => {
  await connectTestDb('portal');
  org = await createOrg('p');
  lotus = await make.customer(org.admin, { name: 'Lotus Publications' });
  shah = await make.customer(org.admin, { name: 'Shah Pharma' });
  await make.job(org.admin, lotus, { title: 'Lotus annual report' });
  await make.job(org.admin, shah, { title: 'Shah label roll' });
  await make.invoice(org.admin, lotus, { invoiceNumber: 'INV-LOTUS-1' });
  await make.invoice(org.admin, lotus, { invoiceNumber: 'INV-LOTUS-DRAFT', status: 'draft' });
  await make.invoice(org.admin, shah, { invoiceNumber: 'INV-SHAH-1' });
  const fileBase = { fileUrl: '/x', fileType: '.pdf', fileSize: 10, mimeType: 'application/pdf', uploadedBy: 'staff', userId: org.admin._id };
  lotusFile = await CustomerFile.create({ ...fileBase, fileName: 'lotus.pdf', originalName: 'lotus.pdf', customerId: lotus._id });
  shahFile = await CustomerFile.create({ ...fileBase, fileName: 'shah.pdf', originalName: 'shah.pdf', customerId: shah._id });
});
afterAll(disconnectTestDb);

const createLink = (token, customer, extra = {}) =>
  request(app).post('/api/portal/access').set(auth(token)).send({ customerId: String(customer._id), ...extra });
const tokenFromLink = (link) => link.split('/customer-portal/')[1];
const openSession = (linkToken) => request(app).post('/api/portal/session').send({ token: linkToken });
const portal = (session, url) => request(app).get(`/api/portal${url}`).set('X-Portal-Session', session);

describe('issuing links', () => {
  test('needs Customer Portal: Manage Access', async () => {
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Customer Portal', 'Customer Portal: View'] });
    expect((await createLink(org.tokens.staff1, lotus)).status).toBe(403);
    expect((await request(app).get('/api/portal/access').set(auth(org.tokens.staff1))).status).toBe(200);
  });

  test('only for customers in your business', async () => {
    const other = await createOrg('q');
    const theirs = await make.customer(other.admin, { name: 'Not yours' });
    expect((await createLink(org.tokens.admin, theirs)).status).toBe(404);
  });

  test('the raw token is returned once and only its hash is stored', async () => {
    const res = await createLink(org.tokens.admin, lotus, { expiresInDays: 7 });
    expect(res.status).toBe(201);
    const token = tokenFromLink(res.body.data.link);
    const stored = await PortalAccess.findById(res.body.data.access._id).select('+tokenHash');
    expect(stored.tokenHash).toBe(PortalSession.hashToken(token));
    expect(stored.tokenHash).not.toContain(token);
    expect(JSON.stringify(res.body.data.access)).not.toContain('tokenHash');
  });
});

describe('a customer session', () => {
  let session;

  beforeAll(async () => {
    const link = await createLink(org.tokens.admin, lotus);
    const res = await openSession(tokenFromLink(link.body.data.link));
    expect(res.status).toBe(200);
    session = res.body.data.sessionToken;
    expect(res.body.data.customer.name).toBe('Lotus Publications');
    expect(res.body.data.business.name).toBe('P Printers');
  });

  test('shows only that customer\'s orders, issued invoices and files', async () => {
    expect((await portal(session, '/orders')).body.data.jobs.map((j) => j.title)).toEqual(['Lotus annual report']);
    expect((await portal(session, '/invoices')).body.data.invoices.map((i) => i.invoiceNumber)).toEqual(['INV-LOTUS-1']);
    expect((await portal(session, '/files')).body.data.files.map((f) => f.originalName)).toEqual(['lotus.pdf']);
    const stats = (await portal(session, '/stats/summary')).body.data.stats;
    expect(stats).toMatchObject({ totalOrders: 1, totalInvoices: 1, totalFiles: 1 });
  });

  test('cannot fetch another customer\'s file by id', async () => {
    expect((await portal(session, `/files/${shahFile._id}/download`)).status).toBe(404);
    expect(String(lotusFile.customerId)).toBe(String(lotus._id));
  });

  test('requires the session header', async () => {
    expect((await request(app).get('/api/portal/orders')).status).toBe(401);
    expect((await portal('made-up-session-token', '/orders')).status).toBe(401);
  });

  test('ends when staff revoke the link', async () => {
    const link = await createLink(org.tokens.admin, lotus);
    const s = (await openSession(tokenFromLink(link.body.data.link))).body.data.sessionToken;
    expect((await portal(s, '/orders')).status).toBe(200);
    const revoke = await request(app).delete(`/api/portal/access/${link.body.data.access._id}`).set(auth(org.tokens.admin));
    expect(revoke.status).toBe(200);
    expect((await portal(s, '/orders')).status).toBe(401);
    expect((await openSession(tokenFromLink(link.body.data.link))).status).toBe(401);
  });

  test('cannot be opened with an expired link', async () => {
    const link = await createLink(org.tokens.admin, lotus);
    await PortalAccess.updateOne({ _id: link.body.data.access._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await openSession(tokenFromLink(link.body.data.link))).status).toBe(401);
  });

  test('sign out ends the session', async () => {
    const link = await createLink(org.tokens.admin, shah);
    const s = (await openSession(tokenFromLink(link.body.data.link))).body.data.sessionToken;
    expect((await request(app).post('/api/portal/logout').set('X-Portal-Session', s)).status).toBe(200);
    expect((await portal(s, '/orders')).status).toBe(401);
  });
});

test('the old phone-number login is gone', async () => {
  const res = await request(app).post('/api/portal/login').send({ phone: lotus.phone });
  expect(res.status).toBe(410);
});
