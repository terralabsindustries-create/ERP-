/**
 * A job ticket's billing as the Job Tickets screen reads it (GET /api/jobs):
 *
 *  - a job is billed once a non-cancelled invoice carries its id, with that
 *    invoice's number, amount and payment state on the job;
 *  - only the job the invoice was raised against is billed, not the
 *    customer's other jobs;
 *  - a cancelled invoice leaves the job unbilled again;
 *  - an already billed job is not billed again by accident (409), but can be
 *    billed in parts when the client asks for it;
 *  - editing an invoice without sending its job keeps the link;
 *  - all of it stays inside one business;
 *  - the reconciliation script finds unlinked invoices and links only
 *    unambiguous ones.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Job = require('../src/models/Job');
const Quotation = require('../src/models/Quotation');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const reconcile = require('../scripts/reconcile-job-invoices');

let a; // business A
let b; // business B
let cust; // A's customer with several jobs
let custB;

const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(token)).send(body || {})
});
const adminA = () => as(a.tokens.admin);
const adminB = () => as(b.tokens.admin);

const vinyl = [{ itemName: 'Vinyl sticker', quantity: 1, unitPrice: 162.08, gstRate: 18 }];
const raise = (job, extra = {}) => adminA().post('/api/invoices', {
  customerId: String(cust._id),
  jobId: String(job._id),
  items: vinyl,
  status: 'sent',
  ...extra
});
const jobRow = async (api, job) => (await api.get('/api/jobs?limit=500')).body.data.jobs.find((j) => j._id === String(job._id));

beforeAll(async () => {
  await connectTestDb('job_billing');
  await Invoice.init();
  a = await createOrg('jba', { staffPermissions: ['Dashboard', 'Invoicing'] });
  b = await createOrg('jbb');
  cust = await make.customer(a.admin, { name: 'auto engineers' });
  custB = await make.customer(b.admin, { name: 'auto engineers' });
});
afterAll(disconnectTestDb);

describe('the job ticket shows the invoice raised against it', () => {
  let job;
  let sibling;
  let invoice;

  beforeAll(async () => {
    job = await make.job(a.admin, cust, { title: 'vinyl', items: [{ itemName: 'Vinyl sticker', quantity: 1, unitPrice: 162.08, gstRate: 18, itemTotal: 191.25 }] });
    sibling = await make.job(a.admin, cust, { title: 'flex banner' });
  });

  test('before an invoice the job is unbilled', async () => {
    const row = await jobRow(adminA(), job);
    expect(row.invoices).toEqual([]);
  });

  test('after the invoice the job carries its number, amount and payment state — after a fresh load too', async () => {
    const res = await raise(job);
    expect(res.status).toBe(201);
    invoice = res.body.data.invoice;
    expect(invoice.totalAmount).toBe(191.25);

    const row = await jobRow(adminA(), job);
    expect(row.invoices).toHaveLength(1);
    expect(row.invoices[0]).toMatchObject({
      _id: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: 191.25,
      status: 'sent',
      paymentStatus: 'pending',
      balanceAmount: 191.25
    });
    // Billing doesn't move the job through production.
    expect((await Job.findById(job._id)).status).toBe('design_in_progress');
  });

  test("the customer's other job stays unbilled", async () => {
    expect((await jobRow(adminA(), sibling)).invoices).toEqual([]);
    const pending = (await adminA().get('/api/invoices/pending-jobs?limit=100')).body.data.jobs.map((j) => j._id);
    expect(pending).toContain(String(sibling._id));
    expect(pending).not.toContain(String(job._id));
  });

  test('partial and full payment show on the job', async () => {
    const part = await adminA().post('/api/payments', { customerId: String(cust._id), invoiceId: invoice._id, amount: 100, paymentMethod: 'cash' });
    expect(part.status).toBe(201);
    let row = await jobRow(adminA(), job);
    expect(row.invoices[0]).toMatchObject({ paymentStatus: 'partial', paidAmount: 100, balanceAmount: 91.25 });

    const rest = await adminA().post('/api/payments', { customerId: String(cust._id), invoiceId: invoice._id, amount: 91.25, paymentMethod: 'upi' });
    expect(rest.status).toBe(201);
    row = await jobRow(adminA(), job);
    expect(row.invoices[0]).toMatchObject({ status: 'paid', paymentStatus: 'paid', paidAmount: 191.25, balanceAmount: 0 });
    // Still not a production change.
    expect((await Job.findById(job._id)).status).toBe('design_in_progress');
  });

  test('a second invoice for the billed job is refused unless asked for', async () => {
    const again = await raise(job);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('JOB_ALREADY_INVOICED');
    expect(again.body.details).toMatchObject({ invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber });
    expect(await Invoice.countDocuments({ jobId: job._id })).toBe(1);

    const part = await raise(job, { allowAdditionalInvoice: true });
    expect(part.status).toBe(201);
    const row = await jobRow(adminA(), job);
    expect(row.invoices.map((i) => i.invoiceNumber).sort()).toEqual([invoice.invoiceNumber, part.body.data.invoice.invoiceNumber].sort());
  });

  test('editing an invoice without its job keeps the link; clearing it is explicit', async () => {
    const id = invoice._id;
    expect((await adminA().put(`/api/invoices/${id}`, { notes: 'Delivered' })).status).toBe(200);
    expect(String((await Invoice.findById(id)).jobId)).toBe(String(job._id));
  });
});

describe('cancelled invoices', () => {
  test('a cancelled invoice leaves the job unbilled, and it can be billed again', async () => {
    const job = await make.job(a.admin, cust, { title: 'letterheads' });
    const first = await raise(job);
    expect(first.status).toBe(201);
    expect((await adminA().patch(`/api/invoices/${first.body.data.invoice._id}/cancel`, { reason: 'Wrong rate' })).status).toBe(200);

    expect((await jobRow(adminA(), job)).invoices).toEqual([]);
    const second = await raise(job);
    expect(second.status).toBe(201);
    const row = await jobRow(adminA(), job);
    expect(row.invoices.map((i) => i._id)).toEqual([second.body.data.invoice._id]);
  });
});

describe('one business at a time', () => {
  test("another business can't bill, see or block a job ticket", async () => {
    const job = await make.job(a.admin, cust, { title: 'shop board' });
    expect((await adminB().post('/api/invoices', { customerId: String(custB._id), jobId: String(job._id), items: vinyl })).status).toBe(404);
    expect(await jobRow(adminB(), job)).toBeUndefined();

    // B's own invoices don't make A's job billed, and A can still bill it.
    const jobB = await make.job(b.admin, custB, { title: 'shop board' });
    expect((await adminB().post('/api/invoices', { customerId: String(custB._id), jobId: String(jobB._id), items: vinyl })).status).toBe(201);
    expect((await jobRow(adminA(), job)).invoices).toEqual([]);
    expect((await raise(job)).status).toBe(201);
  });
});

describe('reconciling existing records', () => {
  const models = { Invoice, Job, Quotation };

  test('an invoice raised without its job is found and linked only when the match is unambiguous', async () => {
    const org = await createOrg('jbr');
    const c = await make.customer(org.admin, { name: 'auto engineers' });
    const other = await make.customer(org.admin, { name: 'auto engineers' }); // same name, another customer
    const items = [{ itemName: 'Vinyl sticker', quantity: 2, unitPrice: 80, gstRate: 18, itemTotal: 188.8 }];
    const target = await make.job(org.admin, c, { title: 'vinyl', items });
    const unrelated = await make.job(org.admin, c, { title: 'visiting cards', items: [{ itemName: 'Cards', quantity: 500, unitPrice: 1, gstRate: 18, itemTotal: 590 }] });
    const sameNameJob = await make.job(org.admin, other, { title: 'vinyl', items });

    const invLines = [{ itemName: 'Vinyl sticker', quantity: 2, unitPrice: 80, totalAmount: 160, itemTotal: 188.8, gstRate: 18, gstAmount: 28.8, cgstAmount: 14.4, sgstAmount: 14.4 }];
    const unlinked = await make.invoice(org.admin, c, { items: invLines, status: 'paid' });
    // An invoice with lines no job has: reported for review, never linked.
    const loose = await make.invoice(org.admin, c, { status: 'sent' });

    const report = await reconcile.analyse(models, { dataScope: org.admin.dataScope });
    const found = report.unlinkedInvoices.find((u) => u.invoiceId === String(unlinked._id));
    expect(found).toMatchObject({ confidence: 'exact', proposedJobId: String(target._id) });
    // Never the same-named customer's job.
    expect(found.candidates.map((x) => x.jobId)).not.toContain(String(sameNameJob._id));
    expect(found.candidates.map((x) => x.jobId)).toContain(String(unrelated._id));
    const vague = report.unlinkedInvoices.find((u) => u.invoiceId === String(loose._id));
    expect(vague.confidence).toBe('review');
    expect(vague.proposedJobId).toBeNull();

    // Other businesses are outside the report.
    expect(report.unlinkedInvoices.every((u) => u.org === `scope:${org.admin.dataScope}`)).toBe(true);

    const changes = await reconcile.applyExact(models, report);
    expect(changes).toEqual([{ invoiceId: String(unlinked._id), invoiceNumber: unlinked.invoiceNumber, jobId: String(target._id) }]);
    expect(String((await Invoice.findById(unlinked._id)).jobId)).toBe(String(target._id));
    expect((await Invoice.findById(loose._id)).jobId).toBeFalsy();

    // The job ticket now reads as billed.
    const row = (await as(org.tokens.admin).get('/api/jobs?limit=500')).body.data.jobs.find((j) => j._id === String(target._id));
    expect(row.invoices.map((i) => i._id)).toEqual([String(unlinked._id)]);

    // And it can be undone.
    expect(await reconcile.undo(models, changes)).toBe(1);
    expect((await Invoice.findById(unlinked._id)).jobId).toBeFalsy();
  });

  test('two invoices matching the same job are left for review', async () => {
    const org = await createOrg('jbr2');
    const c = await make.customer(org.admin);
    const items = [{ itemName: 'Line 1', quantity: 1, unitPrice: 1000, gstRate: 18, itemTotal: 1180 }];
    await make.job(org.admin, c, { items });
    await make.invoice(org.admin, c);
    await make.invoice(org.admin, c);
    const report = await reconcile.analyse(models, { dataScope: org.admin.dataScope });
    expect(report.unlinkedInvoices).toHaveLength(2);
    expect(report.unlinkedInvoices.every((u) => u.confidence === 'review')).toBe(true);
  });

  test('reports links to another customer, a missing job, and jobs billed twice', async () => {
    const org = await createOrg('jbr3');
    const c1 = await make.customer(org.admin);
    const c2 = await make.customer(org.admin);
    const job1 = await make.job(org.admin, c1);
    const wrongCustomer = await make.invoice(org.admin, c2, { jobId: job1._id });
    const gone = await make.invoice(org.admin, c1, { jobId: new Job()._id });
    await make.invoice(org.admin, c1, { jobId: job1._id });

    const report = await reconcile.analyse(models, { dataScope: org.admin.dataScope });
    expect(report.brokenLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoiceId: String(wrongCustomer._id), problem: 'job is for a different customer' }),
      expect.objectContaining({ invoiceId: String(gone._id), problem: 'job no longer exists' })
    ]));
    expect(report.multiplyBilledJobs).toEqual([expect.objectContaining({ jobId: String(job1._id) })]);
  });
});
