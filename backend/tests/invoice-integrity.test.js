/**
 * Invoice creation under failure, concurrency and cross-business requests:
 *
 *  - an invoice and its stock deduction are written together, or not at all,
 *    with or without MongoDB transactions;
 *  - concurrent invoices never oversell stock or overwrite each other's
 *    quantities, and each gets its own invoice number;
 *  - a job ticket linked to an invoice must be the business's own, for the
 *    invoice's customer;
 *  - failed sign-ins are rate limited without holding up anyone else.
 *
 * Runs against whatever MongoDB MONGODB_TEST_URI points at: a standalone
 * server exercises the step-by-step path, a replica set the transactional one
 * (MONGODB_TRANSACTIONS=off forces the step-by-step path on a replica set).
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Inventory = require('../src/models/Inventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const InventoryService = require('../src/services/InventoryService');
const transactions = require('../src/utils/transactions');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a; // business A
let b; // business B
let custA;
let custA2;
let custB;

const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body)
});
const adminA = () => as(a.tokens.admin);

const thisMonth = () => {
  const d = new Date();
  return `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-`;
};

/** A line for the stock item `name` (its unit) — or a one-off line when no stock item has the name. */
const line = (itemName, quantity, extra = {}) => ({ itemName, quantity, unitPrice: 10, gstRate: 18, ...extra });

const stock = (user, name, quantity, extra = {}) =>
  make.stockItem(user, { name, quantity, unit: 'sheets', minStockLevel: 2, ...extra });

const quantityOf = async (item) => (await Inventory.findById(item._id)).quantity;
const salesOf = (item) => InventoryMovement.find({ inventoryItem: item._id, movementType: 'sale' }).sort({ createdAt: 1 });

beforeAll(async () => {
  await connectTestDb('invoice_integrity');
  // Mongoose builds indexes in the background; the numbering tests rely on
  // the unique invoice-number index being in place, as it is in a running app.
  await Invoice.init();
  a = await createOrg('inta', { staffPermissions: ['Dashboard', 'Invoicing'] });
  b = await createOrg('intb');
  custA = await make.customer(a.admin, { name: 'Lotus Events' });
  custA2 = await make.customer(a.admin, { name: 'Malabar Weddings' });
  custB = await make.customer(b.admin, { name: 'Other Business Customer' });
});
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

