/**
 * Counter jobs (walk-in jobs): taking a job, the production flow, operators,
 * quality check, billing through the invoices and payments APIs, the summary
 * figures, and isolation between businesses.
 */
const request = require('supertest');
const app = require('../src/app');
const WalkInJob = require('../src/models/WalkInJob');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let a;
let b;

beforeAll(async () => {
  await connectTestDb('counterjobs');
  await WalkInJob.init(); // build the unique jobNumber index before racing on it
  a = await createOrg('cja', { staffPermissions: ['Walk-In Jobs', 'Walk-In Jobs: View'] });
  b = await createOrg('cjb');
});
afterAll(disconnectTestDb);

const api = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  del: (url) => request(app).delete(url).set(auth(token))
});

const inAnHour = () => new Date(Date.now() + 3600e3).toISOString();

/** What the counter job editor sends. */
const jobBody = (extra = {}) => ({
  customerName: 'Anil Thomas',
  customerPhone: '+91 98470 12345',
  jobType: 'printing',
  description: 'Wedding invitation inserts',
  specifications: { quantity: 200, copies: 1, paperSize: 'A5', paperType: '300 GSM art card', colorMode: 'color', sides: 'double', finishing: ['lamination', 'cutting'] },
  timeline: { estimatedCompletion: inAnHour(), priority: 'high' },
  pricing: { estimatedCost: 1500, advancePaid: 500, advanceMethod: 'upi' },
  notes: 'Customer will wait',
  ...extra
});

const createJob = async (token = a.tokens.admin, extra) => {
  const res = await api(token).post('/api/walk-in-jobs', jobBody(extra));
  expect(res.status).toBe(201);
  return res.body.data.job;
};

