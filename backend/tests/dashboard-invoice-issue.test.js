const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const Settings = require('../src/models/Settings');
const PDFService = require('../src/services/PDFService');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let customer;

beforeAll(async () => {
  await connectTestDb('dashboard_invoice_issue');
  org = await createOrg('dashboard_invoice_issue');
  customer = await make.customer(org.admin);
});

afterAll(disconnectTestDb);

test('drafts appear on the dashboard but enter revenue and receivables only when issued', async () => {
  const draft = await make.invoice(org.admin, customer, { status: 'draft' });
  const amount = draft.totalAmount;
  const stats = () => request(app).get('/api/dashboard/stats').set(auth(org.tokens.admin));

  const before = await stats();
  expect(before.status).toBe(200);
  expect(before.body.stats).toMatchObject({ draftInvoices: 1, invoicedThisMonth: 0, receivables: 0 });

  const issued = await request(app).patch(`/api/invoices/${draft._id}/issue`).set(auth(org.tokens.admin)).send({});
  expect(issued.status).toBe(200);
  expect(issued.body.data.invoice.status).toBe('sent');
  expect((await Invoice.findById(draft._id)).status).toBe('sent');

  const after = await stats();
  expect(after.status).toBe(200);
  expect(after.body.stats).toMatchObject({ draftInvoices: 0, invoicedThisMonth: amount, receivables: amount, unpaidInvoices: 1 });

  const again = await request(app).patch(`/api/invoices/${draft._id}/issue`).set(auth(org.tokens.admin)).send({});
  expect(again.status).toBe(409);
});

test('a successfully emailed draft becomes issued', async () => {
  const settings = await Settings.getOrCreateSettings(org.admin._id);
  settings.companyName = 'Test Printers';
  await settings.save();
  const draft = await make.invoice(org.admin, customer, { status: 'draft' });
  const pdf = jest.spyOn(PDFService, 'generateInvoicePDFFromHTML').mockResolvedValue(Buffer.from('test pdf'));
  const email = jest.spyOn(PDFService, 'sendInvoiceEmail').mockResolvedValue(undefined);

  try {
    const sent = await request(app)
      .post(`/api/invoices/${draft._id}/send-email`)
      .set(auth(org.tokens.admin))
      .send({ email: 'customer@example.test' });
    expect(sent.status).toBe(200);
    expect(sent.body.data.issueStatusUpdated).toBe(true);
    expect((await Invoice.findById(draft._id)).status).toBe('sent');
    expect(email).toHaveBeenCalledTimes(1);
  } finally {
    pdf.mockRestore();
    email.mockRestore();
  }
});