describe('an invoice and its stock are written together', () => {
  test('a sale takes the stock once, records it, and keeps the stock status right', async () => {
    const paper = await stock(a.admin, 'Gloss paper', 10, { minStockLevel: 5 });
    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Gloss paper', 6)] });
    expect(res.status).toBe(201);

    const after = await Inventory.findById(paper._id);
    expect(after.quantity).toBe(4);
    expect(after.stockStatus).toBe('low_stock');
    const [sale] = await salesOf(paper);
    expect(sale).toMatchObject({ quantity: 6, previousQuantity: 10, newQuantity: 4, referenceNumber: res.body.data.invoice.invoiceNumber });
    expect(String(sale.referenceId)).toBe(res.body.data.invoice._id);
  });

  test('when the stock runs out after the check, nothing is written and no invoice number is used', async () => {
    const before = await Invoice.countDocuments({ dataScope: a.dataScope });
    const card = await stock(a.admin, 'Card stock', 2);
    // The check passed a moment ago; another invoice has since taken the stock.
    jest.spyOn(InventoryService, 'checkStockAvailability').mockResolvedValueOnce({ available: true, items: [], errors: [] });

    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Card stock', 3)] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Insufficient stock for invoice items');
    expect(res.body.details[0]).toMatch(/Card stock.*Available: 2, Required: 3/);
    expect(res.body.stockCheck[0]).toMatchObject({ itemName: 'Card stock', availableQuantity: 2, available: false });

    expect(await Invoice.countDocuments({ dataScope: a.dataScope })).toBe(before);
    expect(await quantityOf(card)).toBe(2);
    expect(await salesOf(card)).toHaveLength(0);

    // The next invoice takes the next number: the refused one used none.
    const highest = (await Invoice.find({ dataScope: a.dataScope }).select('invoiceNumber')).map((i) => i.invoiceNumber).sort().pop();
    const next = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Plain service', 1)] });
    expect(next.status).toBe(201);
    expect(Number(next.body.data.invoice.invoiceNumber.split('-').pop())).toBe(Number(highest.split('-').pop()) + 1);
  });

  test('a later line that runs short puts back what the earlier lines took', async () => {
    const vinyl = await stock(a.admin, 'Vinyl roll', 10);
    const ink = await stock(a.admin, 'Eco ink', 1);
    jest.spyOn(InventoryService, 'checkStockAvailability').mockResolvedValueOnce({ available: true, items: [], errors: [] });

    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Vinyl roll', 4), line('Eco ink', 2)] });
    expect(res.status).toBe(400);
    expect(await quantityOf(vinyl)).toBe(10);
    expect(await quantityOf(ink)).toBe(1);
    expect(await InventoryMovement.countDocuments({ inventoryItem: { $in: [vinyl._id, ink._id] } })).toBe(0);
  });

  test('if the invoice cannot be written, the stock it took goes back', async () => {
    const before = await Invoice.countDocuments({ dataScope: a.dataScope });
    const board = await stock(a.admin, 'Sunpack board', 8);
    jest.spyOn(Invoice, 'createNumbered').mockRejectedValueOnce(new Error('write failed'));

    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Sunpack board', 5)] });
    expect(res.status).toBe(500);
    expect(await quantityOf(board)).toBe(8);
    expect(await salesOf(board)).toHaveLength(0);
    expect(await Invoice.countDocuments({ dataScope: a.dataScope })).toBe(before);
  });

  test('if the stock movements cannot be recorded, the invoice is removed and the stock put back', async () => {
    const before = await Invoice.countDocuments({ dataScope: a.dataScope });
    const foam = await stock(a.admin, 'Foam board', 6);
    jest.spyOn(InventoryMovement, 'insertMany').mockRejectedValueOnce(new Error('write failed'));

    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Foam board', 2)] });
    expect(res.status).toBe(500);
    expect(await quantityOf(foam)).toBe(6);
    expect(await salesOf(foam)).toHaveLength(0);
    expect(await Invoice.countDocuments({ dataScope: a.dataScope })).toBe(before);
  });

  test('a server that turns a transaction down falls back to undoable steps', async () => {
    const tape = await stock(a.admin, 'Mounting tape', 5);
    jest.spyOn(transactions, 'supportsTransactions').mockResolvedValueOnce(true);

    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Mounting tape', 2)] });
    expect(res.status).toBe(201);
    expect(await quantityOf(tape)).toBe(3);
    expect(await salesOf(tape)).toHaveLength(1);
  });

  test('a stock item of another business with the same name is never touched', async () => {
    const mine = await stock(a.admin, 'Shared name paper', 5);
    const theirs = await stock(b.admin, 'Shared name paper', 50);
    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Shared name paper', 5)] });
    expect(res.status).toBe(201);
    expect(await quantityOf(mine)).toBe(0);
    expect(await quantityOf(theirs)).toBe(50);
    const refused = await adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Shared name paper', 1)] });
    expect(refused.status).toBe(400);
  });
});

