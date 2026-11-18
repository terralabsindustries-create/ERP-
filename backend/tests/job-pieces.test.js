/**
 * Number of pieces on job ticket items priced by area (flex prints):
 *   area per piece = length × width; total area = area per piece × pieces;
 *   amount = total area × rate per sq ft (or sq m); GST on top.
 * The pieces are saved on the job and carried, with the size and amount, into
 * the invoice raised from it. Items priced per unit are not area-priced.
 */
const request = require('supertest');
const app = require('../src/app');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const PDFService = require('../src/services/PDFService');

let org;
let cust;
const api = () => ({
  get: (url) => request(app).get(url).set(auth(org.tokens.admin)),
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body)
});
const flex = (extra = {}) => ({ itemName: 'Flex print', itemType: 'Square Feet', unit: 'sqft', length: 6, width: 4, unitPrice: 12, gstRate: 18, ...extra });
const createJob = (items, extra = {}) => api().post('/api/jobs', { title: 'Shop banner', customerId: String(cust._id), items, ...extra });
// What the Create invoice dialogs send for a job's items (lineDraftFromJobItem → lineInput).
const invoiceFor = (job, extra = {}) => api().post('/api/invoices', {
  jobId: String(job._id),
  customerId: String(cust._id),
  items: job.items.map((i) => ({ itemName: i.itemName, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, length: i.length, width: i.width, gstRate: i.gstRate })),
  status: 'sent',
  ...extra
});

beforeAll(async () => {
  await connectTestDb('job_pieces');
  org = await createOrg('pieces');
  cust = await make.customer(org.admin, { name: 'Lotus Events' });
});
afterAll(disconnectTestDb);

describe('a flex item on a job ticket', () => {
  test('1 piece: 6 × 4 ft = 24 sq ft @ ₹12 = ₹288 + 18% GST', async () => {
    const res = await createJob([flex({ quantity: 1 })]);
    expect(res.status).toBe(201);
    expect(res.body.data.job.items[0]).toMatchObject({ quantity: 1, totalSquareFeet: 24, itemTotal: 339.84 });
  });

  test('2 pieces: 48 sq ft @ ₹12 = ₹576 + 18% GST, saved and read back', async () => {
    const res = await createJob([flex({ quantity: 2 })]);
    expect(res.status).toBe(201);
    const saved = (await api().get(`/api/jobs/${res.body.data.job._id}`)).body.data.job;
    expect(saved.items[0]).toMatchObject({ quantity: 2, length: 6, width: 4, totalSquareFeet: 48, itemTotal: 679.68 });
  });

  test('the server works out area and total from the pieces, whatever the client sent', async () => {
    const res = await createJob([flex({ quantity: 3, totalSquareFeet: 24, itemTotal: 1 })]);
    expect(res.body.data.job.items[0]).toMatchObject({ quantity: 3, totalSquareFeet: 72, itemTotal: round2(72 * 12 * 1.18) });
  });

  test('pieces left out count as 1', async () => {
    const { quantity, ...noPieces } = flex();
    expect(quantity).toBeUndefined();
    const res = await createJob([noPieces]);
    expect(res.status).toBe(201);
    expect(res.body.data.job.items[0]).toMatchObject({ quantity: 1, totalSquareFeet: 24 });
  });

  test.each([[0], [-1], [1.5], ['two']])('refuses %p pieces', async (pieces) => {
    const res = await createJob([flex({ quantity: pieces })]);
    expect(res.status).toBe(400);
    expect(res.body.message || JSON.stringify(res.body)).toMatch(/pieces/);
  });

  test('sq m items use metres the same way', async () => {
    const res = await createJob([flex({ unit: 'sqm', length: 2, width: 1.5, quantity: 4, unitPrice: 100, gstRate: 0 })]);
    expect(res.body.data.job.items[0]).toMatchObject({ unit: 'sqm', totalSquareFeet: 12, itemTotal: 1200 });
  });

  test('an item priced per unit is never area-priced, even with a size', async () => {
    const res = await createJob([{ itemName: 'Visiting cards', itemType: 'Numbers', unit: 'pieces', quantity: 100, unitPrice: 2.5, gstRate: 12, length: 6, width: 4 }]);
    expect(res.body.data.job.items[0]).toMatchObject({ quantity: 100, totalSquareFeet: 0, itemTotal: 280 });
  });
});

describe('the invoice raised from it', () => {
  test('keeps the pieces, size, area and amount, with GST and a discount', async () => {
    const job = (await createJob([
      flex({ quantity: 2 }),
      { itemName: 'Visiting cards', itemType: 'Numbers', unit: 'pieces', quantity: 100, unitPrice: 2.5, gstRate: 12 }
    ])).body.data.job;
    const res = await invoiceFor(job, { discountAmount: 26 });
    expect(res.status).toBe(201);
    const inv = res.body.data.invoice;
    expect(inv.items[0]).toMatchObject({ quantity: 2, length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 48, totalAmount: 576, itemType: 'Square Feet' });
    expect(inv.items[1]).toMatchObject({ quantity: 100, totalAmount: 250, itemType: 'Numbers' });
    // 576 + 250 = 826, less 26 = 800 taxable; the discount is shared by value.
    expect(inv).toMatchObject({ subtotal: 826, discountAmount: 26 });
    expect(inv.taxableAmount).toBe(800);
    const gst = round2(inv.items.reduce((s, i) => s + i.gstAmount, 0));
    expect(inv.totalAmount).toBe(round2(800 + gst));

    // Viewing it and its PDF use the same stored line.
    const viewed = (await api().get(`/api/invoices/${inv._id}`)).body.data.invoice;
    expect(viewed.items[0]).toMatchObject({ quantity: 2, totalSquareFeet: 48, totalAmount: 576 });
    // The printed / downloaded PDF row: the size, the area of one piece, the
    // pieces, the total area, the rate per sq ft and the amount.
    const doc = PDFService.invoiceDocument({ ...viewed, customerId: { name: cust.name } }, { name: 'Test Printers', currency: 'INR', addressLines: [] });
    expect(doc.items[0]).toMatchObject({ size: '6 × 4 ft', sizeSub: '24 sq ft each', qty: '2', area: '48 sq ft', rateSub: 'per sq ft', amount: '576.00' });
  });
});

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
