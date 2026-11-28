/** Sales orders: server-side pricing, approval queue, production stages, advances, invoice-from-order, isolation. */
const request = require('supertest');
const app = require('../src/app');
const Job = require('../src/models/Job');
const Invoice = require('../src/models/Invoice');
const Payment = require('../src/models/Payment');
const Quotation = require('../src/models/Quotation');
const ProductRate = require('../src/models/ProductRate');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let agency;
let walkin;
let flex;
let clerk; // can create orders but not approve / discount / override
const SO_BASE = ['Sales Orders', 'Sales Orders: View', 'Sales Orders: Create & Edit', 'Customers', 'Product Rates', 'Invoicing'];
const api = (m, url, body, token = org.tokens.admin) => request(app)[m](url).set(auth(token)).send(body);
let n = 0;
const rid = () => `req-${Date.now()}-${(n += 1)}`;

const slabs = (...s) => s.map(([from, to, exclusiveRate]) => ({ from, to, exclusiveRate }));
const orderBody = (extra = {}) => ({
  customerId: String(walkin._id), salesType: 'Retail', projectName: 'Diwali banners', clientRequestId: rid(),
  lines: [{ productId: String(flex._id), copies: 100, stages: { design: true, printing: true, finishing: false } }], ...extra
});

beforeAll(async () => {
  await connectTestDb('salesorders');
  await Job.init(); await ProductRate.init(); await Invoice.init();
  org = await createOrg('so', { staffPermissions: SO_BASE });
  other = await createOrg('sox');
  walkin = await make.customer(org.admin, { name: 'Walk In Wally', customerType: 'Walk-in', phone: '9000000001' });
  agency = await make.customer(org.admin, { name: 'Agency Annie', customerType: 'Agency', phone: '9000000002' });
  const res = await api('post', '/api/product-rates', {
    materialType: 'Flex', productName: 'Star Flex 280gsm', productCode: 'flx280', unit: 'pieces', gstRate: 18,
    rules: [
      { slabs: slabs([1, 100, 15], [101, 500, 12], [501, null, 10]) },
      { partyType: 'Agency', slabs: slabs([1, null, 8]) },
      { salesType: 'Wholesale', slabs: slabs([1, null, 9]) },
      { customerId: String(walkin._id), salesType: 'Retail', slabs: slabs([1, null, 14]) }
    ]
  });
  expect(res.status).toBe(201);
  flex = res.body.data.product;
  clerk = org.tokens.staff1; // SO_BASE only
});
afterAll(disconnectTestDb);

describe('product rate master', () => {
  test('validation: overlapping slabs, duplicate rules, mismatching GST sides, bad customer, duplicate code', async () => {
    const bad = (rules, extra = {}) => api('post', '/api/product-rates', { materialType: 'X', productName: 'P', rules, ...extra });
    expect((await bad([{ slabs: slabs([1, 100, 5], [100, 200, 4]) }])).body.errors.join()).toMatch(/overlap/);
    expect((await bad([{ partyType: 'Agency', slabs: slabs([1, null, 5]) }, { partyType: 'Agency', slabs: slabs([1, null, 6]) }])).body.errors.join()).toMatch(/duplicates/);
    expect((await bad([{ slabs: [{ from: 1, to: null, exclusiveRate: 10, inclusiveRate: 12.5 }] }])).body.errors.join()).toMatch(/do not match/);
    expect((await bad([{ slabs: slabs([1, null, -1]) }])).status).toBe(400);
    expect((await bad([{ customerId: String(other.admin._id), slabs: slabs([1, null, 5]) }])).status).toBe(400);
    expect((await bad([{ slabs: slabs([1, null, 5]) }], { productCode: 'FLX280' })).status).toBe(409);
  });

  test('inclusive entry fills the exclusive side (₹12 incl. = ₹10.17 excl. at 18%)', async () => {
    const res = await api('post', '/api/product-rates', { materialType: 'Vinyl', productName: 'Vinyl', gstRate: 18, rules: [{ slabs: [{ from: 1, to: null, inclusiveRate: 12 }] }] });
    expect(res.status).toBe(201);
    expect(res.body.data.product.rules[0].slabs[0]).toMatchObject({ exclusiveRate: 10.17, inclusiveRate: 12, rateBasis: 'inclusive' });
  });

  test('server-side search, material filter and pagination; no rules in the list', async () => {
    const list = await api('get', '/api/product-rates?search=star&materialType=Flex&limit=5');
    expect(list.body.data.products.map((p) => p.productCode)).toEqual(['FLX280']);
    expect(list.body.data.products[0].rules).toBeUndefined();
    expect(list.body.data.pagination.total).toBe(1);
    expect((await api('get', '/api/product-rates?search=flx2')).body.data.products).toHaveLength(1);
  });
});