describe('concurrent invoices', () => {
  test('never sell more than is in stock', async () => {
    const reams = await stock(a.admin, 'A3 reams', 10);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('A3 reams', 2)] }))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 400)).toHaveLength(3);

    expect(await quantityOf(reams)).toBe(0);
    const sales = await salesOf(reams);
    expect(sales).toHaveLength(5);
    // Each sale started from what the one before it left: 10 → 8 → 6 → 4 → 2 → 0.
    const steps = sales.map((s) => [s.previousQuantity, s.newQuantity]).sort((x, y) => y[0] - x[0]);
    expect(steps).toEqual([[10, 8], [8, 6], [6, 4], [4, 2], [2, 0]]);
    // Every sold sheet belongs to an invoice that exists.
    const invoiceIds = results.filter((r) => r.status === 201).map((r) => r.body.data.invoice._id).sort();
    expect(sales.map((s) => String(s.referenceId)).sort()).toEqual(invoiceIds);
  });

  test('two invoices taking the same item at the same moment both count', async () => {
    const rolls = await stock(a.admin, 'Flex roll', 10);
    const [first, second] = await Promise.all([
      adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Flex roll', 3)] }),
      adminA().post('/api/invoices', { customerId: String(custA2._id), items: [line('Flex roll', 4)] })
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await quantityOf(rolls)).toBe(3);
  });

  test('stock adjustments made at the same moment as sales neither undo them nor get undone', async () => {
    const sheets = await stock(a.admin, 'Synthetic sheets', 20);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => adminA().post('/api/invoices', { customerId: String(custA._id), items: [line('Synthetic sheets', 1)] })),
      ...Array.from({ length: 10 }, () => adminA().post(`/api/inventory/${sheets._id}/adjust`, { change: 2, type: 'purchase' }))
    ]);
    expect(results.map((r) => r.status)).toEqual([...Array(10).fill(201), ...Array(10).fill(200)]);
    // 20 − 10 sold + 20 received.
    expect(await quantityOf(sheets)).toBe(30);
  });

  test('each invoice gets its own number, in sequence', async () => {
    const c = await createOrg('intc');
    const cust = await make.customer(c.admin);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => as(c.tokens.admin).post('/api/invoices', { customerId: String(cust._id), items: [line('Design work', 1)] }))
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    const numbers = results.map((r) => r.body.data.invoice.invoiceNumber).sort();
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => `${thisMonth()}${String(i + 1).padStart(4, '0')}`));
  });

  test('numbering continues after invoices written before the counter existed', async () => {
    const d = await createOrg('intd');
    const cust = await make.customer(d.admin);
    // Older invoices, numbered by older code: 0001–0003.
    for (let n = 1; n <= 3; n += 1) {
      await make.invoice(d.admin, cust, { invoiceNumber: `${thisMonth()}${String(n).padStart(4, '0')}` });
    }
    const res = await as(d.tokens.admin).post('/api/invoices', { customerId: String(cust._id), items: [line('Design work', 1)] });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.invoiceNumber).toBe(`${thisMonth()}0004`);
  });

  test('a number taken at the last moment is retried under the next one, not a server error', async () => {
    const e = await createOrg('inte');
    const cust = await make.customer(e.admin);
    const first = await as(e.tokens.admin).post('/api/invoices', { customerId: String(cust._id), items: [line('Design work', 1)] });
    const taken = first.body.data.invoice.invoiceNumber;
    // Another request numbered its invoice with the same number first.
    jest.spyOn(Invoice, 'generateInvoiceNumber').mockResolvedValueOnce(taken);

    const res = await as(e.tokens.admin).post('/api/invoices', { customerId: String(cust._id), items: [line('Design work', 1)] });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.invoiceNumber).not.toBe(taken);
  });

  test('if no free number can be had, the answer is a clear 409 and nothing is left behind', async () => {
    const f = await createOrg('intf');
    const cust = await make.customer(f.admin);
    const item = await stock(f.admin, 'Kraft paper', 4);
    const first = await as(f.tokens.admin).post('/api/invoices', { customerId: String(cust._id), items: [line('Design work', 1)] });
    jest.spyOn(Invoice, 'generateInvoiceNumber').mockResolvedValue(first.body.data.invoice.invoiceNumber);

    const res = await as(f.tokens.admin).post('/api/invoices', { customerId: String(cust._id), items: [line('Kraft paper', 2)] });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/try again/i);
    expect(await quantityOf(item)).toBe(4);
    expect(await Invoice.countDocuments({ dataScope: f.dataScope })).toBe(1);
  });

  test('converting a quotation retries a taken number too', async () => {
    const quote = await adminA().post('/api/quotations', {
      customer_id: String(custA._id),
      items: [{ item_name: 'Brochures', quantity: 100, unit_price: 5, tax_rate: 18 }]
    });
    expect(quote.status).toBe(201);
    const taken = (await Invoice.findOne({ dataScope: a.dataScope }).sort({ createdAt: -1 })).invoiceNumber;
    jest.spyOn(Invoice, 'generateInvoiceNumber').mockResolvedValueOnce(taken);

    const res = await adminA().post(`/api/quotations/${quote.body.data.quotation._id}/convert-to-invoice`, {});
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.invoiceNumber).not.toBe(taken);
  });
});

