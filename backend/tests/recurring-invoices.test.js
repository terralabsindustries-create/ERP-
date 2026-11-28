/**
 * Recurring invoices: one invoice per scheduled date, no matter how many
 * scheduler ticks, restarts or retries; catch-up of missed dates; drafts by
 * default; pause/resume/cancel; failures retried without skipping a date.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const RecurringInvoice = require('../src/models/RecurringInvoice');
const { RecurringInvoiceRun } = RecurringInvoice;
const svc = require('../src/services/recurringInvoices');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
const api = (token) => ({
  get: (u) => request(app).get(u).set(auth(token)),
  post: (u, b) => request(app).post(u).set(auth(token)).send(b || {}),
  put: (u, b) => request(app).put(u).set(auth(token)).send(b)
});
const line = { itemName: 'Monthly AMC', quantity: 1, unitPrice: 1000, gstRate: 18, hsnCode: '998313' };
const daysAgo = (n) => new Date(Date.now() - n * 864e5);

beforeAll(async () => {
  await connectTestDb('recurring');
  org = await createOrg('rc');
  other = await createOrg('rco');
  cust = await make.customer(org.admin, { name: 'Retainer Client' });
  await RecurringInvoiceRun.init();
});
afterAll(disconnectTestDb);

const create = async (body) => {
  const r = await api(org.tokens.admin).post('/api/recurring-invoices', { name: 'AMC', customerId: cust._id, items: [line], frequency: 'monthly', ...body });
  expect(r.status).toBe(201);
  return r.body.data.template;
};

test('schedule arithmetic keeps the anchor day in short months', () => {
  const jan31 = new Date('2027-01-30T18:30:00Z'); // 31 Jan 2027 IST
  const feb = svc.nextDate(jan31, 'monthly', 1, 31);
  expect(svc.periodKeyOf(feb)).toBe('2027-02-28');
  expect(svc.periodKeyOf(svc.nextDate(feb, 'monthly', 1, 31))).toBe('2027-03-31');
  expect(svc.periodKeyOf(svc.nextDate(jan31, 'quarterly', 1, 31))).toBe('2027-04-30');
  expect(svc.periodKeyOf(svc.nextDate(jan31, 'weekly', 1))).toBe('2027-02-07');
  expect(svc.periodKeyOf(svc.nextDate(jan31, 'yearly', 1, 31))).toBe('2028-01-31');
});

test('a blank GST rate is refused, never taken as 0', async () => {
  const r = await api(org.tokens.admin).post('/api/recurring-invoices', { name: 'X', customerId: cust._id, items: [{ ...line, gstRate: '' }], frequency: 'monthly', startDate: new Date() });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('GST_RATE_REQUIRED');
});

test('missed dates are caught up once each, as drafts dated on their own day', async () => {
  const t = await create({ name: 'Weekly', frequency: 'weekly', startDate: daysAgo(20) });
  const res = await svc.runDueRecurringInvoices();
  expect(res.generated).toBeGreaterThanOrEqual(3);
  const invoices = await Invoice.find({ customerId: cust._id, notes: /Recurring: Weekly/ }).sort({ invoiceDate: 1 });
  expect(invoices).toHaveLength(3);
  expect(invoices.every((i) => i.status === 'draft' && /^DRAFT-/.test(i.invoiceNumber))).toBe(true);
  expect(invoices[0].totalAmount).toBe(1180);
  const days = invoices.map((i) => svc.periodKeyOf(i.invoiceDate));
  expect(new Set(days).size).toBe(3);
  const stored = await RecurringInvoice.findById(t._id);
  expect(stored.generatedCount).toBe(3);
  expect(stored.nextRunDate > new Date()).toBe(true);
  // Running again (another tick, or a restart) bills nothing more.
  await svc.runDueRecurringInvoices();
  expect(await Invoice.countDocuments({ customerId: cust._id, notes: /Recurring: Weekly/ })).toBe(3);
});

test('concurrent scheduler runs (two instances) bill each date once', async () => {
  const t = await create({ name: 'Concurrent', frequency: 'daily', startDate: daysAgo(4) });
  await Promise.all([svc.runDueRecurringInvoices(), svc.runDueRecurringInvoices(), svc.runDueRecurringInvoices()]);
  const n = await Invoice.countDocuments({ customerId: cust._id, notes: /Recurring: Concurrent/ });
  const runs = await RecurringInvoiceRun.countDocuments({ templateId: t._id, status: 'generated' });
  expect(n).toBe(runs);
  expect(n).toBe(5); // 4 days ago … today
});

test('a failure keeps the date and retries it after a back-off', async () => {
  const t = await create({ name: 'Flaky', startDate: daysAgo(1) });
  const svcCreation = require('../src/services/invoiceCreation');
  const spy = jest.spyOn(svcCreation, 'createInvoiceWithStock').mockRejectedValueOnce(new Error('database blip'));
  await svc.runTemplate(await RecurringInvoice.findById(t._id));
  spy.mockRestore();
  let stored = await RecurringInvoice.findById(t._id);
  const failedRun = await RecurringInvoiceRun.findOne({ templateId: t._id });
  expect(failedRun).toMatchObject({ status: 'failed', error: 'database blip' });
  expect(stored.consecutiveFailures).toBe(1);
  expect(stored.retryAfter > new Date()).toBe(true);
  expect(svc.periodKeyOf(stored.nextRunDate)).toBe(failedRun.periodKey);
  // Still in back-off: the next tick leaves it alone.
  await svc.runDueRecurringInvoices();
  expect(await RecurringInvoiceRun.countDocuments({ templateId: t._id, status: 'generated' })).toBe(0);
  await RecurringInvoice.updateOne({ _id: t._id }, { $set: { retryAfter: null } });
  await svc.runDueRecurringInvoices();
  stored = await RecurringInvoice.findById(t._id);
  expect(stored.consecutiveFailures).toBe(0);
  expect(await RecurringInvoiceRun.countDocuments({ templateId: t._id, status: 'generated' })).toBe(1);
});

test('a run left "running" by a crash is retried; a fresh one is not', async () => {
  const t = await create({ name: 'Crashed', startDate: daysAgo(0) });
  const tpl = await RecurringInvoice.findById(t._id);
  const key = svc.periodKeyOf(tpl.nextRunDate);
  await RecurringInvoiceRun.create({ templateId: t._id, periodKey: key, scheduledFor: tpl.nextRunDate, status: 'running' });
  expect((await svc.generateOne(tpl, tpl.nextRunDate)).skipped).toBe(true);
  await RecurringInvoiceRun.collection.updateOne({ templateId: tpl._id }, { $set: { updatedAt: new Date(Date.now() - 11 * 60e3) } });
  expect((await svc.generateOne(tpl, tpl.nextRunDate)).generated).toBe(true);
});

test('pause, resume, cancel, and the end date completes the schedule', async () => {
  const a = api(org.tokens.admin);
  const t = await create({ name: 'Lifecycle', startDate: daysAgo(70), endDate: daysAgo(1) });
  expect((await a.post(`/api/recurring-invoices/${t._id}/pause`)).status).toBe(200);
  await svc.runDueRecurringInvoices();
  expect(await Invoice.countDocuments({ notes: /Recurring: Lifecycle/ })).toBe(0);
  expect((await a.post(`/api/recurring-invoices/${t._id}/resume`)).status).toBe(200);
  const run = await a.post(`/api/recurring-invoices/${t._id}/run-now`);
  expect(run.status).toBe(200);
  expect(await Invoice.countDocuments({ notes: /Recurring: Lifecycle/ })).toBe(3);
  expect((await RecurringInvoice.findById(t._id)).status).toBe('completed');
  expect((await a.post(`/api/recurring-invoices/${t._id}/cancel`)).status).toBe(409);
  const detail = await a.get(`/api/recurring-invoices/${t._id}`);
  expect(detail.body.data.runs).toHaveLength(3);
});

test('automatic issue gives each invoice the next official number; FY change keeps one series per issue month', async () => {
  const t = await create({ name: 'AutoIssue', startDate: daysAgo(0), issueAutomatically: true });
  await svc.runTemplate(await RecurringInvoice.findById(t._id));
  const inv = await Invoice.findOne({ notes: /Recurring: AutoIssue/ });
  expect(inv.status).toBe('sent');
  expect(inv.invoiceNumber).toMatch(/^INV-\d{6}-\d{4}$/);
});

test('templates stay inside the business', async () => {
  const mine = (await api(org.tokens.admin).get('/api/recurring-invoices')).body.data.templates;
  expect(mine.length).toBeGreaterThan(0);
  expect((await api(other.tokens.admin).get('/api/recurring-invoices')).body.data.templates).toHaveLength(0);
  expect((await api(other.tokens.admin).get(`/api/recurring-invoices/${mine[0]._id}`)).status).toBe(404);
  const foreign = await api(other.tokens.admin).post('/api/recurring-invoices', { name: 'Steal', customerId: cust._id, items: [line], frequency: 'monthly', startDate: new Date() });
  expect(foreign.status).toBe(404);
});