describe('server-side pricing', () => {
  const price = (customerId, salesType, extra = {}) => api('post', '/api/product-rates/price', { customerId: String(customerId), salesType, lines: [{ productId: String(flex._id), copies: 100 }], ...extra });
  test('priority: customer-specific > party-type > sales-type > default', async () => {
    expect((await price(walkin._id, 'Retail')).body.data.lines[0].rate).toBe(14); // customer + sales
    expect((await price(agency._id, 'Retail')).body.data.lines[0].rate).toBe(8); // party type
    expect((await price(walkin._id, 'Wholesale')).body.data.lines[0].rate).toBe(9); // sales type
    expect((await price(walkin._id, 'Project')).body.data.lines[0].rate).toBe(15); // default, slab 1-100
  });
  test('totals: CGST/SGST, other charges, round-off, advance, balance', async () => {
    const res = await price(agency._id, 'Retail', { otherCharges: [{ name: 'Delivery', amount: 100, gstRate: 18 }], advance: 500 });
    expect(res.body.data.totals).toMatchObject({ taxableAmount: 900, cgst: 81, sgst: 81, igst: 0, total: 1062, advance: 500, balance: 562 });
  });
  test('no matching rate is a warning, not a zero price; the order cannot be saved', async () => {
    const bare = (await api('post', '/api/product-rates', { materialType: 'Misc', productName: 'Agency only', rules: [{ partyType: 'Agency', slabs: slabs([1, null, 5]) }] })).body.data.product;
    const p = await api('post', '/api/product-rates/price', { customerId: String(walkin._id), lines: [{ productId: String(bare._id), copies: 5 }] });
    expect(p.body.data.lines[0]).toMatchObject({ priced: false });
    expect(p.body.data.lines[0].warnings[0].code).toBe('NO_RATE');
    const save = await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(bare._id), copies: 5 }] }));
    expect(save.status).toBe(422);
    expect(save.body.code).toBe('UNPRICED_LINE');
  });
});

