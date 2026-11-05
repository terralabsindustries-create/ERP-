/**
 * Job ticket → invoice with GST. A job ticket prices each item before tax and
 * adds GST at the item's rate (and the design charge's own rate); the invoice
 * raised from it must come to the same total, keep that GST everywhere it is
 * shown (invoice, list, job, PDF, monthly report), and never add it twice.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const PDFService = require('../src/services/PDFService');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;
const api = () => ({
  get: (url) => request(app).get(url).set(auth(org.tokens.admin)),
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body),
  put: (url, body) => request(app).put(url).set(auth(org.tokens.admin)).send(body)
});
const company = { name: 'Test Printers', currency: 'INR', addressLines: [] };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// A job ticket as the Job Ticket form saves it: prices before tax, a GST rate
// per item, the item total with GST, and a design charge with its own rate.
const ticketItems = [
  // Area item: one piece of 6 ft × 4 ft = 24 sq ft at ₹12 = ₹288, + 18% = ₹339.84.
  { itemName: 'Flex banner', itemType: 'Square Feet', unit: 'sqft', length: 6, width: 4, totalSquareFeet: 24, quantity: 1, unitPrice: 12, gstRate: 18, hsnCode: '4911', itemTotal: 339.84 },
  // 100 cards at ₹2.50 = ₹250, + 12% = ₹280.
  { itemName: 'Visiting cards', itemType: 'Numbers', unit: 'pieces', quantity: 100, unitPrice: 2.5, gstRate: 12, itemTotal: 280 }
];
const ticketDesign = { amount: 750, sacCode: '998391', gstRate: 18, totalAmount: 885 };
// What the Job Ticket form shows as its Grand Total.
const TICKET_TOTAL = round2(339.84 + 280 + 885);

// The invoice the "Create invoice" dialog sends for that job ticket: each
// line's price before tax and its rate; never the GST-inclusive item total.
const invoiceFromTicket = (job, extra = {}) => ({
  jobId: String(job._id),
  customerId: String(cust._id),
  items: job.items.map((i) => ({
    itemName: i.itemName,
    description: i.description || '',
    hsnCode: i.hsnCode || '',
    quantity: i.itemType === 'Square Feet' ? 1 : i.quantity,
    unit: i.unit,
    unitPrice: i.unitPrice,
    length: i.length,
    width: i.width,
    gstRate: i.gstRate
  })),
  designCharge: job.designCharge.amount,
  designChargeGstRate: job.designCharge.gstRate,
  ...extra
});

let job;
let invoice;

beforeAll(async () => {
  await connectTestDb('jobgst');
  org = await createOrg('jg');
  cust = await make.customer(org.admin, { name: 'Lotus Events' });
  const created = await api().post('/api/jobs', { title: 'Wedding stage backdrop', customerId: String(cust._id), items: ticketItems, designCharge: ticketDesign });
  expect(created.status).toBe(201);
  job = created.body.data.job;
});
afterAll(disconnectTestDb);

describe('an invoice raised from a job ticket', () => {
  test('comes to the job ticket total, with the GST of every item and the design charge', async () => {
    const res = await api().post('/api/invoices', invoiceFromTicket(job));
    expect(res.status).toBe(201);
    invoice = res.body.data.invoice;

    // Taxable 288 + 250 + 750 = 1,288; GST 51.84 + 30 + 135 = 216.84.
    expect(invoice).toMatchObject({
      subtotal: 538,
      designCharge: 750,
      taxableAmount: 1288,
      totalGstAmount: 216.84,
      totalCgstAmount: 108.42,
      totalSgstAmount: 108.42,
      totalIgstAmount: 0,
      totalAmount: TICKET_TOTAL,
      balanceAmount: TICKET_TOTAL,
      isInterState: false,
      designChargeGstRate: 18,
      designChargeGstAmount: 135
    });
    expect(invoice.items[0]).toMatchObject({ totalAmount: 288, gstRate: 18, gstAmount: 51.84, cgstAmount: 25.92, sgstAmount: 25.92, itemTotal: 339.84 });
    expect(invoice.items[1]).toMatchObject({ totalAmount: 250, gstRate: 12, gstAmount: 30, itemTotal: 280 });
  });

  test("the job ticket's own design charge object gives the same invoice", async () => {
    const res = await api().post('/api/invoices', { ...invoiceFromTicket(job), designCharge: job.designCharge, designChargeGstRate: undefined });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.totalAmount).toBe(TICKET_TOTAL);
  });

  test('GST is added once: GST-inclusive totals sent by a client are ignored', async () => {
    const body = invoiceFromTicket(job);
    body.items = body.items.map((i, n) => ({ ...i, itemTotal: ticketItems[n].itemTotal, totalAmount: ticketItems[n].itemTotal, gstAmount: 999 }));
    const res = await api().post('/api/invoices', { ...body, totalAmount: 1, totalGstAmount: 1, taxableAmount: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ taxableAmount: 1288, totalGstAmount: 216.84, totalAmount: TICKET_TOTAL });
  });

  test('shows with its GST in the invoice list, on the invoice and on the job', async () => {
    const listed = (await api().get('/api/invoices?limit=100')).body.data.invoices.find((i) => i._id === invoice._id);
    expect(listed).toMatchObject({ totalAmount: TICKET_TOTAL, totalGstAmount: 216.84, taxableAmount: 1288 });

    const one = (await api().get(`/api/invoices/${invoice._id}`)).body.data.invoice;
    expect(one).toMatchObject({ totalAmount: TICKET_TOTAL, totalGstAmount: 216.84 });

    const jobs = (await api().get('/api/jobs?limit=100')).body.data.jobs;
    const billed = jobs.find((j) => j._id === job._id).invoices.find((i) => i._id === invoice._id);
    expect(billed.totalAmount).toBe(TICKET_TOTAL);
  });

  test('prints the taxable amount, CGST and SGST by rate, and the total with GST', async () => {
    const stored = await Invoice.findById(invoice._id);
    const d = PDFService.invoiceDocument(stored.toObject({ virtuals: true }), company);
    expect(d.summary).toEqual([
      { label: 'Subtotal', value: 'INR 538.00' },
      { label: 'Design Charge', value: 'INR 750.00' },
      { label: 'Taxable Amount', value: 'INR 1,288.00' },
      { label: 'CGST @ 6%', value: 'INR 15.00' },
      { label: 'SGST @ 6%', value: 'INR 15.00' },
      { label: 'CGST @ 9%', value: 'INR 93.42' },
      { label: 'SGST @ 9%', value: 'INR 93.42' },
      { label: 'Total GST', value: 'INR 216.84' },
      { label: 'Total', value: 'INR 1,504.84', bold: true }
    ]);
    expect(d.items[0].sub).toBe('HSN: 4911 · GST 18%');
    expect(d.amountWords).toMatch(/One Thousand Five Hundred Four Only$/);
    const pdf = await PDFService.generateInvoicePDF(stored, company);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('keeps its GST when a payment re-saves it and when only the notes change', async () => {
    const pay = await api().post('/api/payments', { customerId: String(cust._id), invoiceId: invoice._id, amount: 500, paymentMethod: 'cash' });
    expect(pay.status).toBe(201);
    let stored = await Invoice.findById(invoice._id);
    expect(stored).toMatchObject({ totalGstAmount: 216.84, totalAmount: TICKET_TOTAL, balanceAmount: round2(TICKET_TOTAL - 500) });

    const notes = await api().put(`/api/invoices/${invoice._id}`, { notes: 'Deliver to the hall' });
    expect(notes.status).toBe(200);
    expect(notes.body.data.invoice).toMatchObject({ totalGstAmount: 216.84, totalAmount: TICKET_TOTAL });

    // Changing only the discount re-prices it and keeps every line's rate.
    const discounted = await api().put(`/api/invoices/${invoice._id}`, { discountAmount: 88 });
    expect(discounted.status).toBe(200);
    stored = await Invoice.findById(invoice._id);
    // Taxable 1,288 − 88 = 1,200; GST on each part's share of it.
    expect(stored.taxableAmount).toBe(1200);
    expect(stored.items.map((i) => i.gstRate)).toEqual([18, 12]);
    expect(stored.designChargeGstRate).toBe(18);
    const expectedGst = round2(stored.items.reduce((s, i) => s + i.gstAmount, 0) + stored.designChargeGstAmount);
    expect(stored.totalGstAmount).toBe(expectedGst);
    expect(stored.totalAmount).toBe(round2(1200 + expectedGst));
    expect(stored.totalGstAmount).toBeLessThan(216.84);
  });
});

describe('GST rates and supply', () => {
  const lines = (rates) => rates.map((gstRate, n) => ({ itemName: `Item ${n + 1}`, quantity: 1, unitPrice: 1000, gstRate }));

  test('an invoice without GST totals its taxable amount', async () => {
    const res = await api().post('/api/invoices', { customerId: String(cust._id), items: lines([0, 0]), designCharge: 200, designChargeGstRate: 0 });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ taxableAmount: 2200, totalGstAmount: 0, totalAmount: 2200 });
    const d = PDFService.invoiceDocument((await Invoice.findById(res.body.data.invoice._id)).toObject(), company);
    expect(d.summary.map((s) => s.label)).toEqual(['Subtotal', 'Design Charge', 'Total']);
  });

  test('different rates on one invoice are each charged and listed', async () => {
    const res = await api().post('/api/invoices', { customerId: String(cust._id), items: lines([5, 12, 18, 28]) });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ taxableAmount: 4000, totalGstAmount: 630, totalAmount: 4630 });
    expect(res.body.data.invoice.items.map((i) => i.gstAmount)).toEqual([50, 120, 180, 280]);
  });

  test('a supply to another state is charged IGST', async () => {
    const res = await api().post('/api/invoices', invoiceFromTicket(job, { isInterState: true }));
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ isInterState: true, totalIgstAmount: 216.84, totalCgstAmount: 0, totalSgstAmount: 0, totalAmount: TICKET_TOTAL });
    const d = PDFService.invoiceDocument((await Invoice.findById(res.body.data.invoice._id)).toObject(), company);
    expect(d.summary.map((s) => s.label)).toEqual(['Subtotal', 'Design Charge', 'Taxable Amount', 'IGST @ 12%', 'IGST @ 18%', 'Total GST', 'Total']);

    // Switching an invoice between the two re-splits the same GST.
    const intra = await api().put(`/api/invoices/${res.body.data.invoice._id}`, { isInterState: false });
    expect(intra.body.data.invoice).toMatchObject({ isInterState: false, totalIgstAmount: 0, totalCgstAmount: 108.42, totalSgstAmount: 108.42, totalAmount: TICKET_TOTAL });
  });
});

describe('the monthly report', () => {
  test('counts the GST by rate, the design charge included', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await Invoice.updateMany({ dataScope: org.dataScope }, { status: 'sent' });
    const res = await api().get(`/api/reports/revenue?month=${month}`);
    expect(res.status).toBe(200);
    const all = await Invoice.find({ dataScope: org.dataScope, noGst: { $ne: true } });
    const sum = (f) => round2(all.reduce((s, i) => s + (i[f] || 0), 0));
    const report = res.body.data;
    expect(report.totalTaxPayable).toBe(sum('totalGstAmount'));
    expect(report.totalRevenue).toBe(sum('totalAmount'));
    // The 18% slab holds the flex lines and the design charges.
    const slabTax = round2(Object.values(report.gstBreakdown).reduce((s, x) => s + x.tax, 0));
    expect(slabTax).toBe(report.totalTaxPayable);
    expect(report.gstBreakdown.gst18.tax).toBeGreaterThan(0);
  });
});