describe('the job ticket an invoice is for', () => {
  let jobA;
  let jobA2;
  let jobB;
  beforeAll(async () => {
    jobA = await make.job(a.admin, custA, { title: 'Wedding backdrop' });
    jobA2 = await make.job(a.admin, custA2, { title: 'Other customer job' });
    jobB = await make.job(b.admin, custB, { title: 'Other business job' });
  });

  const invoiceCount = () => Invoice.countDocuments({ dataScope: a.dataScope });

  test('a job ticket of another business is not found, and nothing is billed', async () => {
    const before = await invoiceCount();
    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), jobId: String(jobB._id), items: [line('Design work', 1)] });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Job ticket not found');
    expect(await invoiceCount()).toBe(before);
  });

  test('a job ticket of a different customer is refused', async () => {
    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), jobId: String(jobA2._id), items: [line('Design work', 1)] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/different customer/);
  });

  test('a malformed job id is refused rather than ignored', async () => {
    const res = await adminA().post('/api/invoices', { customerId: String(custA._id), jobId: 'not-an-id', items: [line('Design work', 1)] });
    expect(res.status).toBe(404);
  });

  test("the business's own job ticket for the customer is linked — also when staff bill it", async () => {
    const res = await as(a.tokens.staff1).post('/api/invoices', { customerId: String(custA._id), jobId: String(jobA._id), items: [line('Design work', 1)] });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.jobId._id).toBe(String(jobA._id));
    // No job: "" (what the form sends) still means none.
    const none = await adminA().post('/api/invoices', { customerId: String(custA._id), jobId: '', items: [line('Design work', 1)] });
    expect(none.status).toBe(201);
    expect(none.body.data.invoice.jobId).toBeFalsy();
  });

  test('an edit cannot link another business\'s job, nor move a job ticket to another customer', async () => {
    const created = await adminA().post('/api/invoices', { customerId: String(custA._id), jobId: String(jobA._id), items: [line('Design work', 1)] });
    const id = created.body.data.invoice._id;

    expect((await adminA().put(`/api/invoices/${id}`, { jobId: String(jobB._id) })).status).toBe(404);
    const moved = await adminA().put(`/api/invoices/${id}`, { customerId: String(custA2._id), jobId: String(jobA._id) });
    expect(moved.status).toBe(400);
    const stored = await Invoice.findById(id);
    expect(String(stored.customerId)).toBe(String(custA._id));
    expect(String(stored.jobId)).toBe(String(jobA._id));

    // Moving it with the new customer's job, or without a job, is fine.
    expect((await adminA().put(`/api/invoices/${id}`, { customerId: String(custA2._id), jobId: String(jobA2._id) })).status).toBe(200);
    expect((await adminA().put(`/api/invoices/${id}`, { customerId: String(custA._id), jobId: null })).status).toBe(200);
    // Editing other fields of an invoice keeps its job without re-checking it.
    expect((await adminA().put(`/api/invoices/${id}`, { notes: 'Deliver by Friday', jobId: '' })).status).toBe(200);
  });
});

describe('signing in', () => {
  const login = (email, password, ip) => {
    const req = request(app).post('/api/auth/login').send({ email, password });
    return ip ? req.set('X-Forwarded-For', ip) : req;
  };

  describe('with the client address known (TRUST_PROXY set)', () => {
    beforeAll(() => app.set('trust proxy', 1));
    afterAll(() => app.set('trust proxy', false));

    test('ten wrong passwords for one account stop further tries on it, but not on other accounts', async () => {
      const ip = '203.0.113.10';
      for (let i = 0; i < 10; i += 1) expect((await login(a.staff1.email, 'wrong-password', ip)).status).toBe(401);

      const blocked = await login(a.staff1.email, 'wrong-password', ip);
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('TOO_MANY_LOGIN_ATTEMPTS');
      expect(blocked.body.message).toMatch(/Try again in \d+ minutes?/);
      expect(blocked.headers['retry-after']).toBeDefined();
      // Even the right password waits now…
      expect((await login(a.staff1.email, 'Passw0rd!', ip)).status).toBe(429);
      // …but another account at the same address, and the same account from elsewhere, are not held up.
      expect((await login(a.staff2.email, 'Passw0rd!', ip)).status).toBe(200);
      expect((await login(a.staff1.email, 'Passw0rd!', '203.0.113.11')).status).toBe(200);
    });

    test('successful sign-ins never count, however many', async () => {
      const ip = '203.0.113.20';
      for (let i = 0; i < 60; i += 1) expect((await login(a.manager.email, 'Passw0rd!', ip)).status).toBe(200);
      // A few typos among them are fine too.
      for (let i = 0; i < 5; i += 1) expect((await login(a.manager.email, 'typo', ip)).status).toBe(401);
      expect((await login(a.manager.email, 'Passw0rd!', ip)).status).toBe(200);
    });

    test('fifty failures across many accounts from one address stop that address', async () => {
      const ip = '203.0.113.30';
      for (let i = 0; i < 50; i += 1) expect((await login(`nobody-${i}@example.test`, 'guess', ip)).status).toBe(401);
      expect((await login('nobody-51@example.test', 'guess', ip)).status).toBe(429);
      expect((await login(b.admin.email, 'Passw0rd!', '203.0.113.31')).status).toBe(200);
    });
  });

  test('behind a proxy that is not trusted, failures from different people are not added together', async () => {
    // Without TRUST_PROXY every request seems to come from the proxy; the
    // per-address limit stands aside instead of locking everyone out.
    for (let i = 0; i < 55; i += 1) {
      expect((await login(`typo-${i}@example.test`, 'guess', `198.51.100.${i}`)).status).toBe(401);
    }
    expect((await login(b.manager.email, 'Passw0rd!', '198.51.100.200')).status).toBe(200);
  });
});
