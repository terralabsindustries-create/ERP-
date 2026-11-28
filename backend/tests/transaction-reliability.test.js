/**
 * Fault injection for multi-step writes without database transactions
 * (MONGODB_TRANSACTIONS=off forces the step-by-step path): failures at every
 * stage, failed undo steps, interrupted operations, duplicate submissions and
 * concurrency. A failed undo must be durable, alerting and never reported as success.
 */
process.env.MONGODB_TRANSACTIONS = 'off';
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Inventory = require('../src/models/Inventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const TransactionJournal = require('../src/models/TransactionJournal');
const IdempotencyRecord = require('../src/models/IdempotencyRecord');
const { inTransaction, compensation } = require('../src/utils/transactions');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
const post = (url, body, headers = {}) => request(app).post(url).set(auth(org.tokens.admin)).set(headers).send(body);
const line = (itemName, quantity) => ({ itemName, quantity, unitPrice: 10, gstRate: 18 });
const qty = async (item) => (await Inventory.findById(item._id)).quantity;

beforeAll(async () => {
  await connectTestDb('txn_reliability');
  await TransactionJournal.init(); await IdempotencyRecord.init();
  org = await createOrg('txn_reliability');
  other = await createOrg('txn_reliability_other');
  cust = await make.customer(org.admin);
});
afterAll(disconnectTestDb);
afterEach(() => jest.restoreAllMocks());

describe('inTransaction without database transactions', () => {
  test('journals the run and removes the entry when it completes', async () => {
    let during;
    const result = await inTransaction(async () => { during = await TransactionJournal.countDocuments({ label: 'happy' }); return 'ok'; }, { label: 'happy' });
    expect(result).toBe('ok');
    expect(during).toBe(1);
    expect(await TransactionJournal.countDocuments({ label: 'happy' })).toBe(0);
  });

  test('failure at each stage undoes the earlier steps newest first and leaves no failure record', async () => {
    for (const failAt of [1, 2, 3]) {
      const done = [];
      const undone = [];
      await expect(inTransaction(async ({ onUndo }) => {
        for (let step = 1; step <= 3; step += 1) {
          if (step === failAt) throw new Error(`boom at ${step}`);
          done.push(step);
          onUndo(async () => { undone.push(step); });
        }
      }, { label: `stage-${failAt}` })).rejects.toThrow(`boom at ${failAt}`);
      expect(undone).toEqual([...done].reverse());
      expect(await TransactionJournal.countDocuments({ label: `stage-${failAt}` })).toBe(0);
    }
  });

  test('a failed undo step is recorded, alerted, flagged on the error, and the other steps still run', async () => {
    const alerts = jest.spyOn(console, 'error').mockImplementation(() => {});
    const undone = [];
    let caught;
    try {
      await inTransaction(async ({ onUndo }) => {
        onUndo(async () => { undone.push('first'); });
        onUndo(async () => { throw new Error('cannot put stock back'); });
        onUndo(async () => { undone.push('third'); });
        throw new Error('write failed');
      }, { label: 'Stock deduction' });
    } catch (error) { caught = error; }
    expect(caught.message).toBe('write failed');
    expect(caught.compensationFailed).toBe(true);
    expect(undone).toEqual(['third', 'first']);
    const record = await TransactionJournal.findById(caught.failureId).lean();
    expect(record).toMatchObject({ label: 'Stock deduction', status: 'compensation_failed', originalError: 'write failed' });
    expect(record.undoErrors).toMatchObject([{ step: 2, message: 'cannot put stock back' }]);
    expect(alerts.mock.calls.some(([line]) => String(line).includes('"evt":"compensation_failed"'))).toBe(true);
  });

  test('a run that never finishes (process killed) stays as a started entry for reconciliation', async () => {
    const entry = await compensation.openJournal('Interrupted payment');
    // no closeJournal: the process "died" here
    expect(await TransactionJournal.findById(entry._id)).toMatchObject({ status: 'started', label: 'Interrupted payment' });
  });
});

describe('invoice creation with stock under fault injection', () => {
  test('movement write fails, undo succeeds: no invoice, stock restored, no failure record', async () => {
    const item = await make.stockItem(org.admin, { name: 'Fault sheets', quantity: 10, unit: 'sheets' });
    jest.spyOn(InventoryMovement, 'insertMany').mockRejectedValueOnce(new Error('disk full'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const before = await Invoice.countDocuments({ dataScope: org.dataScope });
    const res = await post('/api/invoices', { customerId: String(cust._id), items: [line('Fault sheets', 3)] });
    expect(res.status).toBe(500);
    expect(await qty(item)).toBe(10);
    expect(await Invoice.countDocuments({ dataScope: org.dataScope })).toBe(before);
    expect(await TransactionJournal.countDocuments({ dataScope: org.dataScope, status: 'compensation_failed' })).toBe(0);
    expect(await TransactionJournal.countDocuments({ dataScope: org.dataScope, status: 'started' })).toBe(0);
  });

  test('movement write fails AND the invoice cannot be removed: a durable critical record names the problem', async () => {
    const item = await make.stockItem(org.admin, { name: 'Fault sheets 2', quantity: 10, unit: 'sheets' });
    jest.spyOn(InventoryMovement, 'insertMany').mockRejectedValueOnce(new Error('disk full'));
    jest.spyOn(Invoice, 'deleteOne').mockRejectedValueOnce(new Error('connection reset'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/api/invoices', { customerId: String(cust._id), items: [line('Fault sheets 2', 4)] });
    expect(res.status).toBe(500);
    const records = await TransactionJournal.find({ dataScope: org.dataScope, status: 'compensation_failed', label: 'Invoice creation' }).lean();
    expect(records).toHaveLength(1);
    expect(records[0].undoErrors.map((e) => e.step)).toEqual([2]);
    expect(await qty(item)).toBe(10); // the stock itself was still put back
    expect(log.mock.calls.some(([line]) => String(line).includes('compensation_failed'))).toBe(true);
    // The reconciliation report surfaces it as critical.
    const rec = await request(app).get('/api/reconciliation?checks=operations').set(auth(org.tokens.admin));
    expect(rec.body.data.checks.operations.findings[0]).toMatchObject({ code: 'COMPENSATION_FAILED', severity: 'critical' });
  });

  test('stock cannot be put back: recorded, not silently treated as success', async () => {
    const item = await make.stockItem(org.admin, { name: 'Fault sheets 3', quantity: 10, unit: 'sheets' });
    jest.spyOn(InventoryMovement, 'insertMany').mockRejectedValueOnce(new Error('disk full'));
    const InventoryService = require('../src/services/InventoryService');
    jest.spyOn(InventoryService, 'returnStock').mockResolvedValueOnce([`4 sheets of "${item.name}" (${item._id}): item not found`]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/api/invoices', { customerId: String(cust._id), items: [line('Fault sheets 3', 4)] });
    expect(res.status).toBe(500);
    const record = await TransactionJournal.findOne({ dataScope: org.dataScope, status: 'compensation_failed', 'undoErrors.step': 3 }).lean();
    expect(record).toBeTruthy();
    expect(record.undoErrors[0].message).toMatch(/item not found/);
  });
});

describe('idempotency keys', () => {
  test('the same key creates one invoice and takes stock once; the retry replays the answer', async () => {
    const item = await make.stockItem(org.admin, { name: 'Idem sheets', quantity: 10, unit: 'sheets' });
    const body = { customerId: String(cust._id), items: [line('Idem sheets', 2)] };
    const key = 'idem-key-0001';
    const first = await post('/api/invoices', body, { 'Idempotency-Key': key });
    const second = await post('/api/invoices', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.invoice._id).toBe(first.body.data.invoice._id);
    expect(await qty(item)).toBe(8);
    expect(await Invoice.countDocuments({ dataScope: org.dataScope, 'items.itemName': 'Idem sheets' })).toBe(1);
  });

  test('simultaneous duplicates run once', async () => {
    const item = await make.stockItem(org.admin, { name: 'Idem race', quantity: 10, unit: 'sheets' });
    const body = { customerId: String(cust._id), items: [line('Idem race', 1)] };
    const results = await Promise.all(Array.from({ length: 6 }, () => post('/api/invoices', body, { 'Idempotency-Key': 'idem-race-0001' })));
    const created = results.filter((r) => r.status === 201 && !r.headers['idempotent-replay']);
    expect(created).toHaveLength(1);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(await qty(item)).toBe(9);
  });

  test('the key with a different request is refused; a failed attempt releases the key; keys are per business', async () => {
    const key = 'idem-key-0002';
    await post('/api/invoices', { customerId: String(cust._id), items: [line('Plain', 1)] }, { 'Idempotency-Key': key });
    const different = await post('/api/invoices', { customerId: String(cust._id), items: [line('Plain', 7)] }, { 'Idempotency-Key': key });
    expect(different.status).toBe(422);

    const bad = await post('/api/invoices', { customerId: 'nope', items: [] }, { 'Idempotency-Key': 'idem-key-0003' });
    expect(bad.status).toBe(400);
    expect(await IdempotencyRecord.countDocuments({ key: 'idem-key-0003' })).toBe(0);

    const foreignCust = await make.customer(other.admin);
    const foreign = await request(app).post('/api/invoices').set(auth(other.tokens.admin)).set({ 'Idempotency-Key': key })
      .send({ customerId: String(foreignCust._id), items: [line('Plain', 7)] });
    expect(foreign.status).toBe(201);
  });

  test('a malformed key is rejected', async () => {
    const res = await post('/api/invoices', {}, { 'Idempotency-Key': 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  test('stock adjustment with the same key applies once', async () => {
    const item = await make.stockItem(org.admin, { name: 'Adj once', quantity: 10, unit: 'sheets' });
    const send = () => post(`/api/inventory/${item._id}/adjust`, { change: 5, type: 'purchase' }, { 'Idempotency-Key': 'adjust-key-01' });
    const [a, b] = [await send(), await send()];
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await qty(item)).toBe(15);
  });
});
