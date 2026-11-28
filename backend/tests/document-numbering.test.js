/**
 * Document numbering: the default series is unchanged, a financial-year
 * series can be chosen, GST's 16-character limit is enforced, issued numbers
 * never change, and new item codes use their own prefix.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const { financialYearOf } = require('../src/utils/financialYear');

let org;
let cust;
const api = (t) => ({ get: (u) => request(app).get(u).set(auth(t)), put: (u, b) => request(app).put(u).set(auth(t)).send(b), post: (u, b) => request(app).post(u).set(auth(t)).send(b) });
const ym = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; };
const issue = async (a) => (await a.post('/api/invoices', { customerId: cust._id, status: 'sent', items: [{ itemName: 'X', quantity: 1, unitPrice: 10, gstRate: 18 }] })).body.data.invoice;

beforeAll(async () => {
  await connectTestDb('numbering');
  org = await createOrg('dn');
  cust = await make.customer(org.admin);
});
afterAll(disconnectTestDb);

test('the default stays INV-YYYYMM-####', async () => {
  const a = api(org.tokens.admin);
  expect((await a.get('/api/document-numbering')).body.data).toMatchObject({ invoice: { prefix: 'INV-', reset: 'monthly' }, example: { invoice: `INV-${ym()}-0001` } });
  expect((await issue(a)).invoiceNumber).toBe(`INV-${ym()}-0001`);
});

test('a financial-year series continues from there without renumbering', async () => {
  const a = api(org.tokens.admin);
  const before = await Invoice.findOne({ dataScope: org.dataScope });
  const res = await a.put('/api/document-numbering', { invoice: { prefix: 'PA/', reset: 'financial_year', padding: 5 } });
  expect(res.status).toBe(200);
  const fy = financialYearOf(new Date()).code;
  expect((await issue(a)).invoiceNumber).toBe(`PA/${fy}-00001`);
  expect((await issue(a)).invoiceNumber).toBe(`PA/${fy}-00002`);
  expect((await Invoice.findById(before._id)).invoiceNumber).toBe(before.invoiceNumber);
});

test('a prefix that would break the 16-character GST limit, or bad characters, is refused', async () => {
  const a = api(org.tokens.admin);
  expect((await a.put('/api/document-numbering', { invoice: { prefix: 'PRINTSHP', reset: 'monthly', padding: 6 } })).body.code).toBe('TOO_LONG');
  expect((await a.put('/api/document-numbering', { invoice: { prefix: 'IN V' } })).status).toBe(400);
  expect((await a.put('/api/document-numbering', { invoice: { prefix: 'STK-' }, stockItemPrefix: 'STK-' })).status).toBe(400);
});

test('new stock items get the item-code prefix', async () => {
  const a = api(org.tokens.admin);
  await a.put('/api/document-numbering', { stockItemPrefix: 'PAP-' });
  const item = await a.post('/api/inventory', { name: 'Art paper', category: 'Paper & Printing Materials', quantity: 10, unit: 'reams', unitCost: 100 });
  expect(item.status).toBe(201);
  expect((item.body.data.item || item.body.data.inventory || item.body.data).sku).toMatch(/^PAP-/);
});

test('only Settings: Edit may change numbering', async () => {
  expect((await api(org.tokens.staff1).put('/api/document-numbering', { stockItemPrefix: 'X-' })).status).toBe(403);
});
