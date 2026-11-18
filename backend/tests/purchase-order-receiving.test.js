/**
 * Receiving goods against a purchase order: duplicate lines are combined
 * before the due check, a retried request is recorded once, concurrent
 * receipts cannot together receive more than is due, and a failure after
 * the first write leaves the order, the stock and the movements unchanged.
 */
const request = require('supertest');
const app = require('../src/app');
const Vendor = require('../src/models/Vendor');
const Inventory = require('../src/models/Inventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const PurchaseOrder = require('../src/models/PurchaseOrder');
const InventoryService = require('../src/services/InventoryService');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let vendor;
const api = () => ({
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body)
});

let n = 0;
const stockItem = (quantity = 10, unitCost = 100) => Inventory.create({
  name: `Board ${(n += 1)}`, sku: `PO-${process.pid}-${n}`, category: 'Paper & Printing Materials', quantity, unit: 'sheets',
  unitCost, minStockLevel: 1, userId: org.admin._id, dataScope: org.dataScope
});

/** A placed order for the given lines ({ item, quantity, unitCost }). */
async function placedOrder(lines) {
  const res = await api().post('/api/purchase-orders', {
    vendorId: String(vendor._id), send: true,
    items: lines.map((l) => ({ inventoryId: String(l.item._id), quantity: l.quantity, unitCost: l.unitCost || 100 }))
  });
  expect(res.status).toBe(201);
  return res.body.data.purchaseOrder;
}
const receive = (po, lines, extra = {}) => api().post(`/api/purchase-orders/${po._id}/receive`, {
  lines: lines.map(([item, quantity]) => ({ inventoryId: String(item._id), quantity })), ...extra
});
const qty = async (item) => (await Inventory.findById(item._id).lean()).quantity;
const movements = (po) => InventoryMovement.find({ referenceId: po._id }).lean();

beforeAll(async () => {
  await connectTestDb('purchase_order_receiving');
  org = await createOrg('porecv');
  vendor = await Vendor.create({ name: 'Board Mills', vendorType: 'Supplier', userId: org.admin._id, dataScope: org.dataScope });
});
afterAll(disconnectTestDb);

describe('duplicate lines', () => {
  test('two request lines for one item are added up before the due check', async () => {
    const board = await stockItem();
    const po = await placedOrder([{ item: board, quantity: 10 }]);

    // 6 + 6 = 12 is more than the 10 due, even though each line alone fits.
    const over = await receive(po, [[board, 6], [board, 6]]);
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/Only 10 more/);
    expect(await qty(board)).toBe(10);

    const ok = await receive(po, [[board, 4], [board, 6]]);
    expect(ok.status).toBe(200);
    expect(ok.body.data.purchaseOrder.status).toBe('completed');
    expect(await qty(board)).toBe(20);
    const recorded = await movements(po);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ quantity: 10, previousQuantity: 10, newQuantity: 20 });
  });

  test('an older order listing one item twice is received against both lines once', async () => {
    const board = await stockItem();
    // Orders can no longer be created this way; older ones exist.
    const refused = await api().post('/api/purchase-orders', { vendorId: String(vendor._id), send: true, items: [
      { inventoryId: String(board._id), quantity: 3, unitCost: 100 }, { inventoryId: String(board._id), quantity: 4, unitCost: 120 }
    ] });
    expect(refused.status).toBe(400);
    const po = await placedOrder([{ item: board, quantity: 3 }]);
    await PurchaseOrder.updateOne({ _id: po._id }, { $push: { items: { inventoryId: board._id, itemName: board.name, quantity: 4, unitCost: 120, totalCost: 480, receivedQuantity: 0, pendingQuantity: 4 } } });

    expect((await receive(po, [[board, 8]])).status).toBe(400);
    const res = await receive(po, [[board, 5]]);
    expect(res.status).toBe(200);
    const saved = await PurchaseOrder.findById(po._id).lean();
    expect(saved.items.map((i) => i.receivedQuantity)).toEqual([3, 2]);
    expect(saved.status).toBe('partial');
    expect(await qty(board)).toBe(15);
    const [movement] = await movements(po);
    // 3 at ₹100 and 2 at ₹120.
    expect(movement).toMatchObject({ quantity: 5, totalCost: 540, unitCost: 108 });
    expect((await Inventory.findById(board._id).lean()).unitCost).toBe(120);
  });
});

