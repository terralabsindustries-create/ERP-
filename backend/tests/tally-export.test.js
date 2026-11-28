/**
 * Tally export: every voucher balances, the debit/credit signs follow Tally's
 * XML convention, drafts/cancelled never go out, history flags repeats, and
 * nothing crosses businesses.
 */
const request = require('supertest');
const app = require('../src/app');
const svc = require('../src/services/tallyExport');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
const today = () => new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
const api = (token) => ({
  get: (u) => request(app).get(u).set(auth(token)),
  post: (u, b) => request(app).post(u).set(auth(token)).send(b || {}),
  patch: (u, b) => request(app).patch(u).set(auth(token)).send(b || {})
});
let a;
let inv;

beforeAll(async () => {
  await connectTestDb('tally');
  org = await createOrg('tl');
  other = await createOrg('tlo');
  a = api(org.tokens.admin);
  const cust = await make.customer(org.admin, { name: 'Tally & Sons <Pvt>' });
  inv = (await a.post('/api/invoices', { customerId: cust._id, status: 'sent', items: [{ itemName: 'Cards', quantity: 3, unitPrice: 333.33, gstRate: 18 }] })).body.data.invoice;
  await a.post('/api/invoices', { customerId: cust._id, items: [{ itemName: 'Draft', quantity: 1, unitPrice: 100, gstRate: 18 }] }); // draft
  await a.post('/api/payments', { customerId: cust._id, invoiceId: inv._id, amount: 500, paymentMethod: 'cash' });
  const cn = await a.post('/api/credit-notes', { noteType: 'credit', invoiceId: inv._id, reason: 'post_sale_discount', items: [{ invoiceLineRef: String(inv.items[0]._id), taxableValue: 100 }] });
  await a.patch(`/api/credit-notes/${cn.body.data.note._id}/issue`);
});
afterAll(disconnectTestDb);

test('vouchers balance and carry the right types', async () => {
  const from = new Date(Date.now() - 864e5 * 2); const to = new Date(Date.now() + 864e5);
  const { vouchers, problems } = await svc.buildVouchers(org.admin, from, to);
  expect(problems).toEqual([]);
  expect(vouchers.map((v) => v.type).sort()).toEqual(['Credit Note', 'Receipt', 'Sales']);
  for (const v of vouchers) expect(Math.abs(v.entries.reduce((t, e) => t + e.amount, 0))).toBeLessThan(0.005);
  const sale = vouchers.find((v) => v.type === 'Sales');
  expect(sale.number).toBe(inv.invoiceNumber);
  expect(sale.entries.find((e) => e.party).amount).toBe(inv.totalAmount); // party is debited
  expect(sale.entries.find((e) => e.ledger === 'Sales').amount).toBeLessThan(0); // sales credited
});

test('XML: debit = ISDEEMEDPOSITIVE Yes with a negative AMOUNT; names are escaped', async () => {
  const res = await a.get(`/api/tally/export?kind=vouchers&from=2026-01-01&to=${today()}`);
  expect(res.status).toBe(200);
  const xml = res.text;
  expect(xml).toMatch(/^<\?xml/);
  expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
  expect(xml).toContain('Tally &amp; Sons &lt;Pvt&gt;');
  const party = /<LEDGERNAME>Tally &amp; Sons &lt;Pvt&gt;<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>-([\d.]+)<\/AMOUNT>/.exec(xml);
  expect(Number(party[1])).toBe(inv.totalAmount);
  expect(xml).toContain(`REMOTEID="CPF-INV-${inv._id}"`);
  expect(xml).not.toMatch(/DRAFT-/);
});

test('preview flags documents already exported', async () => {
  const p = (await a.get(`/api/tally/preview?from=2026-01-01&to=${today()}`)).body.data;
  expect(p.counts).toMatchObject({ Sales: 1, Receipt: 1, 'Credit Note': 1 });
  expect(p.alreadyExported.map((x) => x.type).sort()).toEqual(['Credit Note', 'Receipt', 'Sales']);
  const h = (await a.get('/api/tally/history')).body.data.exports;
  expect(h[0]).toMatchObject({ kind: 'vouchers', counts: { vouchers: 3, leftOut: 0 } });
});

test('masters list customers under Sundry Debtors and tax ledgers under Duties & Taxes', async () => {
  const xml = (await a.get('/api/tally/export?kind=masters')).text;
  expect(xml).toContain('<REPORTNAME>All Masters</REPORTNAME>');
  expect(xml).toMatch(/LEDGER NAME="Tally &amp; Sons &lt;Pvt&gt;" ACTION="Create">.*<PARENT>Sundry Debtors<\/PARENT>/);
  expect(xml).toMatch(/LEDGER NAME="Output CGST" ACTION="Create">.*?<PARENT>Duties &amp; Taxes<\/PARENT>/);
});

test('custom ledger names are used', async () => {
  const xml = (await a.get(`/api/tally/export?kind=vouchers&from=2026-01-01&to=${today()}&salesLedger=Printing%20Sales`)).text;
  expect(xml).toContain('<LEDGERNAME>Printing Sales</LEDGERNAME>');
});

test('nothing from another business; needs Accounts', async () => {
  const p = (await api(other.tokens.admin).get(`/api/tally/preview?from=2026-01-01&to=${today()}`)).body.data;
  expect(p.counts).toEqual({});
  expect((await api(org.tokens.staff1).get(`/api/tally/preview?from=2026-01-01&to=${today()}`)).status).toBe(403);
});
