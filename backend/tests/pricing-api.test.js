const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const ActivityLog = require('../src/models/ActivityLog');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org; let other; let cust; let item;
const SLABS = [[1, 25], [11, 23], [50, 22], [100, 20], [500, 18], [1000, 15], [2500, 13]].map(([minQty, rate]) => ({ minQty, rate }));
const as = (o, who = 'admin') => ({
  get: (u) => request(app).get(u).set(auth(o.tokens[who])),
  post: (u, b) => request(app).post(u).set(auth(o.tokens[who])).send(b),
  put: (u, b) => request(app).put(u).set(auth(o.tokens[who])).send(b),
  del: (u) => request(app).delete(u).set(auth(o.tokens[who]))
});
const admin = () => as(org);
const quote = (body) => admin().post('/api/price-items/quote', { priceItemId: String(item._id), ...body });
const invoice = (items, extra = {}) => admin().post('/api/invoices', { customerId: String(cust._id), items, ...extra });
const line = (quantity, extra = {}) => ({ itemName: 'Digital print', quantity, unitPrice: 1, priceItemId: String(item._id), ...extra });

beforeAll(async () => {
  await connectTestDb('pricing_api');
  org = await createOrg('pricing_api', { staffPermissions: ['Dashboard', 'Invoicing', 'Invoicing: Create & Edit'] });
  other = await createOrg('pricing_other');
  cust = await make.customer(org.admin);
  const res = await admin().post('/api/price-items', {
    type: 'digital', name: '13x19 300gsm Art Paper Simplex', mediaName: '300gsm 13x19-CPB', paperType: 'Art Paper', gsm: 300, printSize: '13x19', sides: 'simplex',
    hsnCode: '48101990', gstRate: 18, taxInclusive: true, slabs: SLABS, unit: 'pieces'
  });
  expect(res.status).toBe(201);
  item = res.body.data.item;
});
afterAll(disconnectTestDb);

describe('item master and slabs', () => {
  test('a created item shows its ranges, sorted, with the spec fields', () => {
    expect(item).toMatchObject({ type: 'digital', hsnCode: '48101990', gstRate: 18, taxInclusive: true, sides: 'simplex', isActive: true });
    expect(item.ranges[0]).toEqual({ minQty: 1, maxQty: 11, rate: 25 });
    expect(item.ranges[6]).toEqual({ minQty: 2500, maxQty: null, rate: 13 });
  });
  test('unsorted slabs are stored sorted; add, edit and remove a slab', async () => {
    const created = await admin().post('/api/price-items', { type: 'flex', name: 'Flex 10oz', slabs: [{ minQty: 100, rate: 8 }, { minQty: 1, rate: 12 }] });
    const id = created.body.data.item._id;
    expect(created.body.data.item.slabs.map((s) => s.minQty)).toEqual([1, 100]);
    const edited = await admin().put(`/api/price-items/${id}`, { slabs: [{ minQty: 1, rate: 12 }, { minQty: 50, rate: 9 }, { minQty: 100, rate: 7.5 }] });
    expect(edited.body.data.item.slabs.map((s) => s.rate)).toEqual([12, 9, 7.5]);
    const removed = await admin().put(`/api/price-items/${id}`, { slabs: [{ minQty: 1, rate: 12 }] });
    expect(removed.body.data.item.slabs).toHaveLength(1);
  });
  test('duplicate thresholds, zero/negative quantities, negative rates and bad HSN are refused', async () => {
    for (const body of [
      { slabs: [{ minQty: 5, rate: 1 }, { minQty: 5, rate: 2 }] }, { slabs: [{ minQty: 0, rate: 1 }] }, { slabs: [{ minQty: -1, rate: 1 }] },
      { slabs: [{ minQty: 1, rate: -2 }] }, { hsnCode: '12' }, { defaultRate: -1 }, { gstRate: 'abc' }
    ]) {
      const res = await admin().post('/api/price-items', { type: 'general', name: `Bad ${Math.random()}`, ...body });
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
  });
  test('the same item cannot be created twice; search and filters work; deactivation hides it from active lists', async () => {
    expect((await admin().post('/api/price-items', { type: 'digital', name: '13x19 300gsm Art Paper Simplex', mediaName: '300gsm 13x19-CPB', printSize: '13x19', sides: 'simplex' })).status).toBe(409);
    expect((await admin().get('/api/price-items?type=digital&search=art%20paper')).body.data.items).toHaveLength(1);
    expect((await admin().get('/api/price-items?media=cpb')).body.data.items).toHaveLength(1);
    const tmp = await admin().post('/api/price-items', { type: 'general', name: 'Temp item', defaultRate: 5 });
    await admin().del(`/api/price-items/${tmp.body.data.item._id}`);
    expect((await admin().get('/api/price-items?status=active&search=Temp')).body.data.items).toHaveLength(0);
    expect((await admin().get('/api/price-items?status=inactive&search=Temp')).body.data.items).toHaveLength(1);
  });
});

describe('quote endpoint', () => {
  test.each([[1, 25], [10, 25], [11, 23], [49, 23], [50, 22], [99, 22], [100, 20], [499, 20], [500, 18], [999, 18], [1000, 15], [2499, 15], [2500, 13]])('quantity %i → ₹%i (GST-inclusive item)', async (q, rate) => {
    const res = await quote({ quantity: q });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rate, source: 'item_slab', sourceLabel: 'Quantity-based rate', total: Math.round(q * rate * 100) / 100 });
    expect(Math.abs(res.body.data.taxable + res.body.data.gst - res.body.data.total)).toBeLessThan(0.0051);
  });
  test('an invalid quantity is refused', async () => {
    for (const quantity of [0, -3, 'x']) expect((await quote({ quantity })).status).toBe(400);
  });
  test('a manual override needs the permission and a recorded reason; staff without it are refused', async () => {
    expect((await quote({ quantity: 5, priceOverride: { rate: 10, reason: 'goodwill' } })).body.data).toMatchObject({ source: 'manual_override', rate: 10 });
    const res = await as(org, 'staff1').post('/api/price-items/quote', { priceItemId: String(item._id), quantity: 5, priceOverride: { rate: 10, reason: 'x' } });
    expect(res.status).toBe(403);
  });
});

