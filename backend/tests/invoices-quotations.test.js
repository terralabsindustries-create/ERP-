/**
 * Invoices and quotations without GST: dimensions and the design charge on
 * create and edit, quotation → invoice conversion, the PDF contents, and the
 * design charge report.
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

describe('creating an invoice', () => {
  let invoice;

  test('prices dimension lines by area × quantity, adds the design charge, and charges no GST', async () => {
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
    expect(invoice).toMatchObject({
      subtotal: 3130,
      designCharge: 500,
      discountAmount: 30,
      taxableAmount: 3600,
      totalGstAmount: 0,
      totalCgstAmount: 0,
      totalIgstAmount: 0,
      totalAmount: 3600,
      balanceAmount: 3600,
      isInterState: false,
      noGst: false
    });
    expect(invoice.items[0]).toMatchObject({ unit: 'sqft', itemType: 'Square Feet', length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 240, quantity: 10, unitPrice: 12, totalAmount: 2880, gstRate: 0, gstAmount: 0 });
    expect(invoice.items[1]).toMatchObject({ itemType: 'Numbers', quantity: 100, totalAmount: 250, gstRate: 0 });
  });

  test("takes a job ticket's design charge object, using its amount before tax", async () => {
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [cardLine], designCharge: { amount: 750, gstRate: 18, totalAmount: 885 } });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ designCharge: 750, totalAmount: 1000 });
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

  test('the PDF shows the size, area, pieces and rate per sq ft, and the design charge as its own line', async () => {
    const stored = await Invoice.findById(invoice._id);
    const d = PDFService.invoiceDocument(stored.toObject({ virtuals: true }), company);
    expect(d.items[0]).toMatchObject({ description: 'Flex banner', sub: 'Star flex, eyelets', size: '6 × 4 ft', sizeSub: '24 sq ft each', area: '240 sq ft', qty: '10', rate: '12.00', rateSub: 'per sq ft', amount: '2,880.00' });
    expect(d.items[1]).toMatchObject({ size: '', area: '', qty: '100', amount: '250.00' });
    expect(d.summary.map((s) => s.label)).toEqual(['Subtotal', 'Design Charge', 'Discount', 'Total']);
    expect(d.summary.find((s) => s.label === 'Design Charge').value).toBe('INR 500.00');
    expect(d.summary.find((s) => s.label === 'Total').value).toBe('INR 3,600.00');

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

  test('will not bring the total below what has been paid', async () => {
    await Invoice.updateOne({ _id: id }, { paidAmount: 1000, paymentStatus: 'partial', status: 'sent' });
    const res = await admin().put(`/api/invoices/${id}`, { designCharge: 0, items: [{ ...cardLine, quantity: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already paid/);
  });

  test('a total brought down to what was paid settles the invoice', async () => {
    const res = await admin().put(`/api/invoices/${id}`, { items: [{ ...cardLine, quantity: 260 }], designCharge: 350, discountAmount: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toMatchObject({ totalAmount: 1000, balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
  });
});

describe('invoices issued with GST before it was removed', () => {
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
    expect(d.summary.find((s) => s.label === 'GST').value).toBe('INR 180.00');
    expect(d.items[0].amount).toBe('1,000.00');
  });

  test('a notes-only edit keeps the GST; re-pricing the lines drops it', async () => {
    const notes = await admin().put(`/api/invoices/${legacy._id}`, { notes: 'Checked' });
    expect(notes.body.data.invoice.totalAmount).toBe(1180);
    const repriced = await admin().put(`/api/invoices/${legacy._id}`, { items: [{ itemName: 'Line 1', quantity: 1, unitPrice: 1000 }] });
    expect(repriced.status).toBe(200);
    expect(repriced.body.data.invoice).toMatchObject({ totalGstAmount: 0, totalCgstAmount: 0, totalAmount: 1000, balanceAmount: 820 });
  });
});

describe('quotations', () => {
  let quotation;

  test('are priced like invoices: area × quantity, a separate design charge, no GST', async () => {
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
    expect(quotation).toMatchObject({ gst_type: 'non_gst', subtotal: 3780, design_charge: 600, tax_amount: 0, total_amount: 4380 });
    expect(quotation.items[0]).toMatchObject({ length: 6, width: 4, area_per_piece: 24, total_area: 240, total_amount: 2880, tax_rate: 0, tax_amount: 0 });
  });

  test('refuse a negative design charge', async () => {
    const res = await admin().post('/api/quotations', { customer_id: String(cust._id), items: [{ item_name: 'Standee', quantity: 1, unit_price: 450 }], design_charge: -5 });
    expect(res.status).toBe(400);
  });

  test('the PDF shows the dimensions and the design charge', async () => {
    const stored = await Quotation.findById(quotation._id).populate('customer_id');
    const d = PDFService.quotationDocument(stored, company);
    expect(d.items[0]).toMatchObject({ size: '6 × 4 ft', sizeSub: '24 sq ft each', area: '240 sq ft', qty: '10', rateSub: 'per sq ft', amount: '2,880.00' });
    expect(d.summary.map((s) => s.label)).toEqual(['Subtotal', 'Design Charge', 'Total']);
    expect(d.customer.lines.join(' ')).not.toMatch(/GST:|Non-GST/);
    const pdf = await PDFService.generateQuotationPDF(stored, company);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('convert to an invoice with the same lines, dimensions, design charge and total', async () => {
    const res = await admin().post(`/api/quotations/${quotation._id}/convert-to-invoice`, {});
    expect(res.status).toBe(201);
    const inv = res.body.data.invoice;
    expect(inv).toMatchObject({ designCharge: 600, subtotal: 3780, totalAmount: 4380, totalGstAmount: 0, status: 'draft', noGst: false });
    expect(inv.items).toHaveLength(2);
    expect(inv.items[0]).toMatchObject({ itemName: 'Flex banner', description: 'Star flex', unit: 'sqft', itemType: 'Square Feet', length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 240, quantity: 10, unitPrice: 12, totalAmount: 2880 });
    expect(inv.items[1]).toMatchObject({ itemName: 'Standee', quantity: 2, totalAmount: 900 });
    expect(res.body.data.quotation).toMatchObject({ status: 'converted', convertedInvoiceNumber: inv.invoiceNumber });

    const again = await admin().post(`/api/quotations/${quotation._id}/convert-to-invoice`, {});
    expect(again.status).toBe(409);
  });

  test('one written with GST converts at its prices before tax', async () => {
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
    expect(d.summary.find((s) => s.label === 'GST').value).toBe('INR 180.00');

    const res = await admin().post(`/api/quotations/${old._id}/convert-to-invoice`, {});
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ subtotal: 1000, designCharge: 0, totalGstAmount: 0, totalAmount: 1000 });
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
