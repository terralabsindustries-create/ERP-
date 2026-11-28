const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { run, load, isLocalUri } = require('../migrations/runner');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let dbName;
const hist = () => mongoose.connection.db.collection('_migrations');
const go = (command, extra = {}) => run({ mongoose, connection: mongoose.connection, command, log: () => {}, ...extra });

beforeAll(async () => { dbName = await connectTestDb('migrations'); });
afterAll(disconnectTestDb);

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.js`), body);
  return dir;
}
const mig = (id, up, extra = '') => `exports.id='${id}'; exports.description='${id}'; exports.up=${up}; ${extra}`;

describe('runner', () => {
  test('runs pending migrations in id order, records history, and is idempotent', async () => {
    const dir = fixtureDir({
      '002-second': mig('002-second', `async (ctx) => { await ctx.db.collection('t').insertOne({ n: 2 }); ctx.count('t.inserted', 1); }`),
      '001-first': mig('001-first', `async (ctx) => { await ctx.db.collection('t').insertOne({ n: 1 }); }`)
    });
    expect((await go('status', { dir })).migrations.map((m) => [m.id, m.state])).toEqual([['001-first', 'pending'], ['002-second', 'pending']]);
    const first = await go('up', { dir });
    expect(first.migrations.map((m) => m.status)).toEqual(['applied', 'applied']);
    expect((await mongoose.connection.db.collection('t').find().sort({ n: 1 }).toArray()).map((r) => r.n)).toEqual([1, 2]);
    const row = await hist().findOne({ _id: '002-second' });
    expect(row).toMatchObject({ status: 'applied', version: 2, counts: { 't.inserted': 1 }, reversible: false });
    expect(row.checksum).toHaveLength(16);
    const again = await go('up', { dir });
    expect(again.migrations).toEqual([]); // nothing re-run
    expect(await mongoose.connection.db.collection('t').countDocuments()).toBe(2);
  });

  test('plan (dry run) counts what would change, writes nothing and records no history', async () => {
    await mongoose.connection.db.collection('dry').insertMany([{ a: 1 }, { a: 1 }, { a: 2 }]);
    const dir = fixtureDir({ '001-dry': mig('001-dry', `async (ctx) => { await ctx.updateMany('dry', { a: 1 }, { $set: { done: true } }); }`) });
    const plan = await go('plan', { dir });
    expect(plan.migrations[0]).toMatchObject({ status: 'would_apply', counts: { 'dry.wouldUpdate': 2 } });
    expect(await mongoose.connection.db.collection('dry').countDocuments({ done: true })).toBe(0);
    expect(await hist().countDocuments({ _id: '001-dry' })).toBe(0);
  });

  test('a failing migration is recorded as failed, stops the run, and is retried next time', async () => {
    const dir = fixtureDir({
      '001-ok': mig('001-ok', `async () => {}`),
      '002-bad': mig('002-bad', `async () => { throw new Error('data is wrong'); }`),
      '003-never': mig('003-never', `async () => {}`)
    });
    await expect(go('up', { dir })).rejects.toThrow('data is wrong');
    expect(await hist().findOne({ _id: '002-bad' })).toMatchObject({ status: 'failed', error: 'data is wrong' });
    expect(await hist().findOne({ _id: '003-never' })).toBeNull();
    expect(await hist().findOne({ _id: '001-ok' })).toMatchObject({ status: 'applied' });
    expect((await go('status', { dir })).migrations.map((m) => m.state)).toEqual(['applied', 'failed', 'pending']);
  });

  test('a failed validation marks the migration failed', async () => {
    const dir = fixtureDir({ '001-invalid': mig('001-invalid', `async () => {}`, `exports.validate = async () => ['3 rows still wrong'];`) });
    await expect(go('up', { dir })).rejects.toThrow('Validation failed: 3 rows still wrong');
    expect(await hist().findOne({ _id: '001-invalid' })).toMatchObject({ status: 'failed' });
  });

  test('a held lock blocks a second runner; an expired one does not', async () => {
    const dir = fixtureDir({ '001-lock': mig('001-lock', `async () => {}`) });
    await mongoose.connection.db.collection('_migration_lock').insertOne({ _id: 'lock', owner: 'someone-else', expiresAt: new Date(Date.now() + 60000) });
    await expect(go('up', { dir })).rejects.toThrow(/lock/);
    await mongoose.connection.db.collection('_migration_lock').updateOne({ _id: 'lock' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await go('up', { dir })).migrations[0].status).toBe('applied');
    expect(await mongoose.connection.db.collection('_migration_lock').countDocuments()).toBe(0); // released
  });

  test('down rolls back a reversible migration and refuses an irreversible one with its recovery note', async () => {
    const dir = fixtureDir({
      '001-rev': mig('001-rev', `async (ctx) => { await ctx.db.collection('rev').insertOne({ x: 1 }); }`, `exports.down = async (ctx) => { await ctx.db.collection('rev').deleteMany({}); };`),
      '002-irrev': mig('002-irrev', `async () => {}`, `exports.recovery = 'restore the nightly backup';`)
    });
    await go('up', { dir });
    await go('down', { dir, target: '001-rev' });
    expect(await mongoose.connection.db.collection('rev').countDocuments()).toBe(0);
    expect(await hist().findOne({ _id: '001-rev' })).toMatchObject({ status: 'rolled_back' });
    await expect(go('down', { dir, target: '002-irrev' })).rejects.toThrow(/irreversible.*restore the nightly backup/);
  });

  test('refuses a non-local database unless explicitly allowed, and needs a URI', async () => {
    expect(isLocalUri('mongodb://127.0.0.1:27017/x')).toBe(true);
    expect(isLocalUri('mongodb://localhost/x')).toBe(true);
    expect(isLocalUri('mongodb+srv://u:p@cluster0.abcde.mongodb.net/prod')).toBe(false);
    await expect(run({ mongoose, uri: 'mongodb+srv://u:p@cluster0.abcde.mongodb.net/prod', command: 'up', log: () => {} })).rejects.toThrow(/non-local/);
    await expect(run({ mongoose, command: 'up', log: () => {} })).rejects.toThrow(/URI is required/);
  });

  test('the shipped migrations load with unique ordered ids matching their files', () => {
    const ids = load().map((m) => m.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(['001-add-datascope', '002-performance-and-lifecycle-indexes', '003-recompute-customer-financials']));
  });
});

describe('shipped migrations on an isolated database', () => {
  test('001 backfills dataScope from the owning user and leaves orphans untouched; 003 corrects revenue and rolls back', async () => {
    const org = await createOrg('migr');
    const cust = await make.customer(org.admin);
    await make.job(org.admin, cust, { estimatedCost: 9000 });
    await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 0 }] });
    const customers = mongoose.connection.db.collection('customers');
    // legacy state: no dataScope, revenue = job estimate
    await customers.updateOne({ _id: cust._id }, { $unset: { dataScope: '' }, $set: { totalRevenue: 9000, outstandingBalance: 0 } });
    await mongoose.connection.db.collection('invoices').updateMany({ customerId: cust._id }, { $unset: { dataScope: '' } });
    const orphan = await customers.insertOne({ name: 'Orphan', userId: new mongoose.Types.ObjectId() });

    const plan = await go('plan', { target: '001-add-datascope' });
    expect(plan.migrations[0].counts['customers.wouldUpdate']).toBe(1);
    expect((await customers.findOne({ _id: cust._id })).dataScope).toBeUndefined();

    await go('up', { target: '003-recompute-customer-financials' });
    const fixed = await customers.findOne({ _id: cust._id });
    expect(fixed).toMatchObject({ dataScope: org.dataScope, totalRevenue: 1000, outstandingBalance: 1000, estimatedJobValue: 9000 });
    expect((await customers.findOne({ _id: orphan.insertedId })).dataScope).toBeUndefined();
    expect(await hist().findOne({ _id: '003-recompute-customer-financials' })).toMatchObject({ status: 'applied', reversible: true });

    await go('down', { target: '003-recompute-customer-financials' });
    const restored = await customers.findOne({ _id: cust._id });
    expect(restored).toMatchObject({ totalRevenue: 9000, outstandingBalance: 0 });
    expect(restored.estimatedJobValue).toBe(0); // the value before the migration (schema default)
  });
});