describe('customer-specific rates', () => {
  let rateCust;
  beforeAll(async () => { rateCust = await make.customer(org.admin, { name: 'VIP Press' }); });
  const put = (body) => admin().put(`/api/price-items/${item._id}/customer-rates/${rateCust._id}`, body);

  test('slabs and fixed rate are validated', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ slabs: [{ minQty: 1, rate: 1 }, { minQty: 1, rate: 2 }] })).status).toBe(400);
    expect((await put({ fixedRate: -3 })).status).toBe(400);
  });
  test('customer slab > customer fixed > item slab, shown with its source', async () => {
    expect((await put({ fixedRate: 21, slabs: [{ minQty: 100, rate: 16 }], reason: 'Annual contract' })).status).toBe(200);
    const q = (quantity) => quote({ customerId: String(rateCust._id), quantity }).then((r) => r.body.data);
    expect(await q(200)).toMatchObject({ rate: 16, source: 'customer_slab', sourceLabel: 'Customer-specific quantity rate' });
    expect(await q(20)).toMatchObject({ rate: 21, source: 'customer_fixed' });
    expect(await quote({ quantity: 200 }).then((r) => r.body.data)).toMatchObject({ rate: 20, source: 'item_slab' }); // another customer is unaffected
    expect(await quote({ customerId: String(rateCust._id), quantity: 200, priceOverride: { rate: 5, reason: 'sample' } }).then((r) => r.body.data.source)).toBe('manual_override');
  });
  test('changes are kept in history and the audit log', async () => {
    await put({ fixedRate: 19, slabs: [{ minQty: 100, rate: 15 }], reason: 'Renegotiated' });
    const rates = (await admin().get(`/api/price-items/${item._id}/customer-rates`)).body.data.rates;
    expect(rates[0].history.map((h) => h.action)).toEqual(['created', 'updated']);
    expect(rates[0].history[1]).toMatchObject({ reason: 'Renegotiated', before: { fixedRate: 21 }, after: { fixedRate: 19 } });
    expect(await ActivityLog.countDocuments({ action: 'Customer Rate Saved', dataScope: org.dataScope, protected: true })).toBe(2);
  });
  test('needs Pricing Master: Customer Rates; another business cannot read or set them', async () => {
    await User.updateOne({ _id: org.staff1._id }, { $set: { permissions: ['Dashboard', 'Pricing Master', 'Pricing Master: View', 'Pricing Master: Create & Edit'] } });
    expect((await as(org, 'staff1').put(`/api/price-items/${item._id}/customer-rates/${rateCust._id}`, { fixedRate: 1 })).status).toBe(403);
    expect((await as(other).get(`/api/price-items/${item._id}`)).status).toBe(404);
    expect((await as(other).put(`/api/price-items/${item._id}/customer-rates/${rateCust._id}`, { fixedRate: 1 })).status).toBe(404);
    expect((await as(other).post('/api/price-items/quote', { priceItemId: String(item._id), quantity: 5 })).status).toBe(404);
    expect((await as(other).get('/api/price-items')).body.data.items).toHaveLength(0);
  });
});

