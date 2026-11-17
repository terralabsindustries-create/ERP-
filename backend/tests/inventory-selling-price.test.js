/**
 * Stock items keep a purchase price (unitCost) and an optional selling price.
 * The selling price can be set and cleared; receiving a purchase order moves
 * the purchase price to what was last paid and leaves the selling price alone.
 */
const request = require('supertest');
const app = require('../src/app');
const Vendor = require('../src/models/Vendor');
const Inventory = require('../src/models/Inventory');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
const admin = () => ({
  get: (url) => request(app).get(url).set(auth(org.tokens.admin)),
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body),
  put: (url, body) => request(app).put(url).set(auth(org.tokens.admin)).send(body)
});

beforeAll(async () => {
  await connectTestDb('sellingprice');
  org = await createOrg('sell');
});
afterAll(disconnectTestDb);

test('a new item can carry a selling price apart from its purchase price', async () => {
  const res = await admin().post('/api/inventory', { name: 'VIP chair', category: 'Tools & Equipment', quantity: 20, unit: 'pieces', unitCost: 900, sellingPrice: 1500, minStockLevel: 2 });
  expect(res.status).toBe(201);
  expect(res.body.data).toMatchObject({ unitCost: 900, sellingPrice: 1500 });
});

test('an existing item has no selling price until one is set, and it can be cleared', async () => {
  const item = await make.stockItem(org.admin);
  expect(item.sellingPrice).toBeNull();

  let res = await admin().put(`/api/inventory/${item._id}`, { sellingPrice: 180 });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ unitCost: 100, sellingPrice: 180 });

  expect((await admin().put(`/api/inventory/${item._id}`, { sellingPrice: -5 })).status).toBe(400);

  res = await admin().put(`/api/inventory/${item._id}`, { sellingPrice: null });
  expect(res.status).toBe(200);
  expect(res.body.data.sellingPrice).toBeNull();
});

test('receiving a purchase order sets the purchase price to what was paid', async () => {
  const vendor = await Vendor.create({ name: 'Board Traders', vendorType: 'Supplier', userId: org.admin._id, createdBy: org.admin._id, dataScope: org.dataScope });
  const paper = await make.stockItem(org.admin, { sellingPrice: 160 });
  const po = (await admin().post('/api/purchase-orders', { vendorId: String(vendor._id), send: true, items: [{ inventoryId: String(paper._id), quantity: 10, unitCost: 120 }] })).body.data.purchaseOrder;

  const res = await admin().post(`/api/purchase-orders/${po._id}/receive`, { lines: [{ inventoryId: String(paper._id), quantity: 10 }] });
  expect(res.status).toBe(200);
  const after = await Inventory.findById(paper._id);
  expect(after).toMatchObject({ quantity: 12, unitCost: 120, sellingPrice: 160 });
});
