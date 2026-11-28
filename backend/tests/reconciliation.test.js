const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Inventory = require('../src/models/Inventory');
const Customer = require('../src/models/Customer');
const InventoryMovement = require('../src/models/InventoryMovement');
const PurchaseBill = require('../src/models/PurchaseBill');
const TransactionJournal = require('../src/models/TransactionJournal');
const ActivityLog = require('../src/models/ActivityLog');
const User = require('../src/models/User');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
const get = (url, token) => request(app).get(url).set(auth(token || org.tokens.admin));
const codes = (res, check) => res.body.data.checks[check].findings.map((f) => f.code);
const mv = (item, over) => ({ inventoryItem: item._id, itemName: item.name, movementType: 'sale', quantity: 1, unit: 'sheets', unitCost: 1, totalCost: 1, previousQuantity: 10, newQuantity: 9, referenceType: 'adjustment', userId: org.admin._id, dataScope: org.dataScope, ...over });

beforeAll(async () => {
  await connectTestDb('reconciliation');
  org = await createOrg('recon');
  other = await createOrg('recon_other');
});
afterAll(disconnectTestDb);

test('a healthy business reconciles with no findings', async () => {
  const c = await make.customer(org.admin);
  await make.invoice(org.admin, c, { lines: [{ amount: 1000, rate: 18 }] });
  await c.updateStats();
  const res = await get('/api/reconciliation');
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ readOnly: true, consistent: true, totals: { findings: 0 } });
});

test('inconsistent invoices, balances, stock, receipts and cancellations are reported, and nothing is modified', async () => {
  const c = await make.customer(org.admin);
  const overpaid = await make.invoice(org.admin, c, { lines: [{ amount: 1000, rate: 0 }] });
  await Invoice.collection.updateOne({ _id: overpaid._id }, { $set: { paidAmount: 1500, balanceAmount: 0 } });
  const wrongBalance = await make.invoice(org.admin, c, { lines: [{ amount: 500, rate: 0 }] });
  await Invoice.collection.updateOne({ _id: wrongBalance._id }, { $set: { balanceAmount: 123 } });
  const markedPaid = await make.invoice(org.admin, c, { lines: [{ amount: 400, rate: 0 }] });
  await Invoice.collection.updateOne({ _id: markedPaid._id }, { $set: { status: 'paid' } });

  const item = await make.stockItem(org.admin, { name: 'Recon paper', quantity: 7, unit: 'sheets' });
  await InventoryMovement.collection.insertOne(mv(item, { newQuantity: 9, createdAt: new Date() }));

  const cancelled = await make.invoice(org.admin, c, { lines: [{ amount: 100, rate: 0 }], status: 'cancelled' });
  await InventoryMovement.collection.insertOne(mv(item, { referenceType: 'invoice', referenceId: cancelled._id, quantity: 3, createdAt: new Date() }));

  await PurchaseBill.collection.insertOne({ billNumber: 'PB-1', totalAmount: 1000, paidAmount: 200, balanceAmount: 500, status: 'partial', dataScope: org.dataScope, userId: org.admin._id });
  const po = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('purchaseorders').insertOne({ _id: po, poNumber: 'PO-1', dataScope: org.dataScope, userId: org.admin._id, receipts: [{ lines: [{ inventoryId: item._id, quantity: 5 }] }] });
  await Customer.collection.updateOne({ _id: c._id }, { $set: { outstandingBalance: 99999 } });

  const snapshot = async () => JSON.stringify([await Invoice.find({ dataScope: org.dataScope }).sort('_id').lean(), await Inventory.find({ dataScope: org.dataScope }).sort('_id').lean(), await Customer.find({ dataScope: org.dataScope }).sort('_id').lean()]);
  const before = await snapshot();
  const res = await get('/api/reconciliation');
  expect(await snapshot()).toBe(before); // read-only: no record touched

  expect(codes(res, 'invoice_payments')).toEqual(expect.arrayContaining(['OVERPAID', 'BALANCE_MISMATCH', 'MARKED_PAID_WITH_BALANCE']));
  expect(codes(res, 'customer_balances')).toContain('STALE_CUSTOMER_STATS');
  expect(codes(res, 'vendor_balances')).toContain('BILL_BALANCE_MISMATCH');
  expect(codes(res, 'inventory_movements')).toContain('QUANTITY_DRIFT');
  expect(codes(res, 'purchase_receipts')).toContain('RECEIPT_STOCK_MISMATCH');
  expect(codes(res, 'cancelled_documents')).toContain('CANCELLED_WITHOUT_STOCK_REVERSAL');
  expect(res.body.data.consistent).toBe(false);
  expect(res.body.data.totals.findings).toBeGreaterThanOrEqual(7);
  const drift = res.body.data.checks.inventory_movements.findings.find((f) => f.entityNumber === 'Recon paper');
  expect(drift).toMatchObject({ expected: { quantity: 9 }, found: { quantity: 7 } });
});

