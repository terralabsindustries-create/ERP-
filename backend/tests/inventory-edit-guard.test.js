/**
 * Editing a stock item (PUT /inventory/:id, POST /inventory/bulk-update)
 * changes its details only. The stock count, ownership, business, SKU and
 * bookkeeping fields are refused, and stock moves only through
 * POST /:id/adjust (Inventory: Adjust Stock), which records a movement.
 */
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Inventory = require('../src/models/Inventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const ActivityLog = require('../src/models/ActivityLog');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');

let org;
let other;
const as = (token) => ({
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body)
});

let n = 0;
const stockItem = (owner, extra = {}) => Inventory.create({
  name: `Art paper ${(n += 1)}`, sku: `GUARD-${process.pid}-${n}`, category: 'Paper & Printing Materials', quantity: 50, unit: 'reams',
  unitCost: 300, minStockLevel: 5, userId: owner._id, dataScope: owner.dataScope, ...extra
});

/** Activity log writes are fire-and-forget; wait for the one expected. */
async function logged(filter) {
  for (let i = 0; i < 40; i += 1) {
    const entry = await ActivityLog.findOne(filter).lean();
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

beforeAll(async () => {
  await connectTestDb('inventory_edit_guard');
  org = await createOrg('invguard');
  other = await createOrg('invguardother');
  // staff1 edits items but cannot adjust stock; staff2 adjusts stock but cannot edit items.
  await User.updateOne({ _id: org.staff1._id }, { $set: { permissions: ['Inventory', 'Inventory: View', 'Inventory: Create & Edit'] } });
  await User.updateOne({ _id: org.staff2._id }, { $set: { permissions: ['Inventory', 'Inventory: View', 'Inventory: Adjust Stock'] } });
});
afterAll(disconnectTestDb);

describe('PUT /inventory/:id', () => {
  test('edits details, and an echoed unchanged stock count is ignored', async () => {
    const item = await stockItem(org.admin);
    const res = await as(org.tokens.staff1).put(`/api/inventory/${item._id}`, { name: 'Art paper 300gsm', minStockLevel: 8, quantity: 50, sku: item.sku });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Art paper 300gsm', minStockLevel: 8, quantity: 50 });

    const entry = await logged({ entityId: item._id, action: 'Inventory Item Updated' });
    expect(entry.changes.fields.sort()).toEqual(['minStockLevel', 'name']);
    expect(entry.changes.before).toMatchObject({ name: item.name, minStockLevel: 5 });
    expect(entry.changes.after).toMatchObject({ name: 'Art paper 300gsm', minStockLevel: 8 });
  });

  test('refuses a stock count change, records the refusal and changes nothing', async () => {
    const item = await stockItem(org.admin);
    const res = await as(org.tokens.staff1).put(`/api/inventory/${item._id}`, { name: 'Renamed', quantity: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['quantity']);
    expect(res.body.message).toMatch(/Adjust stock/);
    expect(await Inventory.findById(item._id).lean()).toMatchObject({ name: item.name, quantity: 50 });
    expect(await InventoryMovement.countDocuments({ inventoryItem: item._id })).toBe(0);
    const refusal = await logged({ entityId: item._id, action: 'Inventory Edit Refused' });
    expect(refusal).toMatchObject({ severity: 'medium', changes: { fields: ['quantity'] } });
  });

  test.each([
    ['ownership', () => ({ userId: String(other.admin._id) })],
    ['business', () => ({ dataScope: other.dataScope })],
    ['stock status', () => ({ stockStatus: 'out_of_stock' })],
    ['SKU', () => ({ sku: 'NEW-SKU-1' })],
    ['timestamps', () => ({ createdAt: '2020-01-01T00:00:00.000Z' })]
  ])('refuses a change to %s', async (_label, body) => {
    const item = await stockItem(org.admin);
    const before = await Inventory.findById(item._id).lean();
    const res = await as(org.tokens.admin).put(`/api/inventory/${item._id}`, body());
    expect(res.status).toBe(400);
    const after = await Inventory.findById(item._id).lean();
    expect(after).toMatchObject({ userId: before.userId, dataScope: before.dataScope, sku: before.sku, stockStatus: before.stockStatus, quantity: 50 });
    expect(after.createdAt).toEqual(before.createdAt);
  });

  test('refuses unknown fields such as movement history', async () => {
    const item = await stockItem(org.admin);
    const res = await as(org.tokens.admin).put(`/api/inventory/${item._id}`, { movements: [{ quantity: 99 }], name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['movements']);
    expect((await Inventory.findById(item._id).lean()).name).toBe(item.name);
  });

  test("cannot reach another business's item", async () => {
    const theirs = await stockItem(other.admin);
    expect((await as(org.tokens.admin).put(`/api/inventory/${theirs._id}`, { name: 'Mine now' })).status).toBe(404);
  });

  test('needs Inventory: Create & Edit', async () => {
    const item = await stockItem(org.admin);
    expect((await as(org.tokens.staff2).put(`/api/inventory/${item._id}`, { name: 'No' })).status).toBe(403);
  });
});

describe('POST /inventory/bulk-update', () => {
  test('one refused edit refuses the whole request', async () => {
    const [a, b] = await Promise.all([stockItem(org.admin), stockItem(org.admin)]);
    const res = await as(org.tokens.staff1).post('/api/inventory/bulk-update', { items: [
      { id: String(a._id), updates: { location: 'Shelf 4' } },
      { id: String(b._id), updates: { quantity: 1 } }
    ] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ itemId: String(b._id), fields: ['quantity'] });
    expect((await Inventory.findById(a._id).lean()).location).toBeUndefined();
    expect((await Inventory.findById(b._id).lean()).quantity).toBe(50);
  });

  test('applies editable fields to every item and logs each', async () => {
    const [a, b] = await Promise.all([stockItem(org.admin), stockItem(org.admin)]);
    const res = await as(org.tokens.staff1).post('/api/inventory/bulk-update', { items: [
      { id: String(a._id), updates: { location: 'Shelf 1' } },
      { id: String(b._id), updates: { location: 'Shelf 2', supplier: 'Paper House' } }
    ] });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect((await Inventory.findById(b._id).lean())).toMatchObject({ location: 'Shelf 2', supplier: 'Paper House', quantity: 50 });
    expect(await logged({ entityId: a._id, action: 'Inventory Item Updated' })).not.toBeNull();
    expect(await logged({ entityId: b._id, action: 'Inventory Item Updated' })).not.toBeNull();
  });

  test('needs Inventory: Create & Edit — Adjust Stock alone does not allow it', async () => {
    const item = await stockItem(org.admin);
    const res = await as(org.tokens.staff2).post('/api/inventory/bulk-update', { items: [{ id: String(item._id), updates: { location: 'X' } }] });
    expect(res.status).toBe(403);
  });

  test("an item of another business is not found and nothing changes", async () => {
    const [mine, theirs] = await Promise.all([stockItem(org.admin), stockItem(other.admin)]);
    const res = await as(org.tokens.admin).post('/api/inventory/bulk-update', { items: [
      { id: String(mine._id), updates: { location: 'A' } },
      { id: String(theirs._id), updates: { location: 'B' } }
    ] });
    expect(res.status).toBe(404);
    expect((await Inventory.findById(mine._id).lean()).location).toBeUndefined();
  });
});

describe('stock moves only through Adjust stock', () => {
  test('editors without Adjust Stock cannot adjust', async () => {
    const item = await stockItem(org.admin);
    expect((await as(org.tokens.staff1).post(`/api/inventory/${item._id}/adjust`, { change: 10 })).status).toBe(403);
  });

  test('an adjustment changes the count, records a movement and an audit entry', async () => {
    const item = await stockItem(org.admin);
    const res = await as(org.tokens.staff2).post(`/api/inventory/${item._id}/adjust`, { change: -7, type: 'damage', reason: 'Water damage' });
    expect(res.status).toBe(200);
    expect((await Inventory.findById(item._id).lean()).quantity).toBe(43);
    const movement = await InventoryMovement.findOne({ inventoryItem: item._id }).lean();
    expect(movement).toMatchObject({ movementType: 'damage', quantity: 7, previousQuantity: 50, newQuantity: 43, userId: org.staff2._id });
    const entry = await logged({ entityId: item._id, action: 'Inventory Stock Adjusted' });
    expect(entry.changes).toMatchObject({ before: { quantity: 50 }, after: { quantity: 43 } });
  });

  test('if the movement cannot be recorded the count is put back', async () => {
    const item = await stockItem(org.admin);
    const spy = jest.spyOn(InventoryMovement, 'create').mockRejectedValueOnce(new Error('disk full'));
    try {
      const res = await as(org.tokens.staff2).post(`/api/inventory/${item._id}/adjust`, { quantity: 10 });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await Inventory.findById(item._id).lean()).quantity).toBe(50);
    expect(await InventoryMovement.countDocuments({ inventoryItem: item._id })).toBe(0);
  });
});