describe('invoices and quotations use the same engine and keep what they stored', () => {
  test('the server prices a master item line: quantity changes change the rate, GST once, totals match the quote', async () => {
    for (const q of [10, 11, 100, 2500]) {
      const res = await invoice([line(q)]);
      expect(res.status).toBe(201);
      const inv = res.body.data.invoice;
      const quoted = (await quote({ quantity: q })).body.data;
      expect(inv.items[0].pricingSnapshot).toMatchObject({ source: 'item_slab', rate: quoted.rate, quantity: q });
      expect(Math.abs(inv.totalAmount - quoted.total)).toBeLessThan(0.0101);
      expect(inv.items[0].hsnCode).toBe('48101990');
      expect(inv.items[0].gstRate).toBe(18);
    }
  });
  test('a stale client price is ignored: the server decides', async () => {
    const res = await invoice([line(100, { unitPrice: 999 })]);
    expect(res.body.data.invoice.items[0].unitPrice).toBeLessThan(20);
  });
  test('an override is refused without permission or reason, and recorded when allowed', async () => {
    const denied = await as(org, 'staff1').post('/api/invoices', { customerId: String(cust._id), items: [line(5, { priceOverride: { rate: 1, reason: 'x' } })] });
    expect(denied.status).toBe(403);
    expect((await invoice([line(5, { priceOverride: { rate: 1 } })])).status).toBe(400);
    const ok = await invoice([line(5, { priceOverride: { rate: 50, reason: 'Rush job' } })]);
    expect(ok.status).toBe(201);
    expect(ok.body.data.invoice.items[0].pricingSnapshot).toMatchObject({ source: 'manual_override', rate: 50, reason: 'Rush job' });
  });
  test('changing the master does not change an issued invoice, and editing the invoice keeps its stored price', async () => {
    const created = await invoice([line(100)]);
    const id = created.body.data.invoice._id;
    const before = created.body.data.invoice;
    await admin().put(`/api/price-items/${item._id}`, { slabs: SLABS.map((s) => ({ ...s, rate: s.rate * 2 })) });
    expect((await Invoice.findById(id)).totalAmount).toBe(before.totalAmount);
    const edit = await admin().put(`/api/invoices/${id}`, { items: [line(100)], notes: 'edited' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.invoice.totalAmount).toBe(before.totalAmount);
    // a quantity change re-prices from the current master
    const requantified = await admin().put(`/api/invoices/${id}`, { items: [line(101)] });
    expect(requantified.body.data.invoice.items[0].pricingSnapshot.rate).toBe(40);
    await admin().put(`/api/price-items/${item._id}`, { slabs: SLABS });
  });
  test('quotation → invoice keeps the quoted price even after the master changes', async () => {
    const q = await admin().post('/api/quotations', { customer_id: String(cust._id), valid_until: new Date(Date.now() + 864e5).toISOString(), items: [{ item_name: 'Cards', quantity: 500, unit_price: 1, priceItemId: String(item._id), tax_rate: 18 }] });
    expect(q.status).toBe(201);
    const quotation = q.body.data.quotation || q.body.data;
    expect(quotation.items[0].pricing_snapshot).toMatchObject({ rate: 18, source: 'item_slab' });
    await admin().put(`/api/price-items/${item._id}`, { slabs: SLABS.map((s) => ({ ...s, rate: s.rate * 3 })) });
    const conv = await admin().post(`/api/quotations/${quotation._id}/convert-to-invoice`, {});
    expect(conv.status).toBeLessThan(300);
    const inv = conv.body.data.invoice;
    expect(inv.items[0].pricingSnapshot.rate).toBe(18);
    expect(Math.abs(inv.totalAmount - quotation.total_amount)).toBeLessThan(0.0101);
    await admin().put(`/api/price-items/${item._id}`, { slabs: SLABS });
  });
  test('a line without a master item behaves exactly as before; foreign or inactive items are refused', async () => {
    const plain = await invoice([{ itemName: 'Custom work', quantity: 2, unitPrice: 100, gstRate: 18 }]);
    expect(plain.status).toBe(201);
    expect(plain.body.data.invoice.totalAmount).toBe(236);
    expect(plain.body.data.invoice.items[0].pricingSnapshot).toBeUndefined();
    const foreign = await as(other).post('/api/invoices', { customerId: String((await make.customer(other.admin))._id), items: [line(5)] });
    expect(foreign.status).toBe(404);
    const tmp = await admin().post('/api/price-items', { type: 'general', name: 'Soon inactive', defaultRate: 4 });
    await admin().del(`/api/price-items/${tmp.body.data.item._id}`);
    expect((await invoice([line(1, { priceItemId: tmp.body.data.item._id })])).status).toBe(409);
  });
});