describe('retries', () => {
  test('the same idempotency key records the delivery once', async () => {
    const board = await stockItem();
    const po = await placedOrder([{ item: board, quantity: 10 }]);
    const key = `retry-${process.pid}-1`;

    const first = await receive(po, [[board, 4]], { idempotencyKey: key });
    const again = await request(app).post(`/api/purchase-orders/${po._id}/receive`).set(auth(org.tokens.admin)).set('Idempotency-Key', key)
      .send({ lines: [{ inventoryId: String(board._id), quantity: 4 }] });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.data.replayed).toBe(true);
    expect(await qty(board)).toBe(14);
    expect(await movements(po)).toHaveLength(1);
    expect((await PurchaseOrder.findById(po._id).lean()).receipts).toHaveLength(1);

    // A new delivery (new key) is still received.
    expect((await receive(po, [[board, 1]], { idempotencyKey: `retry-${process.pid}-2` })).status).toBe(200);
    expect(await qty(board)).toBe(15);
  });

  test('a retry after a failed attempt succeeds once', async () => {
    const board = await stockItem();
    const po = await placedOrder([{ item: board, quantity: 10 }]);
    const key = `retry-${process.pid}-3`;
    const spy = jest.spyOn(InventoryMovement, 'insertMany').mockRejectedValueOnce(new Error('connection reset'));
    try {
      expect((await receive(po, [[board, 10]], { idempotencyKey: key })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await qty(board)).toBe(10);

    expect((await receive(po, [[board, 10]], { idempotencyKey: key })).status).toBe(200);
    expect((await receive(po, [[board, 10]], { idempotencyKey: key })).body.data.replayed).toBe(true);
    expect(await qty(board)).toBe(20);
    expect(await movements(po)).toHaveLength(1);
  });
});

describe('concurrent receipts', () => {
  test('two deliveries for everything due: one is recorded, the other refused', async () => {
    const board = await stockItem();
    const po = await placedOrder([{ item: board, quantity: 10 }]);
    const results = await Promise.all([receive(po, [[board, 10]]), receive(po, [[board, 10]])]);
    // The second re-reads the order, now received in full, and is refused.
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.message).toMatch(/Everything on this order has been received/);
    expect(await qty(board)).toBe(20);
    expect(await movements(po)).toHaveLength(1);
    const saved = await PurchaseOrder.findById(po._id).lean();
    expect(saved).toMatchObject({ status: 'completed' });
    expect(saved.items[0].receivedQuantity).toBe(10);
    expect(saved.receipts).toHaveLength(1);
  });

  test('partial deliveries at the same moment both land and add up', async () => {
    const board = await stockItem();
    const po = await placedOrder([{ item: board, quantity: 10 }]);
    const results = await Promise.all([receive(po, [[board, 3]]), receive(po, [[board, 4]]), receive(po, [[board, 2]])]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await qty(board)).toBe(19);
    const saved = await PurchaseOrder.findById(po._id).lean();
    expect(saved.items[0]).toMatchObject({ receivedQuantity: 9, pendingQuantity: 1 });
    expect(saved.receipts).toHaveLength(3);
    expect(saved.status).toBe('partial');
    const recorded = (await movements(po)).sort((a, b) => a.previousQuantity - b.previousQuantity);
    expect(recorded.map((m) => m.quantity).reduce((s, q) => s + q, 0)).toBe(9);
  });
});

describe('a failure after the first write', () => {
  test('stock of the second item failing puts back the order and the first item', async () => {
    const [a, b] = await Promise.all([stockItem(5), stockItem(7)]);
    const po = await placedOrder([{ item: a, quantity: 10 }, { item: b, quantity: 10 }]);
    const real = InventoryService.changeStock.bind(InventoryService);
    let calls = 0;
    const spy = jest.spyOn(InventoryService, 'changeStock').mockImplementation((filter, delta, opts) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('write failed'));
      return real(filter, delta, opts);
    });
    let res;
    try {
      res = await receive(po, [[a, 4], [b, 6]]);
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(await qty(a)).toBe(5);
    expect(await qty(b)).toBe(7);
    expect(await movements(po)).toHaveLength(0);
    const saved = await PurchaseOrder.findById(po._id).lean();
    expect(saved.status).toBe('sent');
    expect(saved.items.map((i) => i.receivedQuantity)).toEqual([0, 0]);
    expect(saved.receipts).toHaveLength(0);

    // And it can be received afterwards.
    expect((await receive(po, [[a, 4], [b, 6]])).status).toBe(200);
    expect([await qty(a), await qty(b)]).toEqual([9, 13]);
  });

  test('a movement write failing on a partly received order restores it as it was', async () => {
    const board = await stockItem(0);
    const po = await placedOrder([{ item: board, quantity: 10 }]);
    expect((await receive(po, [[board, 3]])).status).toBe(200);
    const spy = jest.spyOn(InventoryMovement, 'insertMany').mockRejectedValueOnce(new Error('write failed'));
    try {
      expect((await receive(po, [[board, 7]])).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const saved = await PurchaseOrder.findById(po._id).lean();
    expect(saved).toMatchObject({ status: 'partial' });
    expect(saved.items[0].receivedQuantity).toBe(3);
    expect(saved.receipts).toHaveLength(1);
    expect(saved.completedAt).toBeUndefined();
    expect(await qty(board)).toBe(3);
    expect(await movements(po)).toHaveLength(1);
  });

  test('a stock item removed from Paper & stock is refused before anything is written', async () => {
    const board = await stockItem();
    const po = await placedOrder([{ item: board, quantity: 10 }]);
    await Inventory.deleteOne({ _id: board._id });
    const res = await receive(po, [[board, 2]]);
    expect(res.status).toBe(409);
    expect((await PurchaseOrder.findById(po._id).lean()).receipts).toHaveLength(0);
  });
});