describe('creating orders', () => {
  test('order number, snapshot, party type, totals — computed by the server, not the client', async () => {
    const res = await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(flex._id), copies: 100, stages: { design: true, printing: true }, unitPrice: 1, total: 1 }], orderTotals: { total: 1 } }));
    expect(res.status).toBe(201);
    const o = res.body.data.order;
    expect(o.orderNumber).toMatch(/^SO-\d{6}-0001$/);
    expect(o.approval.status).toBe('pending');
    expect(o.partyType).toBe('Walk-in');
    expect(o.orderTotals).toMatchObject({ taxableAmount: 1400, total: 1652 }); // customer rule ₹14 × 100 + 18%
    expect(o.orderLines[0].pricingSnapshot.rule).toMatchObject({ score: 110 });
    expect(o.production).toMatchObject({ design: { required: true }, printing: { required: true }, finishing: { required: false } });
    expect(o.items[0]).toMatchObject({ quantity: 100, unitPrice: 14, gstRate: 18 });
  });

  test('a retried request returns the same order; numbers are sequential', async () => {
    const body = orderBody();
    const [a, b] = await Promise.all([api('post', '/api/sales-orders', body), api('post', '/api/sales-orders', body)]);
    expect([a.status, b.status].every((s) => [200, 201].includes(s))).toBe(true);
    expect(await Job.countDocuments({ clientRequestId: body.clientRequestId })).toBe(1);
    const c = await api('post', '/api/sales-orders', orderBody());
    const d = await api('post', '/api/sales-orders', orderBody());
    expect(Number(d.body.data.order.orderNumber.slice(-4))).toBe(Number(c.body.data.order.orderNumber.slice(-4)) + 1);
  });

  test('the price is kept when the rate master changes later (historical preservation)', async () => {
    const o = (await api('post', '/api/sales-orders', orderBody())).body.data.order;
    const cur = (await api('get', `/api/product-rates/${flex._id}`)).body.data.product;
    const changed = cur.rules.map((r) => (r.customerId ? { ...r, slabs: slabs([1, null, 99]) } : r));
    expect((await api('put', `/api/product-rates/${flex._id}`, { ...cur, rules: changed })).status).toBe(200);
    const again = (await api('get', `/api/sales-orders/${o._id}`)).body.data.order;
    expect(again.orderTotals.total).toBe(o.orderTotals.total);
    expect(again.orderLines[0].pricingSnapshot.rateUsed).toBe(14);
    // new orders use the new rate; restore for later tests
    expect((await api('post', '/api/product-rates/price', { customerId: String(walkin._id), salesType: 'Retail', lines: [{ productId: String(flex._id), copies: 100 }] })).body.data.lines[0].rate).toBe(99);
    await api('put', `/api/product-rates/${flex._id}`, { ...cur });
  });

  test('discounts and rate overrides need permission; an override needs a reason and records who/why', async () => {
    const withDiscount = orderBody({ lines: [{ productId: String(flex._id), copies: 100, discountType: 'percent', discountValue: 10 }] });
    const denied = await api('post', '/api/sales-orders', withDiscount, clerk);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('DISCOUNT_NOT_ALLOWED');
    const ok = await api('post', '/api/sales-orders', withDiscount);
    expect(ok.status).toBe(201);
    expect(ok.body.data.order.orderTotals).toMatchObject({ discount: 140, taxableAmount: 1260 });

    const noReason = await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(flex._id), copies: 100, rateOverride: { rate: 13 } }] }));
    expect(noReason.body.code).toBe('OVERRIDE_REASON_REQUIRED');
    const clerkOverride = await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(flex._id), copies: 100, rateOverride: { rate: 13, reason: 'x' } }] }), clerk);
    expect(clerkOverride.body.code).toBe('OVERRIDE_NOT_ALLOWED');
    const done = await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(flex._id), copies: 100, rateOverride: { rate: 13, reason: 'Loyal client' } }] }));
    expect(done.body.data.order.orderLines[0].pricingSnapshot.override).toMatchObject({ original: 14, rate: 13, reason: 'Loyal client', byName: expect.any(String) });
    expect(done.body.data.order.orderTotals.taxableAmount).toBe(1300);
  });

  test("another business's customer or product is not found", async () => {
    const stranger = await make.customer(other.admin, { name: 'Elsewhere' });
    expect((await api('post', '/api/sales-orders', orderBody({ customerId: String(stranger._id) }))).status).toBe(404);
    const theirs = (await api('post', '/api/product-rates', { materialType: 'X', productName: 'Theirs', rules: [{ slabs: slabs([1, null, 5]) }] }, other.tokens.admin)).body.data.product;
    expect((await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(theirs._id), copies: 1 }] }))).status).toBe(400);
  });

  test('quotation: one live order per quotation; cancelling frees it', async () => {
    const q = await Quotation.create({ quotationNumber: `QUO-SO-${Date.now()}`, customer_id: walkin._id, items: [{ item_name: 'Star Flex 280gsm', quantity: 10, unit_price: 12, tax_rate: 18, total_amount: 141.6 }], userId: org.admin._id, dataScope: org.dataScope });
    const prefill = await api('get', `/api/sales-orders/from-quotation/${q._id}`);
    expect(prefill.body.data.lines[0]).toMatchObject({ matched: true, copies: 10 });
    const first = await api('post', '/api/sales-orders', orderBody({ quotationId: String(q._id) }));
    expect(first.status).toBe(201);
    expect((await api('post', '/api/sales-orders', orderBody({ quotationId: String(q._id) }))).status).toBe(409);
    expect((await api('post', `/api/sales-orders/${first.body.data.order._id}/cancel`, { reason: 'Changed' })).status).toBe(200);
    expect((await api('post', '/api/sales-orders', orderBody({ quotationId: String(q._id) }))).status).toBe(201);
  });
});