describe('taking a counter job', () => {
  test('creates it in the queue with a number, the business and the creator', async () => {
    const job = await createJob();
    expect(job.jobNumber).toMatch(/^WI\d{6}-\d{3}$/);
    expect(job.status).toBe('waiting');
    expect(job.customerPhone).toBe('9847012345');
    expect(job.specifications).toMatchObject({ quantity: 200, sides: 'double', colorMode: 'color', finishing: ['lamination', 'cutting'] });
    expect(job.pricing).toMatchObject({ estimatedCost: 1500, advancePaid: 500, advanceMethod: 'upi' });
    expect(job.history).toHaveLength(1);

    const saved = await WalkInJob.findById(job._id).lean();
    expect(saved.dataScope).toBe(a.dataScope);
    expect(String(saved.userId)).toBe(String(a.admin._id));
  });

  test('numbers are unique, even for jobs taken at the same moment in different businesses', async () => {
    const jobs = await Promise.all([createJob(), createJob(b.tokens.admin), createJob(), createJob(b.tokens.admin)]);
    const numbers = jobs.map((j) => j.jobNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  test.each([
    ['no phone', { customerPhone: '' }, /mobile number/],
    ['a short phone', { customerPhone: '98470' }, /mobile number/],
    ['no name', { customerName: '  ' }, /name/i],
    ['no description', { description: '' }, /Describe/],
    ['an unknown job type', { jobType: 'origami' }, /job type/],
    ['zero quantity', { specifications: { quantity: 0 } }, /Quantity/],
    ['unknown finishing', { specifications: { quantity: 5, finishing: ['gold foil'] } }, /finishing/],
    ['no promised time', { timeline: { priority: 'low' } }, /promised/],
    ['an advance above the price', { pricing: { estimatedCost: 100, advancePaid: 200 } }, /Advance/],
    ['a negative price', { pricing: { estimatedCost: -5 } }, /Price/],
    ['a customer id from nowhere', { customerId: 'abc' }, /customer/]
  ])('rejects %s with 400', async (_label, extra, message) => {
    const res = await api(a.tokens.admin).post('/api/walk-in-jobs', jobBody(extra));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  test('links an existing customer only from the same business', async () => {
    const mine = await make.customer(a.admin, { name: 'Lakeside Cafe', phone: '9847000001' });
    const theirs = await make.customer(b.admin);
    const job = await createJob(a.tokens.admin, { customerId: String(mine._id), customerName: mine.name, customerPhone: mine.phone });
    expect(job.customerId).toBe(String(mine._id));

    const res = await api(a.tokens.admin).post('/api/walk-in-jobs', jobBody({ customerId: String(theirs._id) }));
    expect(res.status).toBe(400);
  });

  test('a login that can only view counter jobs cannot take one', async () => {
    const res = await api(a.tokens.staff1).post('/api/walk-in-jobs', jobBody());
    expect(res.status).toBe(403);
    const list = await api(a.tokens.staff1).get('/api/walk-in-jobs');
    expect(list.status).toBe(200);
  });
});

describe('the list', () => {
  test('shows the business\'s jobs, finds them by phone as typed, and filters by view', async () => {
    const job = await createJob(a.tokens.admin, { customerName: 'Fathima Rasheed', customerPhone: '9847011003' });

    const all = await api(a.tokens.admin).get('/api/walk-in-jobs?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.data.jobs.map((j) => j._id)).toContain(job._id);
    expect(all.body.data.pagination.totalJobs).toBe(all.body.data.jobs.length);

    const byPhone = await api(a.tokens.admin).get(`/api/walk-in-jobs?search=${encodeURIComponent('98470 11003')}`);
    expect(byPhone.body.data.jobs.map((j) => j._id)).toEqual([job._id]);

    const waiting = await api(a.tokens.admin).get('/api/walk-in-jobs?view=waiting&limit=100');
    expect(waiting.body.data.jobs.every((j) => j.status === 'waiting')).toBe(true);

    const bad = await api(a.tokens.admin).get('/api/walk-in-jobs?view=everything');
    expect(bad.status).toBe(400);
  });

  test('an overdue job is one whose promised time has passed while still in the queue', async () => {
    const late = await createJob(a.tokens.admin, { timeline: { estimatedCompletion: new Date(Date.now() - 600e3).toISOString() } });
    expect(late.isOverdue).toBe(true);
    const res = await api(a.tokens.admin).get('/api/walk-in-jobs?view=overdue&limit=100');
    expect(res.body.data.jobs.map((j) => j._id)).toContain(late._id);
  });
});

describe('moving a job through the counter', () => {
  let job;
  beforeAll(async () => {
    job = await createJob();
  });
  const status = (to, note) => api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/status`, { status: to, note });
  const qc = (body) => api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/quality-check`, body);

  test('waiting → in progress → quality check, recording when', async () => {
    const skip = await status('collected');
    expect(skip.status).toBe(400);
    expect(skip.body.message).toMatch(/can't be moved/);

    const started = await status('in_progress');
    expect(started.status).toBe(200);
    expect(started.body.data.job.timeline.startedAt).toBeTruthy();

    const again = await status('in_progress');
    expect(again.status).toBe(400);

    const checking = await status('quality_check');
    expect(checking.body.data.job.status).toBe('quality_check');
  });

  test('quality check: ready only through a recorded result; a fail needs a note and sends it back', async () => {
    expect((await status('ready')).status).toBe(400);
    expect((await qc({ passed: false })).status).toBe(400);
    expect((await qc({ passed: 'maybe' })).status).toBe(400);

    const failed = await qc({ passed: false, notes: 'Colours washed out' });
    expect(failed.status).toBe(200);
    expect(failed.body.data.job.status).toBe('in_progress');
    expect(failed.body.data.job.qualityCheck).toMatchObject({ checked: true, approved: false, notes: 'Colours washed out' });

    await status('quality_check');
    const passed = await qc({ passed: true, notes: 'Reprinted' });
    expect(passed.body.data.job.status).toBe('ready');
    expect(passed.body.data.job.qualityCheck.approved).toBe(true);
    expect(passed.body.data.job.timeline.readyAt).toBeTruthy();
    expect(passed.body.data.job.turnaroundMinutes).toBeGreaterThanOrEqual(0);
  });

  test('ready → collected, which can be undone but not cancelled', async () => {
    const collected = await status('collected');
    expect(collected.body.data.job.status).toBe('collected');
    expect(collected.body.data.job.timeline.collectedAt).toBeTruthy();
    expect((await status('cancelled')).status).toBe(400);
    expect((await status('ready')).body.data.job.timeline.collectedAt).toBeFalsy();
  });

  test('cancel with a reason, then reopen', async () => {
    const other = await createJob();
    const cancelled = await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/status`, { status: 'cancelled', note: 'Customer left' });
    expect(cancelled.body.data.job).toMatchObject({ status: 'cancelled', cancelReason: 'Customer left' });
    const reopened = await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/status`, { status: 'waiting' });
    expect(reopened.body.data.job.status).toBe('waiting');
    expect(reopened.body.data.job.cancelReason).toBeUndefined();
  });

  test('edit keeps the status and history; delete removes an unbilled job', async () => {
    const other = await createJob();
    const edited = await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}`, jobBody({ description: 'Visiting cards', specifications: { quantity: 100 } }));
    expect(edited.status).toBe(200);
    expect(edited.body.data.job).toMatchObject({ description: 'Visiting cards', status: 'waiting', jobNumber: other.jobNumber });
    expect(edited.body.data.job.specifications.finishing).toEqual([]);

    expect((await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}`, jobBody({ customerPhone: '12' }))).status).toBe(400);

    expect((await api(a.tokens.admin).del(`/api/walk-in-jobs/${other._id}`)).status).toBe(200);
    expect((await api(a.tokens.admin).get(`/api/walk-in-jobs/${other._id}`)).status).toBe(404);
  });
});

describe('operators', () => {
  test('lists active logins of the business only', async () => {
    const res = await api(a.tokens.admin).get('/api/walk-in-jobs/operators');
    expect(res.status).toBe(200);
    const ids = res.body.data.operators.map((o) => o._id);
    expect(ids).toEqual(expect.arrayContaining([String(a.staff1._id), String(a.manager._id)]));
    expect(ids).not.toContain(String(b.staff1._id));
  });

  test('assigns a login of the business, refuses one from another, and can unassign', async () => {
    const job = await createJob();
    const url = `/api/walk-in-jobs/${job._id}/assign`;
    const ok = await api(a.tokens.admin).put(url, { operatorId: String(a.staff2._id) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.job.assignedTo.operatorName).toBe(a.staff2.fullName);
    expect(ok.body.data.job.assignedTo.operator.fullName).toBe(a.staff2.fullName);

    const filtered = await api(a.tokens.admin).get(`/api/walk-in-jobs?operator=${a.staff2._id}`);
    expect(filtered.body.data.jobs.map((j) => j._id)).toEqual([job._id]);

    expect((await api(a.tokens.admin).put(url, { operatorId: String(b.staff1._id) })).status).toBe(400);
    expect((await api(a.tokens.admin).put(url, { operatorId: 'nobody' })).status).toBe(400);

    const cleared = await api(a.tokens.admin).put(url, { operatorId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.job.assignedTo?.operator).toBeFalsy();
  });
});

describe('billing a counter job', () => {
  let job;
  let customer;
  let invoice;

  beforeAll(async () => {
    job = await createJob();
    customer = await make.customer(a.admin, { name: 'Anil Thomas', phone: '9847012345' });
  });

  /** The invoice the billing dialog creates: one line, no GST (a stray rate is ignored). */
  const invoiceBody = (customerId) => ({
    customerId,
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date().toISOString().slice(0, 10),
    status: 'sent',
    paymentTerms: 'Due on receipt',
    items: [{ itemName: `Counter job ${job.jobNumber}`, description: 'A5 · 300 GSM', quantity: 200, unit: 'nos', unitPrice: 7.5, hsnCode: '998912', gstRate: 18, itemType: 'Numbers' }],
    discountAmount: 0,
    isInterState: false,
    noGst: false,
    notes: `Counter job ${job.jobNumber}`
  });

  test('a job can only be billed once it is ready', async () => {
    const res = await api(a.tokens.admin).post('/api/invoices', invoiceBody(String(customer._id)));
    expect(res.status).toBe(201);
    invoice = res.body.data.invoice;
    expect(invoice.totalAmount).toBe(1500);
    expect(invoice.totalGstAmount).toBe(0);
    expect(invoice.items[0].gstRate).toBe(0);

    const early = await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/invoice`, { invoiceId: invoice._id });
    expect(early.status).toBe(400);
  });

  test('links the invoice, and the payments settle it', async () => {
    await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/status`, { status: 'in_progress' });
    await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/status`, { status: 'ready' });

    const linked = await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/invoice`, { invoiceId: invoice._id });
    expect(linked.status).toBe(200);
    expect(linked.body.data.job.billing).toMatchObject({ invoiceNumber: invoice.invoiceNumber, amount: 1500 });
    expect(linked.body.data.job.customerId).toBe(String(customer._id));

    // The advance taken with the job, then the balance at the counter.
    const pay = (amount, paymentMethod) =>
      api(a.tokens.admin).post('/api/payments', { customerId: String(customer._id), invoiceId: invoice._id, amount, paymentMethod, referenceNumber: job.jobNumber });
    expect((await pay(500, 'upi')).status).toBe(201);
    expect((await pay(1000, 'cash')).status).toBe(201);

    const after = await api(a.tokens.admin).get(`/api/walk-in-jobs/${job._id}`);
    expect(after.body.data.job.billing.invoice).toMatchObject({ invoiceNumber: invoice.invoiceNumber, paymentStatus: 'paid', balanceAmount: 0 });

    const billedView = await api(a.tokens.admin).get(`/api/walk-in-jobs?search=${invoice.invoiceNumber}`);
    expect(billedView.body.data.jobs.map((j) => j._id)).toEqual([job._id]);
  });

  test('a billed job cannot be billed again, cancelled, deleted or repriced', async () => {
    const other = await createJob();
    await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/status`, { status: 'in_progress' });
    await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/status`, { status: 'ready' });
    expect((await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/invoice`, { invoiceId: invoice._id })).status).toBe(400);

    expect((await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}/status`, { status: 'cancelled' })).status).toBe(400);
    expect((await api(a.tokens.admin).del(`/api/walk-in-jobs/${job._id}`)).status).toBe(400);
    expect((await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}`, jobBody({ pricing: { estimatedCost: 99 } }))).status).toBe(400);
    expect((await api(a.tokens.admin).put(`/api/walk-in-jobs/${job._id}`, jobBody({ notes: 'Collected by brother' }))).status).toBe(200);
  });

  test('another business\'s invoice cannot be linked', async () => {
    const theirCustomer = await make.customer(b.admin);
    const theirInvoice = await make.invoice(b.admin, theirCustomer);
    const other = await createJob();
    await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/status`, { status: 'in_progress' });
    await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/status`, { status: 'ready' });
    const res = await api(a.tokens.admin).put(`/api/walk-in-jobs/${other._id}/invoice`, { invoiceId: String(theirInvoice._id) });
    expect(res.status).toBe(404);
  });

  test('the summary counts today\'s billing, the queue and the turnaround', async () => {
    const res = await api(a.tokens.admin).get('/api/walk-in-jobs/stats/summary');
    expect(res.status).toBe(200);
    const s = res.body.data.stats;
    expect(s.billedToday).toBe(1500);
    expect(s.billedTodayCount).toBe(1);
    expect(s.todayJobs).toBe(s.counts.all);
    expect(s.inQueue).toBe(s.counts.waiting + s.counts.in_progress + s.counts.quality_check);
    expect(s.readyForPickup).toBe(s.counts.ready);
    expect(s.overdue).toBeGreaterThanOrEqual(1);
    expect(s.unbilled).toBeGreaterThanOrEqual(1);
    expect(typeof s.avgTurnaroundMinutes).toBe('number');
    expect(s.turnaroundSample).toBeGreaterThanOrEqual(2);
  });
});

describe('isolation between businesses', () => {
  test('another business cannot see, change, move, assign, bill or delete a job', async () => {
    const job = await createJob();
    const them = api(b.tokens.admin);
    expect((await them.get(`/api/walk-in-jobs/${job._id}`)).status).toBe(404);
    expect((await them.put(`/api/walk-in-jobs/${job._id}`, jobBody())).status).toBe(404);
    expect((await them.put(`/api/walk-in-jobs/${job._id}/status`, { status: 'in_progress' })).status).toBe(404);
    expect((await them.put(`/api/walk-in-jobs/${job._id}/assign`, { operatorId: String(b.staff1._id) })).status).toBe(404);
    expect((await them.put(`/api/walk-in-jobs/${job._id}/quality-check`, { passed: true })).status).toBe(404);
    expect((await them.del(`/api/walk-in-jobs/${job._id}`)).status).toBe(404);

    const list = await them.get('/api/walk-in-jobs?limit=100');
    expect(list.body.data.jobs.map((j) => j._id)).not.toContain(job._id);
    expect(list.body.data.jobs.every((j) => !j.jobNumber || j.customerName)).toBe(true);

    const stats = (await them.get('/api/walk-in-jobs/stats/summary')).body.data.stats;
    expect(stats.counts.all).toBe(list.body.data.pagination.totalJobs);
    expect(stats.billedToday).toBe(0);

    const still = await WalkInJob.findById(job._id).lean();
    expect(still.status).toBe('waiting');
  });

  test('a malformed id is simply not found', async () => {
    expect((await api(a.tokens.admin).get('/api/walk-in-jobs/not-an-id')).status).toBe(404);
  });
});
