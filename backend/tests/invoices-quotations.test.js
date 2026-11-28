/**
 * Invoices and quotations: dimensions, the design charge and GST on create and
 * edit, quotation → invoice conversion, the PDF contents, and the design
 * charge report. The job ticket → invoice flow has its own file.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Inventory = require('../src/models/Inventory');
const Quotation = require('../src/models/Quotation');
const PDFService = require('../src/services/PDFService');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;
const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body)
});
const admin = () => as(org.tokens.admin);
const company = { name: 'Test Printers', currency: 'INR', addressLines: [] };

const flexLine = { itemName: 'Flex banner', description: 'Star flex, eyelets', quantity: 10, unit: 'sqft', unitPrice: 12, length: 6, width: 4 };
const cardLine = { itemName: 'Visiting cards', quantity: 100, unit: 'pieces', unitPrice: 2.5 };

beforeAll(async () => {
  await connectTestDb('billing');
  org = await createOrg('bq');
  cust = await make.customer(org.admin, { name: 'Lotus Events' });
});
afterAll(disconnectTestDb);

test('a job skipped at invoice creation appears on the Invoices page until it is billed', async () => {
  const created = await admin().post('/api/jobs', {
    title: 'Invoice later job',
    customerId: String(cust._id),
    items: [{ itemName: 'Printed cards', quantity: 100, unitPrice: 2.5, gstRate: 18 }]
  });
  expect(created.status).toBe(201);
  const jobId = created.body.data.job._id;
  const emptyJob = await admin().post('/api/jobs', {
    title: 'Invoice later without items', customerId: String(cust._id)
  });
  expect(emptyJob.status).toBe(201);

  const pending = await admin().get('/api/invoices/pending-jobs?search=Invoice%20later');
  expect(pending.status).toBe(200);
  expect(pending.body.data.jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ _id: jobId, title: 'Invoice later job' })
  ]));
  expect(pending.body.data.jobs.find((job) => job._id === jobId).items).toHaveLength(1);
  expect(pending.body.data.jobs.some((job) => job._id === emptyJob.body.data.job._id)).toBe(true);

  const invoice = await admin().post('/api/invoices', {
    customerId: String(cust._id), jobId, items: [cardLine]
  });
  expect(invoice.status).toBe(201);
  const after = await admin().get('/api/invoices/pending-jobs?search=Invoice%20later');
  expect(after.body.data.jobs.some((job) => job._id === jobId)).toBe(false);
  expect(after.body.data.jobs.some((job) => job._id === emptyJob.body.data.job._id)).toBe(true);
});

describe('creating an invoice', () => {
  let invoice;

  test('a design charge alone can be invoiced and edited without an inventory line', async () => {
    const job = await admin().post('/api/jobs', {
      title: 'Design only job', customerId: String(cust._id), items: [],
      designCharge: { amount: 1000, gstRate: 18, totalAmount: 1180 }
    });
    expect(job.status).toBe(201);
    const created = await admin().post('/api/invoices', {
      customerId: String(cust._id), jobId: job.body.data.job._id,
      items: [], designCharge: 1000, designChargeGstRate: 18
    });
    expect(created.status).toBe(201);
    expect(created.body.data.invoice).toMatchObject({
      jobId: expect.objectContaining({ _id: job.body.data.job._id }),
      items: [], subtotal: 0, designCharge: 1000, designChargeGstAmount: 180,
      totalAmount: 1180, balanceAmount: 1180
    });

    const updated = await admin().put(`/api/invoices/${created.body.data.invoice._id}`, {
      items: [], designCharge: 500, designChargeGstRate: 18
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.invoice).toMatchObject({
      items: [], subtotal: 0, designCharge: 500, designChargeGstAmount: 90,
      totalAmount: 590, balanceAmount: 590
    });
    const stored = await Invoice.findById(created.body.data.invoice._id);
    const document = PDFService.invoiceDocument(stored.toObject({ virtuals: true }), company);
    expect(document.items).toHaveLength(0);
    expect(document.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Design Charge', value: 'INR 500.00' }),
      expect.objectContaining({ label: 'Total', value: 'INR 590.00' })
    ]));
    expect((await PDFService.generateInvoicePDF(stored, company)).subarray(0, 4).toString()).toBe('%PDF');

    const empty = await admin().post('/api/invoices', {
      customerId: String(cust._id), items: [], designCharge: 0
    });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/item or a design charge/);
  });

  test('prices dimension lines by area × quantity, adds the design charge, and charges GST on the discounted value', async () => {
    const res = await admin().post('/api/invoices', {
      customerId: String(cust._id),
      items: [{ ...flexLine, gstRate: 18, hsnCode: '4911' }, { ...cardLine, gstRate: 12 }],
      designCharge: 500,
      discountAmount: 30,
      noGst: false,
      isInterState: true,
      // Client totals are never trusted.
      subtotal: 1,
      totalAmount: 1
    });
    expect(res.status).toBe(201);
    invoice = res.body.data.invoice;
    // 3,630 − 30 = 3,600 taxable; the discount is shared 23.80 / 2.07 / 4.13.
    // 18% of 2,856.20 = 514.12 and 12% of 247.93 = 29.75, all IGST.
    expect(invoice).toMatchObject({
      subtotal: 3130,
      designCharge: 500,
      discountAmount: 30,
      taxableAmount: 3600,
      totalGstAmount: 543.87,
      totalCgstAmount: 0,
      totalSgstAmount: 0,
      totalIgstAmount: 543.87,
      totalAmount: 4143.87,
      balanceAmount: 4143.87,
      isInterState: true,
      noGst: false
    });
    expect(invoice.items[0]).toMatchObject({ unit: 'sqft', itemType: 'Square Feet', length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 240, quantity: 10, unitPrice: 12, totalAmount: 2880, taxableValue: 2856.2, gstRate: 18, gstAmount: 514.12, igstAmount: 514.12, hsnCode: '4911' });
    expect(invoice.items[1]).toMatchObject({ itemType: 'Numbers', quantity: 100, totalAmount: 250, taxableValue: 247.93, gstRate: 12, gstAmount: 29.75 });
  });

  test("takes a job ticket's design charge object with its GST rate", async () => {
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [cardLine], designCharge: { amount: 750, gstRate: 18, totalAmount: 885 } });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ designCharge: 750, designChargeGstRate: 18, designChargeGstAmount: 135, totalGstAmount: 135, totalAmount: 1135 });
  });

  test('refuses a GST rate outside 0–100%', async () => {
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [{ ...cardLine, gstRate: 118 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/GST rate/);
    expect((await admin().post('/api/invoices', { customerId: String(cust._id), items: [cardLine], designCharge: 10, designChargeGstRate: -5 })).status).toBe(400);
  });

  test('refuses a negative design charge and a discount larger than the invoice', async () => {
    expect((await admin().post('/api/invoices', { customerId: String(cust._id), items: [cardLine], designCharge: -1 })).status).toBe(400);
    const tooMuch = await admin().post('/api/invoices', { customerId: String(cust._id), items: [cardLine], designCharge: 100, discountAmount: 351 });
    expect(tooMuch.status).toBe(400);
  });

  test('an area line of a stock item counted in sq ft takes its total area out of stock', async () => {
    const roll = await make.stockItem(org.admin, { name: 'Star flex roll', unit: 'sqft', quantity: 1000 });
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [{ ...flexLine, itemName: 'Star flex roll' }] });
    expect(res.status).toBe(201);
    expect((await Inventory.findById(roll._id)).quantity).toBe(760);

    // 40 pieces need 960 sq ft; 760 are left.
    const short = await admin().post('/api/invoices', { customerId: String(cust._id), items: [{ ...flexLine, itemName: 'Star flex roll', quantity: 40 }] });
    expect(short.status).toBe(400);
    expect(short.body.details[0]).toMatch(/Available: 760, Required: 960/);
  });

  test('the No GST switch is gone', async () => {
    expect((await request(app).patch(`/api/invoices/${invoice._id}/no-gst`).set(auth(org.tokens.admin)).send({ noGst: true })).status).toBe(404);
  });

  test('the PDF shows the size, area, pieces and rate per sq ft, the design charge, and the GST by rate', async () => {
    const stored = await Invoice.findById(invoice._id);
    const d = PDFService.invoiceDocument(stored.toObject({ virtuals: true }), company);
    // The line's note, HSN code and GST rate print under the item name.
    expect(d.items[0]).toMatchObject({ description: 'Flex banner', sub: 'Star flex, eyelets\nHSN: 4911 · GST 18%', size: '6 × 4 ft', sizeSub: '24 sq ft each', area: '240 sq ft', qty: '10', rate: '12.00', rateSub: 'per sq ft', amount: '2,880.00' });
    expect(d.items[1]).toMatchObject({ sub: 'GST 12%', size: '', area: '', qty: '100', amount: '250.00' });
    expect(d.summary.map((s) => s.label)).toEqual(['Subtotal', 'Design Charge', 'Discount', 'Taxable Amount', 'IGST @ 12%', 'IGST @ 18%', 'Total GST', 'Total']);
    const value = (label) => d.summary.find((s) => s.label === label).value;
    expect(value('Design Charge')).toBe('INR 500.00');
    expect(value('Taxable Amount')).toBe('INR 3,600.00');
    expect(value('IGST @ 18%')).toBe('INR 514.12');
    expect(value('Total GST')).toBe('INR 543.87');
    expect(value('Total')).toBe('INR 4,143.87');
    expect(d.amountWords).toMatch(/Four Thousand One Hundred Forty Three/i);

    const pdf = await PDFService.generateInvoicePDF(stored, company);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('editing an invoice', () => {
  let id;
  beforeAll(async () => {
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [flexLine], designCharge: 200 });
    id = res.body.data.invoice._id;
  });

  test('re-prices on the server and ignores the totals the client sends', async () => {
    const res = await admin().put(`/api/invoices/${id}`, {
      items: [{ ...flexLine, quantity: 5 }],
      designCharge: 350,
      discountAmount: 10,
      subtotal: 99999,
      totalAmount: 99999,
      totalGstAmount: 500
    });
    expect(res.status).toBe(200);
    // 6 × 4 × 5 = 120 sq ft × 12 = 1440, + 350 − 10
    expect(res.body.data.invoice).toMatchObject({ subtotal: 1440, designCharge: 350, totalAmount: 1780, totalGstAmount: 0, balanceAmount: 1780 });
    expect(res.body.data.invoice.items[0]).toMatchObject({ totalSquareFeet: 120, areaPerPiece: 24 });
  });

  test('a notes-only edit leaves the amounts alone', async () => {
    const res = await admin().put(`/api/invoices/${id}`, { notes: 'Deliver to the hall' });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toMatchObject({ notes: 'Deliver to the hall', totalAmount: 1780, designCharge: 350 });
  });

  test('once issued, its amounts are locked (corrected with credit or debit notes)', async () => {
    await Invoice.updateOne({ _id: id }, { paidAmount: 1000, paymentStatus: 'partial', status: 'sent' });
    const res = await admin().put(`/api/invoices/${id}`, { designCharge: 0, items: [{ ...cardLine, quantity: 10 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVOICE_ISSUED_LOCKED');
  });
});

describe('invoices issued with GST before October 2026', () => {
  let legacy;
  beforeAll(async () => {
    legacy = await make.invoice(org.admin, cust, { lines: [{ amount: 1000, rate: 18 }] });
  });

  test('keep their GST when re-saved, e.g. by a payment, and show it on the PDF', async () => {
    const pay = await admin().post('/api/payments', { customerId: String(cust._id), invoiceId: String(legacy._id), amount: 180, paymentMethod: 'cash' });
    expect(pay.status).toBe(201);
    const after = await Invoice.findById(legacy._id);
    expect(after).toMatchObject({ totalGstAmount: 180, totalAmount: 1180, balanceAmount: 1000 });
    const d = PDFService.invoiceDocument(after.toObject({ virtuals: true }), company);
    expect(d.summary.find((s) => s.label === 'CGST @ 9%').value).toBe('INR 90.00');
    expect(d.summary.find((s) => s.label === 'SGST @ 9%').value).toBe('INR 90.00');
    expect(d.items[0].amount).toBe('1,000.00');
  });

  test('a notes-only edit keeps the GST; re-pricing an issued line is refused', async () => {
    const notes = await admin().put(`/api/invoices/${legacy._id}`, { notes: 'Checked' });
    expect(notes.body.data.invoice.totalAmount).toBe(1180);
    const repriced = await admin().put(`/api/invoices/${legacy._id}`, { items: [{ itemName: 'Line 1', quantity: 1, unitPrice: 1000, gstRate: 18 }] });
    expect(repriced.status).toBe(409);
    expect(await Invoice.findById(legacy._id)).toMatchObject({ totalGstAmount: 180, totalCgstAmount: 90, totalSgstAmount: 90, totalAmount: 1180 });
  });
});

describe('quotations', () => {
  let quotation;

  test('are priced like invoices: area × quantity, a separate design charge, GST per line', async () => {
    const res = await admin().post('/api/quotations', {
      customer_id: String(cust._id),
      gst_type: 'gst',
      is_interstate: true,
      items: [
        { item_name: 'Flex banner', description: 'Star flex', quantity: 10, unit: 'sqft', unit_price: 12, length: 6, width: 4, tax_rate: 18 },
        { item_name: 'Standee', quantity: 2, unit: 'pieces', unit_price: 450 }
      ],
      design_charge: 600
    });
    expect(res.status).toBe(201);
    quotation = res.body.data.quotation;
    // 18% of 2,880 on the flex, interstate: IGST 518.40.
    expect(quotation).toMatchObject({ gst_type: 'gst', is_interstate: true, subtotal: 3780, design_charge: 600, tax_amount: 518.4, igst_amount: 518.4, cgst_amount: 0, total_amount: 4898.4 });
    expect(quotation.items[0]).toMatchObject({ length: 6, width: 4, area_per_piece: 24, total_area: 240, total_amount: 3398.4, tax_rate: 18, tax_amount: 518.4 });
    expect(quotation.items[1]).toMatchObject({ total_amount: 900, tax_rate: 0, tax_amount: 0 });
  });

  test('refuse a negative design charge', async () => {
    const res = await admin().post('/api/quotations', { customer_id: String(cust._id), items: [{ item_name: 'Standee', quantity: 1, unit_price: 450 }], design_charge: -5 });
    expect(res.status).toBe(400);
  });

  test('a quotation made from a job keeps that job on its invoice', async () => {
    const createdJob = await admin().post('/api/jobs', {
      title: 'Quoted cards', customerId: String(cust._id),
      items: [{ itemName: 'Cards', quantity: 100, unitPrice: 2, gstRate: 18 }]
    });
    expect(createdJob.status).toBe(201);
    const jobId = createdJob.body.data.job._id;
    const createdQuote = await admin().post('/api/quotations', {
      customer_id: String(cust._id), jobId,
      items: [{ item_name: 'Cards', quantity: 100, unit_price: 2, tax_rate: 18 }]
    });
    expect(createdQuote.status).toBe(201);
    expect(createdQuote.body.data.quotation.jobId).toBe(jobId);

    const converted = await admin().post(`/api/quotations/${createdQuote.body.data.quotation._id}/convert-to-invoice`, {});
    expect(converted.status).toBe(201);
    expect(converted.body.data.invoice.jobId).toBe(jobId);
    const listed = await admin().get('/api/jobs?limit=100');
    expect(listed.body.data.jobs.find((job) => job._id === jobId).invoices).toEqual(
      expect.arrayContaining([expect.objectContaining({ _id: converted.body.data.invoice._id })])
    );
  });

  test('a quotation cannot attach another customer or business\'s job', async () => {
    const ownJob = await admin().post('/api/jobs', { title: 'Own job', customerId: String(cust._id) });
    const anotherCustomer = await make.customer(org.admin, { name: 'Another customer' });
    const line = [{ item_name: 'Cards', quantity: 1, unit_price: 100 }];
    const mismatched = await admin().post('/api/quotations', {
      customer_id: String(anotherCustomer._id), jobId: ownJob.body.data.job._id, items: line
    });
    expect(mismatched.status).toBe(400);

    const otherOrg = await createOrg('quote-other');
    const otherCustomer = await make.customer(otherOrg.admin, { name: 'Other business customer' });
    const otherJob = await as(otherOrg.tokens.admin).post('/api/jobs', {
      title: 'Other business job', customerId: String(otherCustomer._id)
    });
    const forbidden = await admin().post('/api/quotations', {
      customer_id: String(cust._id), jobId: otherJob.body.data.job._id, items: line
    });
    expect(forbidden.status).toBe(404);
  });

  test('the PDF shows the dimensions and the design charge', async () => {
    const stored = await Quotation.findById(quotation._id).populate('customer_id');
    const d = PDFService.quotationDocument(stored, company);
    expect(d.items[0]).toMatchObject({ size: '6 × 4 ft', sizeSub: '24 sq ft each', area: '240 sq ft', qty: '10', rateSub: 'per sq ft', amount: '2,880.00' });
    expect(d.summary.map((s) => s.label)).toEqual(['Subtotal', 'Design Charge', 'Taxable Amount', 'IGST @ 18%', 'Total']);
    expect(d.summary.find((s) => s.label === 'Total').value).toBe('INR 4,898.40');
    expect(d.customer.lines.join(' ')).not.toMatch(/GST:|Non-GST/);
    const pdf = await PDFService.generateQuotationPDF(stored, company);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('convert to an invoice with the same lines, dimensions, design charge, GST and total', async () => {
    const res = await admin().post(`/api/quotations/${quotation._id}/convert-to-invoice`, {});
    expect(res.status).toBe(201);
    const inv = res.body.data.invoice;
    expect(inv).toMatchObject({ designCharge: 600, subtotal: 3780, totalGstAmount: 518.4, totalIgstAmount: 518.4, totalAmount: 4898.4, isInterState: true, status: 'draft', noGst: false });
    expect(inv.items).toHaveLength(2);
    expect(inv.items[0]).toMatchObject({ itemName: 'Flex banner', description: 'Star flex', unit: 'sqft', itemType: 'Square Feet', length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 240, quantity: 10, unitPrice: 12, totalAmount: 2880, gstRate: 18, gstAmount: 518.4 });
    expect(inv.items[1]).toMatchObject({ itemName: 'Standee', quantity: 2, totalAmount: 900 });
    expect(res.body.data.quotation).toMatchObject({ status: 'converted', convertedInvoiceNumber: inv.invoiceNumber });

    const again = await admin().post(`/api/quotations/${quotation._id}/convert-to-invoice`, {});
    expect(again.status).toBe(409);
  });

  test('one written with GST before October 2026 converts with its GST', async () => {
    const old = await Quotation.create({
      quotationNumber: 'QUO-OLD-1',
      customer_id: cust._id,
      gst_type: 'gst',
      items: [{ item_name: 'Brochure', quantity: 100, unit_price: 10, tax_rate: 18, tax_amount: 180, total_amount: 1180 }],
      subtotal: 1000,
      tax_amount: 180,
      total_amount: 1180,
      status: 'approved',
      userId: org.admin._id,
      dataScope: org.dataScope
    });
    const d = PDFService.quotationDocument(old, company);
    expect(d.items[0].amount).toBe('1,000.00');
    expect(d.summary.find((s) => s.label === 'CGST @ 9%').value).toBe('INR 90.00');

    const res = await admin().post(`/api/quotations/${old._id}/convert-to-invoice`, {});
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ subtotal: 1000, designCharge: 0, totalGstAmount: 180, totalCgstAmount: 90, totalAmount: 1180 });
  });
});

describe('design charge report', () => {
  let r;
  let rc;
  const year = new Date().getFullYear();
  const month = new Date().getMonth(); // 0-based index into months

  beforeAll(async () => {
    r = await createOrg('dc');
    rc = await make.customer(r.admin, { name: 'Report Customer' });
    const api = as(r.tokens.admin);
    // Issued invoices count; drafts and cancelled ones do not.
    const issued = await api.post('/api/invoices', { customerId: String(rc._id), status: 'sent', items: [cardLine], designCharge: 500 });
    expect(issued.status).toBe(201);
    await make.invoice(r.admin, rc, { status: 'draft', designCharge: 999 });
    await make.invoice(r.admin, rc, { status: 'cancelled', designCharge: 999 });
    // An older invoice that carried the design charge as a line.
    await Invoice.create({
      invoiceNumber: 'INV-OLD-DC',
      customerId: rc._id,
      customerName: rc.name,
      invoiceDate: new Date(),
      dueDate: new Date(),
      items: [{ itemName: 'Design Charge', hsnCode: '9983', quantity: 1, unitPrice: 300, totalAmount: 300, gstRate: 18, gstAmount: 54, cgstAmount: 27, sgstAmount: 27, itemTotal: 354 }],
      subtotal: 300,
      taxableAmount: 300,
      totalGstAmount: 54,
      totalAmount: 354,
      status: 'sent',
      userId: r.admin._id,
      dataScope: r.dataScope
    });
    // Last year: only in the yearly totals.
    await make.invoice(r.admin, rc, { invoiceDate: new Date(year - 1, 5, 15), designCharge: 50 });

    // Quotations: one open, one converted (its invoice is a draft, so not invoiced yet).
    const quote = (design_charge) =>
      api.post('/api/quotations', { customer_id: String(rc._id), items: [{ item_name: 'Poster', quantity: 1, unit_price: 100 }], design_charge });
    await quote(400);
    const converted = await quote(200);
    await api.post(`/api/quotations/${converted.body.data.quotation._id}/convert-to-invoice`, {});
  });

  test('reports issued invoices and quotations separately, month by month', async () => {
    const res = await as(r.tokens.admin).get(`/api/reports/design-charges?year=${year}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.months).toHaveLength(12);
    expect(d.months[month]).toMatchObject({
      invoiced: { amount: 800, count: 2 },
      quoted: { amount: 600, count: 2 },
      convertedQuotes: { amount: 200, count: 1 }
    });
    expect(d.totals.invoiced).toEqual({ amount: 800, count: 2 });
    expect(d.totals.quoted.amount).toBe(600);
    expect(d.sources.quoted).toMatch(/never added to invoiced/);
  });

  test('gives each year its own totals', async () => {
    const res = await as(r.tokens.admin).get(`/api/reports/design-charges?year=${year}`);
    const years = res.body.data.years;
    expect(years.find((y) => y.year === year)).toMatchObject({ invoiced: { amount: 800, count: 2 }, quoted: { amount: 600, count: 2 } });
    expect(years.find((y) => y.year === year - 1)).toMatchObject({ invoiced: { amount: 50, count: 1 } });

    const last = await as(r.tokens.admin).get(`/api/reports/design-charges?year=${year - 1}`);
    expect(last.body.data.totals.invoiced).toEqual({ amount: 50, count: 1 });
  });

  test("stays inside the business and rejects a bad year", async () => {
    const other = await as(org.tokens.admin).get(`/api/reports/design-charges?year=${year}`);
    expect(other.body.data.totals.invoiced.amount).not.toBe(800);
    expect((await as(r.tokens.admin).get('/api/reports/design-charges?year=26')).status).toBe(400);
  });
});

describe('quotation ↔ invoice lifecycle', () => {
  const quote = () => Quotation.create({
    quotationNumber: `QUO-LC-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    customer_id: cust._id,
    status: 'approved',
    gst_type: 'gst',
    items: [{ item_name: 'Poster', quantity: 10, unit_price: 100, tax_rate: 18, tax_amount: 180, total_amount: 1180 }],
    total_amount: 1180,
    userId: org.admin._id,
    dataScope: org.admin.dataScope
  });

  test('deleting the draft invoice releases the quotation; re-conversion gets a new number', async () => {
    const q = await quote();
    const first = (await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).body.data.invoice;
    expect((await Quotation.findById(q._id)).status).toBe('converted');

    const del = await request(app).delete(`/api/invoices/${first._id}`).set(auth(org.tokens.admin));
    expect(del.status).toBe(200);
    const released = await Quotation.findById(q._id);
    expect(released.status).toBe('approved');
    expect(released.convertedInvoiceId).toBeUndefined();
    expect(released.conversionHistory).toHaveLength(1);
    expect(released.conversionHistory[0]).toMatchObject({ invoiceNumber: first.invoiceNumber, releasedReason: 'invoice_deleted' });

    const second = await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {});
    expect(second.status).toBe(201);
    expect(second.body.data.invoice.invoiceNumber).not.toBe(first.invoiceNumber);
    expect((await Quotation.findById(q._id)).conversionHistory).toHaveLength(2);
  });

  test('cancelling the invoice releases the quotation and keeps the cancelled invoice', async () => {
    const q = await quote();
    const inv = (await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).body.data.invoice;
    const cancel = await request(app).patch(`/api/invoices/${inv._id}/cancel`).set(auth(org.tokens.admin)).send({ reason: 'Customer changed mind' });
    expect(cancel.status).toBe(200);
    expect((await Quotation.findById(q._id)).status).toBe('approved');
    expect((await Invoice.findById(inv._id)).status).toBe('cancelled');
  });

  test('simultaneous conversions create exactly one invoice', async () => {
    const q = await quote();
    const before = await Invoice.countDocuments({ customerId: cust._id });
    const results = await Promise.all(Array.from({ length: 6 }, () => admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c !== 201).every((c) => c === 409)).toBe(true);
    expect(await Invoice.countDocuments({ customerId: cust._id })).toBe(before + 1);
    const stored = await Quotation.findById(q._id);
    expect(stored.status).toBe('converted');
    expect(stored.conversionLockAt).toBeUndefined();
    expect(stored.conversionHistory).toHaveLength(1);
    // A retry after success is a clean 409 pointing at the existing invoice.
    const retry = await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {});
    expect(retry.status).toBe(409);
    expect(retry.body.data.invoiceNumber).toBe(stored.convertedInvoiceNumber);
  });

  test('a failed conversion leaves no invoice and no lock, and can be retried', async () => {
    const q = await quote();
    const before = await Invoice.countDocuments({ customerId: cust._id });
    const spy = jest.spyOn(Invoice, 'createNumbered').mockRejectedValueOnce(new Error('disk full'));
    const failed = await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {});
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(await Invoice.countDocuments({ customerId: cust._id })).toBe(before);
    const mid = await Quotation.findById(q._id);
    expect(mid.status).toBe('approved');
    expect(mid.conversionLockAt).toBeUndefined();
    expect((await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).status).toBe(201);
  });

  test('a fresh claim by another request blocks conversion; a stale one does not', async () => {
    const q = await quote();
    await Quotation.updateOne({ _id: q._id }, { $set: { conversionLockAt: new Date() } });
    const blocked = await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('CONVERSION_IN_PROGRESS');
    await Quotation.updateOne({ _id: q._id }, { $set: { conversionLockAt: new Date(Date.now() - 5 * 60 * 1000) } });
    expect((await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).status).toBe(201);
  });

  test('issued invoice: cancel through the workflow, keep it, never reuse its number, only one active invoice', async () => {
    const q = await quote();
    const first = (await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).body.data.invoice;
    const issued = await request(app).patch(`/api/invoices/${first._id}/issue`).set(auth(org.tokens.admin));
    expect(issued.status).toBe(200);
    const issuedNumber = (await Invoice.findById(first._id)).invoiceNumber;
    expect(issuedNumber).toMatch(/^INV-/);

    // While the first is active, converting again is refused.
    expect((await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).status).toBe(409);

    // Payments must come off before cancelling.
    const Payment = require('../src/models/Payment');
    const paid = await request(app).post('/api/payments').set(auth(org.tokens.admin)).send({ customerId: String(cust._id), invoiceId: String(first._id), amount: 100, paymentMethod: 'cash', idempotencyKey: `k-${Date.now()}` });
    expect(paid.status).toBe(201);
    const blocked = await request(app).patch(`/api/invoices/${first._id}/cancel`).set(auth(org.tokens.admin)).send({ reason: 'x' });
    expect(blocked.status).toBe(409);
    expect((await Quotation.findById(q._id)).status).toBe('converted');
    await request(app).put(`/api/payments/${paid.body.data.payment._id}/allocations`).set(auth(org.tokens.admin)).send({ allocations: [] });
    expect(await Payment.countDocuments({ _id: paid.body.data.payment._id })).toBe(1);

    const cancel = await request(app).patch(`/api/invoices/${first._id}/cancel`).set(auth(org.tokens.admin)).send({ reason: 'Wrong rate' });
    expect(cancel.status).toBe(200);
    const kept = await Invoice.findById(first._id);
    expect(kept.status).toBe('cancelled');
    expect(kept.invoiceNumber).toBe(issuedNumber);

    const second = (await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {})).body.data.invoice;
    expect(second.invoiceNumber).not.toBe(issuedNumber);
    const active = await Invoice.countDocuments({ _id: { $in: [first._id, second._id] }, status: { $ne: 'cancelled' } });
    expect(active).toBe(1);
    const stored = await Quotation.findById(q._id);
    expect(String(stored.convertedInvoiceId)).toBe(String(second._id));
    expect(stored.conversionHistory.map((h) => h.invoiceNumber)).toEqual([issuedNumber, second.invoiceNumber]);
    expect(stored.conversionHistory[0].releasedReason).toBe('invoice_cancelled');
  });
});

test('a blank GST rate is refused rather than treated as 0%; an explicit 0 is accepted', async () => {
  const body = (rate) => ({ customer_id: String(cust._id), gst_type: 'gst', items: [{ item_name: 'Card', quantity: 1, unit_price: 100, tax_rate: rate }] });
  const blank = await admin().post('/api/quotations', body(''));
  expect(blank.status).toBe(400);
  expect(JSON.stringify(blank.body)).toMatch(/blank rate/);
  const zero = await admin().post('/api/quotations', body(0));
  expect(zero.status).toBe(201);
});
