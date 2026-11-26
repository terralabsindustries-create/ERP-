/**
 * The invoice list's job details and amounts: the job ticket an invoice was
 * raised from stays on it (as a stored title, so it survives the job ticket
 * being deleted), follows the invoice through edits, can be searched for, and
 * the amounts read the same in the list, the invoice and its print data.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Job = require('../src/models/Job');
const WalkInJob = require('../src/models/WalkInJob');
const PDFService = require('../src/services/PDFService');
const { backfillInvoiceJobTitles } = require('../src/scripts/backfillInvoiceJobTitles');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
const api = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  del: (url) => request(app).delete(url).set(auth(token))
});
const admin = () => api(org.tokens.admin);

const line = { itemName: 'Visiting cards', quantity: 100, unit: 'pieces', unitPrice: 2.5, gstRate: 18 };
const listed = async (search) => {
  const res = await admin().get(`/api/invoices?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`);
  expect(res.status).toBe(200);
  return res.body.data.invoices;
};

beforeAll(async () => {
  await connectTestDb('invoice_list_jobs');
  org = await createOrg('ilj');
  other = await createOrg('iljother');
  cust = await make.customer(org.admin, { name: 'Lotus Events', phone: '9847012345' });
});
afterAll(disconnectTestDb);

describe('an invoice raised from a job ticket', () => {
  let job;
  let invoiceId;

  beforeAll(async () => {
    job = await make.job(org.admin, cust, { title: 'Wedding cards — Lotus' });
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), jobId: String(job._id), items: [line] });
    expect(res.status).toBe(201);
    invoiceId = res.body.data.invoice._id;
  });

  test('stores the job ticket title, taken from the job ticket rather than the request', async () => {
    const stored = await Invoice.findById(invoiceId);
    expect(stored.jobTitle).toBe('Wedding cards — Lotus');

    const spoofed = await admin().post('/api/invoices', { customerId: String(cust._id), jobId: String(job._id), jobTitle: 'Something else', allowAdditionalInvoice: true, items: [line] });
    expect(spoofed.status).toBe(201);
    expect(spoofed.body.data.invoice.jobTitle).toBe('Wedding cards — Lotus');
  });

  test('lists the customer contact number and the job', async () => {
    const row = (await listed()).find((i) => i._id === invoiceId);
    expect(row.jobId.title).toBe('Wedding cards — Lotus');
    expect(row.jobTitle).toBe('Wedding cards — Lotus');
    expect(row.customerId.phone).toBe('9847012345');
  });

  test('can be found by searching for the job title', async () => {
    expect((await listed('wedding cards')).map((i) => i._id)).toContain(invoiceId);
  });

  test('an edit that keeps the job picks up the job ticket\'s current title', async () => {
    await Job.updateOne({ _id: job._id }, { $set: { title: 'Wedding cards — Lotus (reprint)' } });
    const res = await admin().put(`/api/invoices/${invoiceId}`, { notes: 'Deliver by Friday' });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice.jobTitle).toBe('Wedding cards — Lotus (reprint)');
  });

  test('moving the invoice to another job ticket moves the title with it', async () => {
    const second = await make.job(org.admin, cust, { title: 'Flex banners — Lotus' });
    const res = await admin().put(`/api/invoices/${invoiceId}`, { jobId: String(second._id) });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice.jobId.title).toBe('Flex banners — Lotus');
    expect(res.body.data.invoice.jobTitle).toBe('Flex banners — Lotus');
  });

  test('taking the job ticket off leaves a standalone invoice with no job', async () => {
    const res = await admin().put(`/api/invoices/${invoiceId}`, { jobId: null });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice.jobId).toBeNull();
    expect(res.body.data.invoice.jobTitle).toBeUndefined();
  });

  test('keeps its job title after the job ticket is deleted', async () => {
    const doomed = await make.job(org.admin, cust, { title: 'Calendar 2027 — Lotus' });
    const created = await admin().post('/api/invoices', { customerId: String(cust._id), jobId: String(doomed._id), items: [line] });
    expect((await admin().del(`/api/jobs/${doomed._id}`)).status).toBe(200);

    const row = (await listed()).find((i) => i._id === created.body.data.invoice._id);
    expect(row.jobId).toBeNull();
    expect(row.jobTitle).toBe('Calendar 2027 — Lotus');

    // Editing it (the form no longer knows the deleted job) keeps the title.
    const edited = await admin().put(`/api/invoices/${row._id}`, { notes: 'Edited after the job went' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.invoice.jobTitle).toBe('Calendar 2027 — Lotus');
  });

  test('another business\'s job ticket still cannot be linked', async () => {
    const theirs = await make.job(other.admin, await make.customer(other.admin), { title: 'Not yours' });
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), jobId: String(theirs._id), items: [line] });
    expect(res.status).toBe(404);
  });
});

test('a standalone invoice has no job and keeps a title the request gives it', async () => {
  const plain = await admin().post('/api/invoices', { customerId: String(cust._id), items: [line] });
  expect(plain.status).toBe(201);
  expect(plain.body.data.invoice.jobId ?? null).toBeNull();
  expect(plain.body.data.invoice.jobTitle).toBeUndefined();

  const labelled = await admin().post('/api/invoices', { customerId: String(cust._id), jobTitle: 'Office stationery', items: [line] });
  expect(labelled.body.data.invoice.jobTitle).toBe('Office stationery');
});

test('a search with regex characters is matched literally instead of failing', async () => {
  for (const q of ['(', 'C++', '[INV', '*']) {
    const res = await admin().get(`/api/invoices?search=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
  }
});

test('an invoice billed from a counter job shows that job', async () => {
  const counter = await WalkInJob.create({
    customerName: cust.name,
    customerPhone: cust.phone,
    jobType: 'printing',
    description: 'Wedding invitation inserts',
    specifications: { quantity: 200 },
    timeline: { estimatedCompletion: new Date(Date.now() + 3600e3) },
    status: 'ready',
    userId: org.admin._id,
    dataScope: org.dataScope
  });
  const inv = await admin().post('/api/invoices', { customerId: String(cust._id), items: [line], notes: `Counter job ${counter.jobNumber}` });
  expect(inv.status).toBe(201);
  const linked = await admin().put(`/api/walk-in-jobs/${counter._id}/invoice`, { invoiceId: inv.body.data.invoice._id });
  expect(linked.status).toBe(200);
  expect((await Invoice.findById(inv.body.data.invoice._id)).jobTitle).toBe(`${counter.jobNumber} · Wedding invitation inserts`);
});

test('amounts agree in the list, the invoice and its print data, with the design charge counted once', async () => {
  const res = await admin().post('/api/invoices', {
    customerId: String(cust._id),
    items: [{ ...line, unitPrice: 10 }], // 1000 at 18%
    designCharge: 500,
    designChargeGstRate: 18,
    discountAmount: 100,
    status: 'sent'
  });
  expect(res.status).toBe(201);
  const id = res.body.data.invoice._id;
  // (1000 + 500 − 100) = 1400 taxable, + 18% = 252 GST → 1652.
  const detail = (await admin().get(`/api/invoices/${id}`)).body.data.invoice;
  expect(detail.subtotal).toBe(1000);
  expect(detail.designCharge).toBe(500);
  expect(detail.taxableAmount).toBe(1400);
  expect(detail.totalGstAmount).toBe(252);
  expect(detail.totalAmount).toBe(1652);
  expect(detail.balanceAmount).toBe(1652);

  const row = (await listed()).find((i) => i._id === id);
  expect(row.totalAmount).toBe(detail.totalAmount);
  expect(row.balanceAmount).toBe(detail.balanceAmount);
  expect(row.designCharge).toBe(500);

  // The printed invoice: the design charge once, on its own line.
  const d = PDFService.invoiceDocument((await Invoice.findById(id)).toObject({ virtuals: true }), { name: 'Test Printers', currency: 'INR', addressLines: [] });
  expect(d.summary.filter((row) => row.label === 'Design Charge')).toHaveLength(1);
  expect(d.summary.find((row) => row.label === 'Subtotal').value).toBe('INR 1,000.00');
  expect(d.summary.find((row) => row.label === 'Total').value).toBe('INR 1,652.00');

  // A partial payment moves the balance and the status in the list.
  const paid = await admin().post('/api/payments', { customerId: String(cust._id), invoiceId: id, amount: 652, paymentMethod: 'cash' });
  expect(paid.status).toBe(201);
  const after = (await listed()).find((i) => i._id === id);
  expect(after.paidAmount).toBe(652);
  expect(after.balanceAmount).toBe(1000);
  expect(after.paymentStatus).toBe('partial');
});

describe('backfilling job titles on older invoices', () => {
  test('fills the title from a linked job ticket or counter job, leaves the rest, and writes only with apply', async () => {
    const job = await make.job(org.admin, cust, { title: 'Brochures — older' });
    const fromJob = await make.invoice(org.admin, cust, { jobId: job._id });
    const gone = await make.invoice(org.admin, cust, { jobId: job._id.constructor.createFromTime(1) });
    const kept = await make.invoice(org.admin, cust, { jobId: job._id, jobTitle: 'Already set' });
    const plain = await make.invoice(org.admin, cust);
    const counterInvoice = await make.invoice(org.admin, cust);
    const counter = await WalkInJob.create({
      customerName: cust.name, customerPhone: cust.phone, jobType: 'printing', description: 'Photocopies',
      specifications: { quantity: 10 }, timeline: { estimatedCompletion: new Date() }, status: 'collected',
      billing: { invoice: counterInvoice._id, invoiceNumber: counterInvoice.invoiceNumber, amount: counterInvoice.totalAmount },
      userId: org.admin._id, dataScope: org.dataScope
    });
    const before = await Invoice.findById(fromJob._id).lean();

    const dry = await backfillInvoiceJobTitles({ apply: false, log: () => {} });
    expect(dry.fromJobs).toBeGreaterThanOrEqual(1);
    expect(dry.fromCounterJobs).toBeGreaterThanOrEqual(1);
    expect((await Invoice.findById(fromJob._id)).jobTitle).toBeUndefined();

    await backfillInvoiceJobTitles({ apply: true, log: () => {} });
    const afterJob = await Invoice.findById(fromJob._id).lean();
    expect(afterJob.jobTitle).toBe('Brochures — older');
    // Only the title changes: no totals are worked out again.
    expect(afterJob.totalAmount).toBe(before.totalAmount);
    expect(afterJob.updatedAt).toEqual(before.updatedAt);
    expect((await Invoice.findById(gone._id)).jobTitle).toBeUndefined();
    expect((await Invoice.findById(kept._id)).jobTitle).toBe('Already set');
    expect((await Invoice.findById(plain._id)).jobTitle).toBeUndefined();
    expect((await Invoice.findById(counterInvoice._id)).jobTitle).toBe(`${counter.jobNumber} · Photocopies`);

    const again = await backfillInvoiceJobTitles({ apply: true, log: () => {} });
    expect(again.fromJobs + again.fromCounterJobs).toBe(0);
  });
});