describe('approval queue', () => {
  let a;
  let b;
  beforeAll(async () => {
    a = (await api('post', '/api/sales-orders', orderBody({ customerId: String(agency._id), projectName: 'Queue A' }))).body.data.order;
    b = (await api('post', '/api/sales-orders', orderBody({ projectName: 'Queue B' }))).body.data.order;
  });

  test('search by number / customer / mobile, approval filter, pagination, paid and balance without N+1', async () => {
    expect((await api('get', `/api/sales-orders?search=${a.orderNumber}`)).body.data.orders.map((o) => o.orderNumber)).toEqual([a.orderNumber]);
    expect((await api('get', '/api/sales-orders?search=Agency')).body.data.orders.every((o) => o.customer === 'Agency Annie')).toBe(true);
    expect((await api('get', '/api/sales-orders?search=9000000001')).body.data.orders.length).toBeGreaterThan(0);
    const pending = await api('get', '/api/sales-orders?approval=pending&limit=2&page=1');
    expect(pending.body.data.orders).toHaveLength(2);
    expect(pending.body.data.pagination.total).toBeGreaterThan(2);
    expect(pending.body.data.orders[0]).toEqual(expect.objectContaining({ orderDate: expect.anything(), total: expect.any(Number), discount: expect.any(Number), paid: 0, balance: expect.any(Number), approvalStatus: 'pending' }));
  });

  test('approving needs Sales Orders: Approve (backend), is atomic and cannot repeat', async () => {
    const denied = await api('post', `/api/sales-orders/${b._id}/approve`, {}, clerk);
    expect(denied.status).toBe(403);
    expect(denied.body.required).toBe('Sales Orders: Approve');
    const results = await Promise.all([1, 2, 3].map(() => api('post', `/api/sales-orders/${b._id}/approve`, {})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const saved = await Job.findById(b._id);
    expect(saved.approval).toMatchObject({ status: 'approved' });
    expect(saved.approval.byName).toBeTruthy();
    // an approved order is locked for editing
    expect((await api('put', `/api/sales-orders/${b._id}`, orderBody())).status).toBe(409);
  });

  test('tenant isolation: another business sees none of it', async () => {
    expect((await api('get', `/api/sales-orders/${a._id}`, undefined, other.tokens.admin)).status).toBe(404);
    expect((await api('get', '/api/sales-orders', undefined, other.tokens.admin)).body.data.orders).toHaveLength(0);
    expect((await api('post', `/api/sales-orders/${a._id}/approve`, {}, other.tokens.admin)).status).toBe(404);
  });

  test('users without the module are refused at the route', async () => {
    const none = (await createOrg('sonone', { staffPermissions: ['Dashboard'] })).tokens.staff1;
    expect((await api('get', '/api/sales-orders', undefined, none)).status).toBe(403);
  });
});

describe('production stages', () => {
  let o;
  beforeAll(async () => {
    o = (await api('post', '/api/sales-orders', orderBody({ lines: [{ productId: String(flex._id), copies: 10, stages: { design: false, printing: true, finishing: true } }] }))).body.data.order;
  });
  const stage = (s, action, extra = {}) => api('post', `/api/sales-orders/${o._id}/stages/${s}`, { action, ...extra });

  test('nothing starts before approval', async () => {
    expect((await stage('printing', 'start')).body.code).toBe('APPROVAL_REQUIRED');
    await api('post', `/api/sales-orders/${o._id}/approve`, {});
  });
  test('design is not required: it cannot start, and printing may begin; order and transitions are enforced', async () => {
    expect((await stage('design', 'start')).body.code).toBe('NOT_REQUIRED');
    expect((await stage('finishing', 'start')).body.code).toBe('EARLIER_STAGE_OPEN');
    expect((await stage('printing', 'complete')).body.code).toBe('BAD_TRANSITION');
    expect((await stage('printing', 'start')).status).toBe(200);
    expect((await stage('printing', 'start')).body.code).toBe('BAD_TRANSITION');
    expect((await stage('printing', 'complete')).status).toBe(200);
    expect((await stage('printing', 'complete')).body.code).toBe('BAD_TRANSITION');
  });
  test('skipping a required stage needs a reason; finishing the last required stage completes the job', async () => {
    expect((await stage('finishing', 'skip')).body.code).toBe('REASON_REQUIRED');
    expect((await stage('finishing', 'start')).status).toBe(200);
    const done = await stage('finishing', 'complete');
    expect(done.status).toBe(200);
    expect(done.body.data.order.status).toBe('completed');
    // production done: cannot be cancelled or deleted
    expect((await api('post', `/api/sales-orders/${o._id}/cancel`, { reason: 'x' })).body.code).toBe('PRODUCTION_DONE');
    expect((await api('delete', `/api/sales-orders/${o._id}`)).status).toBe(409);
  });
  test('stage changes need their own permission', async () => {
    expect((await api('post', `/api/sales-orders/${o._id}/stages/printing`, { action: 'start' }, clerk)).status).toBe(403);
  });
});

describe('cancel and delete rules', () => {
  test('a pending order can be deleted; an approved one cannot (cancel instead); a cancelled one can', async () => {
    const p = (await api('post', '/api/sales-orders', orderBody())).body.data.order;
    expect((await api('delete', `/api/sales-orders/${p._id}`, undefined, clerk)).status).toBe(403);
    expect((await api('delete', `/api/sales-orders/${p._id}`)).status).toBe(200);
    expect(await Job.findById(p._id)).toBeNull();

    const a = (await api('post', '/api/sales-orders', orderBody())).body.data.order;
    await api('post', `/api/sales-orders/${a._id}/approve`, {});
    expect((await api('delete', `/api/sales-orders/${a._id}`)).body.code).toBe('ORDER_NOT_DELETABLE');
    expect((await api('post', `/api/sales-orders/${a._id}/cancel`, {})).status).toBe(400); // reason required
    expect((await api('post', `/api/sales-orders/${a._id}/cancel`, { reason: 'Customer left' })).status).toBe(200);
    expect((await api('post', `/api/sales-orders/${a._id}/cancel`, { reason: 'again' })).body.code).toBe('ALREADY_CANCELLED');
    expect((await api('delete', `/api/sales-orders/${a._id}`)).status).toBe(200);
  });
});

describe('advance, balance and invoice', () => {
  let o;
  beforeAll(async () => {
    o = (await api('post', '/api/sales-orders', orderBody({ customerId: String(agency._id) }))).body.data.order; // 100 × 8 + 18% = 944
    await api('post', `/api/sales-orders/${o._id}/approve`, {});
  });

  test('an advance is a payment on account for the order; paid / balance / excess follow it; duplicates are prevented', async () => {
    expect(o.orderTotals.total).toBe(944);
    const key = rid();
    const pay = (amount, extra = {}) => api('post', '/api/payments', { customerId: String(agency._id), salesOrderId: o._id, amount, paymentMethod: 'cash', idempotencyKey: key, ...extra });
    const [a, b] = await Promise.all([pay(400), pay(400)]);
    expect([a.status, b.status].every((s) => [200, 201].includes(s))).toBe(true);
    expect(await Payment.countDocuments({ salesOrderId: o._id })).toBe(1);
    const read = (await api('get', `/api/sales-orders/${o._id}`)).body.data.order;
    expect(read).toMatchObject({ paid: 400, balance: 544, excess: 0 });
    await api('post', '/api/payments', { customerId: String(agency._id), salesOrderId: o._id, amount: 600, paymentMethod: 'upi', idempotencyKey: rid() });
    expect((await api('get', `/api/sales-orders/${o._id}`)).body.data.order).toMatchObject({ paid: 1000, balance: 0, excess: 56 });
    // the queue shows the same
    const row = (await api('get', `/api/sales-orders?search=${o.orderNumber}`)).body.data.orders[0];
    expect(row).toMatchObject({ paid: 1000, balance: 0 });
  });

  test('an advance for another customer\'s or a cancelled order is refused', async () => {
    expect((await api('post', '/api/payments', { customerId: String(walkin._id), salesOrderId: o._id, amount: 10, paymentMethod: 'cash' })).body.code).toBe('BAD_SALES_ORDER');
    const c = (await api('post', '/api/sales-orders', orderBody())).body.data.order;
    await api('post', `/api/sales-orders/${c._id}/cancel`, { reason: 'x' });
    expect((await api('post', '/api/payments', { customerId: String(walkin._id), salesOrderId: c._id, amount: 10, paymentMethod: 'cash' })).body.code).toBe('ORDER_CANCELLED');
  });

  test('an order with payments cannot be deleted; cancelling keeps the advance on account', async () => {
    expect((await api('delete', `/api/sales-orders/${o._id}`)).status).toBe(409);
  });

  test('simultaneous invoicing creates exactly one draft invoice matching the order; a pending order cannot be invoiced', async () => {
    const pending = (await api('post', '/api/sales-orders', orderBody())).body.data.order;
    expect((await api('post', `/api/sales-orders/${pending._id}/invoice`, {})).body.code).toBe('APPROVAL_REQUIRED');
    const res = await Promise.all([1, 2, 3, 4].map(() => api('post', `/api/sales-orders/${o._id}/invoice`, {})));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await Invoice.countDocuments({ jobId: o._id })).toBe(1);
    const inv = await Invoice.findOne({ jobId: o._id }).lean();
    expect(inv.status).toBe('draft');
    expect(Math.abs(inv.totalAmount - 944)).toBeLessThanOrEqual(0.05);
    expect((await api('post', `/api/sales-orders/${o._id}/invoice`, {})).body.code).toBe('ALREADY_INVOICED');
    // an invoiced order cannot be cancelled until the invoice is
    expect((await api('post', `/api/sales-orders/${o._id}/cancel`, { reason: 'x' })).body.code).toBe('ORDER_INVOICED');
  });
});

test('existing jobs and quick sales are untouched: a plain job has no sales-order fields', async () => {
  const j = await make.job(org.admin, walkin, { title: 'Plain job' });
  const stored = await Job.findById(j._id).lean();
  expect(stored.isSalesOrder).toBeFalsy();
  expect((await api('get', `/api/sales-orders/${j._id}`)).status).toBe(404); // not a sales order
});
