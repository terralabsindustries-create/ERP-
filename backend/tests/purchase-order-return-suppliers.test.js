/** Purchase returns (reversing a received delivery) and the supplier list on stock items. */
const request = require('supertest');
const app = require('../src/app');
const Vendor = require('../src/models/Vendor');
const Inventory = require('../src/models/Inventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const PurchaseOrder = require('../src/models/PurchaseOrder');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let v1;
let v2;
const api = (m, url, body) => request(app)[m](url).set(auth(org.tokens.admin)).send(body);
let n = 0;
const stockItem = (quantity = 10) => Inventory.create({
  name: `Ret Board ${(n += 1)}`, sku: `RET-${process.pid}-${n}`, category: 'Paper & Printing Materials', quantity, unit: 'sheets',
  unitCost: 10, minStockLevel: 1, userId: org.admin._id, dataScope: org.dataScope
});
const order = async (vendor, item, quantity) => (await api('post', '/api/purchase-orders', { vendorId: String(vendor._id), send: true, items: [{ inventoryId: String(item._id), quantity, unitCost: 12 }] })).body.data.purchaseOrder;
const receive = (po, item, quantity) => api('post', `/api/purchase-orders/${po._id}/receive`, { lines: [{ inventoryId: String(item._id), quantity }] });
const qty = async (item) => (await Inventory.findById(item._id)).quantity;

beforeAll(async () => {
  await connectTestDb('porets');
  org = await createOrg('poret');
  v1 = await Vendor.create({ name: 'Mill One', vendorType: 'Supplier', userId: org.admin._id, dataScope: org.dataScope });
  const Settings = require('../src/models/Settings');
  const settings = await Settings.getOrCreateSettings(org.admin._id);
  settings.companyName = 'PO Printers Pvt Ltd';
  await settings.save();
  v2 = await Vendor.create({ name: 'Mill Two', vendorType: 'Supplier', userId: org.admin._id, dataScope: org.dataScope });
});
afterAll(disconnectTestDb);

test('an item bought from two suppliers keeps both, and a typed supplier is not overwritten', async () => {
  const item = await stockItem(0);
  const typed = await stockItem(0);
  await Inventory.updateOne({ _id: typed._id }, { $set: { supplier: 'Typed Supplier' } });
  const p1 = await order(v1, item, 10);
  const p2 = await order(v2, item, 5);
  expect((await receive(p1, item, 10)).status).toBe(200);
  expect((await receive(p2, item, 5)).status).toBe(200);
  const saved = await Inventory.findById(item._id).lean();
  expect(saved.suppliers.map((s) => [s.vendorName, s.totalReceived]).sort()).toEqual([['Mill One', 10], ['Mill Two', 5]]);
  expect(saved.supplier).toBe('Mill One'); // first supplier fills the blank text; the second does not replace it

  const p3 = await order(v1, typed, 3);
  await receive(p3, typed, 3);
  expect((await Inventory.findById(typed._id)).supplier).toBe('Typed Supplier');
});

test('returning a delivery takes the stock back, keeps the record, and cannot be repeated', async () => {
  const item = await stockItem(0);
  const po = await order(v1, item, 10);
  const rec = (await receive(po, item, 10)).body.data.purchaseOrder;
  expect(rec.status).toBe('completed');
  expect(await qty(item)).toBe(10);

  const noReason = await api('post', `/api/purchase-orders/${po._id}/receipts/${rec.receipts[0]._id}/reverse`, {});
  expect(noReason.status).toBe(400);

  const back = await api('post', `/api/purchase-orders/${po._id}/receipts/${rec.receipts[0]._id}/reverse`, { reason: 'Damaged' });
  expect(back.status).toBe(200);
  expect(await qty(item)).toBe(0);
  const stored = await PurchaseOrder.findById(po._id).lean();
  expect(stored.status).toBe('sent');
  expect(stored.items[0].receivedQuantity).toBe(0);
  expect(stored.receipts[0]).toMatchObject({ reverseReason: 'Damaged' });
  expect(stored.receipts[0].reversedAt).toBeTruthy();
  const mv = await InventoryMovement.find({ referenceId: po._id, movementType: 'return' }).lean();
  expect(mv).toHaveLength(1);
  expect(mv[0].quantity).toBe(10);
  expect((await Inventory.findById(item._id)).suppliers[0].totalReceived).toBe(0);

  const again = await api('post', `/api/purchase-orders/${po._id}/receipts/${rec.receipts[0]._id}/reverse`, { reason: 'Again' });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('ALREADY_REVERSED');
  expect(await qty(item)).toBe(0);

  // The order can be received again afterwards.
  expect((await receive(po, item, 10)).status).toBe(200);
  expect(await qty(item)).toBe(10);
});

test('a delivery already used or sold cannot be returned; two simultaneous returns apply once', async () => {
  const item = await stockItem(0);
  const po = await order(v1, item, 10);
  const rec = (await receive(po, item, 10)).body.data.purchaseOrder;
  await Inventory.updateOne({ _id: item._id }, { $set: { quantity: 4 } }); // 6 used
  const refused = await api('post', `/api/purchase-orders/${po._id}/receipts/${rec.receipts[0]._id}/reverse`, { reason: 'Wrong' });
  expect(refused.status).toBe(409);
  expect(await qty(item)).toBe(4);
  expect((await PurchaseOrder.findById(po._id)).receipts[0].reversedAt).toBeUndefined();

  await Inventory.updateOne({ _id: item._id }, { $set: { quantity: 10 } });
  const res = await Promise.all([1, 2, 3].map(() => api('post', `/api/purchase-orders/${po._id}/receipts/${rec.receipts[0]._id}/reverse`, { reason: 'Race' })));
  expect(res.filter((r) => r.status === 200)).toHaveLength(1);
  expect(await qty(item)).toBe(0);
});

describe('purchase order documents', () => {
  const mailer = require('../src/utils/mailer');
  afterEach(() => jest.restoreAllMocks());

  test('PDF previews inline, downloads only on request, and carries the order', async () => {
    const item = await stockItem(0);
    const po = await order(v1, item, 7);
    const inline = await request(app).get(`/api/purchase-orders/${po._id}/pdf`).set(auth(org.tokens.admin)).buffer().parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(inline.status).toBe(200);
    expect(inline.headers['content-disposition']).toMatch(/^inline/);
    expect(inline.body.subarray(0, 4).toString()).toBe('%PDF');
    const file = await request(app).get(`/api/purchase-orders/${po._id}/pdf?download=1`).set(auth(org.tokens.admin));
    expect(file.headers['content-disposition']).toMatch(/^attachment/);

    const PDFService = require('../src/services/PDFService');
    const d = PDFService.purchaseOrderDocument(await PurchaseOrder.findById(po._id).lean(), { name: 'X', currency: 'INR' }, { gstNumber: '27AAPFU0939F1ZV' });
    expect(d).toMatchObject({ type: 'PURCHASE ORDER', number: po.poNumber });
    expect(d.customer.name).toBe('Mill One');
    expect(d.customer.lines.join(' ')).toMatch(/27AAPFU0939F1ZV/);
    expect(d.items).toHaveLength(1);
    expect(d.summary.find((r) => r.label === 'Total').value).toBe('INR 84.00');
  });

  test('email goes to the supplier with the PDF attached; one without an email is refused; another org cannot read it', async () => {
    const item = await stockItem(0);
    const po = await order(v1, item, 2);
    const sendMail = jest.fn(async () => ({}));
    jest.spyOn(mailer, 'isEmailConfigured').mockReturnValue(true);
    jest.spyOn(mailer, 'createTransporter').mockReturnValue({ sendMail });

    const none = await api('post', `/api/purchase-orders/${po._id}/send-email`, {});
    expect(none.status).toBe(400);

    const ok = await api('post', `/api/purchase-orders/${po._id}/send-email`, { recipientEmail: 'orders@mill.test', message: 'Please confirm' });
    expect(ok.status).toBe(200);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('orders@mill.test');
    expect(mail.attachments[0].filename).toBe(`PurchaseOrder_${po.poNumber}.pdf`);
    expect(mail.attachments[0].content.subarray(0, 4).toString()).toBe('%PDF');

    const stranger = await createOrg('poother');
    const peek = await request(app).get(`/api/purchase-orders/${po._id}/pdf`).set(auth(stranger.tokens.admin));
    expect(peek.status).toBe(404);
  });
});
