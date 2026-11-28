/**
 * The paper on a job ticket, picked from stock with a number of sheets:
 *
 *  - the job keeps the paper and its sheets in its print specification, and
 *    the paper as a line priced sheets × rate per sheet;
 *  - the job's invoice bills that line and takes the sheets out of the same
 *    stock item the paper was bought into;
 *  - more sheets than are in stock is refused, and nothing is taken;
 *  - a sheet count that is not a positive number is refused.
 */
const request = require('supertest');
const app = require('../src/app');
const Inventory = require('../src/models/Inventory');
const Invoice = require('../src/models/Invoice');
const InventoryMovement = require('../src/models/InventoryMovement');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let cust;
const admin = () => ({
  get: (url) => request(app).get(url).set(auth(org.tokens.admin)),
  post: (url, body) => request(app).post(url).set(auth(org.tokens.admin)).send(body)
});

// What the job dialog sends for "Art Card 300 GSM" × 250 sheets at ₹6 a sheet, 12% GST.
const paperJob = (paper, sheets, extra = {}) => ({
  title: 'Visiting cards',
  customerId: String(cust._id),
  printSpecs: { quantity: 1000, paperType: paper.name, sheets },
  items: [{ itemName: paper.name, quantity: sheets, unitPrice: 6, gstRate: 12, unit: 'sheets', itemType: 'Numbers' }],
  ...extra
});

beforeAll(async () => {
  await connectTestDb('job_paper_sheets');
  await Invoice.init();
  org = await createOrg('paper');
  cust = await make.customer(org.admin);
});
afterAll(disconnectTestDb);

test('the job keeps the paper, its sheets and the priced paper line', async () => {
  const paper = await make.stockItem(org.admin, { name: 'Art Card 300 GSM', unit: 'sheets', quantity: 1000, unitCost: 4, sellingPrice: 6, gstRate: 12 });
  const res = await admin().post('/api/jobs', paperJob(paper, 250));
  expect(res.status).toBe(201);
  const job = res.body.data.job;
  expect(job.printSpecs).toMatchObject({ paperType: 'Art Card 300 GSM', sheets: 250 });
  expect(job.items[0]).toMatchObject({ itemName: 'Art Card 300 GSM', quantity: 250, unitPrice: 6 });
  // 250 × ₹6 = ₹1,500 + 12% GST.
  expect(job.items[0].itemTotal).toBe(1680);
});

test("the job's invoice bills the sheets and takes them out of the paper's stock", async () => {
  const paper = await make.stockItem(org.admin, { name: 'Art Card 350 GSM', unit: 'sheets', quantity: 1000, unitCost: 5, sellingPrice: 7, gstRate: 12 });
  const job = (await admin().post('/api/jobs', paperJob(paper, 300))).body.data.job;

  const invoice = await admin().post('/api/invoices', {
    customerId: String(cust._id),
    jobId: job._id,
    status: 'sent',
    items: job.items.map(({ itemName, quantity, unitPrice, gstRate, unit, itemType }) => ({ itemName, quantity, unitPrice, gstRate, unit, itemType }))
  });
  expect(invoice.status).toBe(201);
  expect(invoice.body.data.invoice.items[0]).toMatchObject({ itemName: 'Art Card 350 GSM', quantity: 300 });

  expect((await Inventory.findById(paper._id)).quantity).toBe(700);
  const movement = await InventoryMovement.findOne({ inventoryItem: paper._id, movementType: 'sale' }).lean();
  expect(movement).toMatchObject({ quantity: 300, previousQuantity: 1000, newQuantity: 700, unit: 'sheets' });
});

test('more sheets than are in stock is refused and nothing is taken', async () => {
  const paper = await make.stockItem(org.admin, { name: 'Duplex Board 300 GSM', unit: 'sheets', quantity: 100, unitCost: 3, sellingPrice: 5, gstRate: 12 });
  const job = (await admin().post('/api/jobs', paperJob(paper, 150))).body.data.job;
  const invoice = await admin().post('/api/invoices', {
    customerId: String(cust._id),
    jobId: job._id,
    status: 'sent',
    items: [{ itemName: paper.name, quantity: 150, unitPrice: 5, gstRate: 12, unit: 'sheets', itemType: 'Numbers' }]
  });
  expect(invoice.status).toBeGreaterThanOrEqual(400);
  expect((await Inventory.findById(paper._id)).quantity).toBe(100);
});

test('a sheet count that is not a positive number is refused', async () => {
  const paper = await make.stockItem(org.admin, { name: 'Art Paper 170 GSM', unit: 'sheets', quantity: 500, unitCost: 2, sellingPrice: 3 });
  const res = await admin().post('/api/jobs', paperJob(paper, 10, { printSpecs: { paperType: paper.name, sheets: -5 } }));
  expect(res.status).toBe(400);
});

test('a job without sheets is saved as before', async () => {
  const res = await admin().post('/api/jobs', { title: 'Letterheads', customerId: String(cust._id), printSpecs: { paperType: 'Bond 100 GSM' } });
  expect(res.status).toBe(201);
  expect(res.body.data.job.printSpecs.paperType).toBe('Bond 100 GSM');
  expect(res.body.data.job.printSpecs.sheets).toBeUndefined();
});