test('interrupted operations are reported only after the grace period', async () => {
  await TransactionJournal.create({ label: 'fresh', status: 'started', dataScope: org.dataScope });
  await TransactionJournal.collection.insertOne({ label: 'Payment change', status: 'started', dataScope: org.dataScope, createdAt: new Date(Date.now() - 3600e3), updatedAt: new Date() });
  const res = await get('/api/reconciliation?checks=operations');
  expect(res.body.data.checks.operations.findings.map((f) => [f.code, f.entityNumber])).toEqual([['INTERRUPTED_OPERATION', 'Payment change']]);
});

describe('permissions and tenant isolation', () => {
  test('without Reconciliation: View a login gets 403; with it, 200; another business sees none of these findings', async () => {
    await User.updateOne({ _id: org.staff1._id }, { $set: { permissions: ['Dashboard', 'Accounts'] } });
    expect((await get('/api/reconciliation', org.tokens.staff1)).status).toBe(403);
    await User.updateOne({ _id: org.staff1._id }, { $set: { permissions: ['Dashboard', 'Reconciliation', 'Reconciliation: View'] } });
    expect((await get('/api/reconciliation', org.tokens.staff1)).status).toBe(200);
    const foreign = await get('/api/reconciliation', other.tokens.admin);
    expect(foreign.body.data.totals.findings).toBe(0);
  });

  test('View alone cannot resolve anything', async () => {
    const entry = await TransactionJournal.create({ label: 'x', status: 'compensation_failed', dataScope: org.dataScope });
    const res = await request(app).post('/api/reconciliation/resolve').set(auth(org.tokens.staff1)).send({ action: 'resolve_operation', id: String(entry._id), note: 'checked by hand' });
    expect(res.status).toBe(403);
  });
});

describe('explicit, audited corrections', () => {
  test('resolving a failed operation needs a note, is tenant-scoped and writes an audit event', async () => {
    const entry = await TransactionJournal.create({ label: 'Stock deduction', status: 'compensation_failed', dataScope: org.dataScope });
    const send = (token, body) => request(app).post('/api/reconciliation/resolve').set(auth(token)).send(body);
    expect((await send(org.tokens.admin, { action: 'resolve_operation', id: String(entry._id) })).status).toBe(400);
    expect((await send(other.tokens.admin, { action: 'resolve_operation', id: String(entry._id), note: 'not mine to resolve' })).status).toBe(404);
    expect((await send(org.tokens.admin, { action: 'resolve_operation', id: String(entry._id), note: 'Counted stock and corrected by hand' })).status).toBe(200);
    expect(await TransactionJournal.findById(entry._id)).toMatchObject({ status: 'resolved', resolutionNote: 'Counted stock and corrected by hand' });
    const audit = await ActivityLog.findOne({ action: 'Failed Operation Resolved', entityId: entry._id }).lean();
    expect(audit).toMatchObject({ protected: true, reason: 'Counted stock and corrected by hand', actionType: 'correct' });
  });

  test('refreshing stale customer stats recomputes derived totals only, and is audited', async () => {
    const c = await make.customer(org.admin);
    await make.invoice(org.admin, c, { lines: [{ amount: 250, rate: 0 }] });
    await Customer.collection.updateOne({ _id: c._id }, { $set: { outstandingBalance: 1 } });
    const res = await request(app).post('/api/reconciliation/resolve').set(auth(org.tokens.admin)).send({ action: 'refresh_customer_stats', id: String(c._id), note: 'month end' });
    expect(res.status).toBe(200);
    expect((await Customer.findById(c._id)).outstandingBalance).toBe(250);
    expect(await ActivityLog.countDocuments({ action: 'Customer Stats Refreshed (Reconciliation)', entityId: c._id })).toBe(1);
    expect((await request(app).post('/api/reconciliation/resolve').set(auth(org.tokens.admin)).send({ action: 'edit_invoice_balance', id: String(c._id) })).status).toBe(400);
  });
});
