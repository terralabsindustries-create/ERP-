/**
 * Financial document lifecycle: draft identifiers, official numbers given on
 * issue, issued invoices locked against edits and deletion, and GST credit /
 * debit notes that adjust what the customer owes.
 */
const request = require('supertest');
const app = require('../src/app');
const Invoice = require('../src/models/Invoice');
const CreditNote = require('../src/models/CreditNote');
const User = require('../src/models/User');
const Settings = require('../src/models/Settings');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const { financialYearOf } = require('../src/utils/financialYear');

let org;
let other;
let cust;

const as = (token) => ({
  get: (u) => request(app).get(u).set(auth(token)),
  post: (u, b) => request(app).post(u).set(auth(token)).send(b),
  put: (u, b) => request(app).put(u).set(auth(token)).send(b),
  patch: (u, b) => request(app).patch(u).set(auth(token)).send(b || {}),
  del: (u) => request(app).delete(u).set(auth(token))
});
const admin = () => as(org.tokens.admin);
const line = (itemName, quantity, unitPrice, gstRate = 18) => ({ itemName, quantity, unitPrice, gstRate });
const thisMonth = () => {
  const d = new Date();
  return `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-`;
};

beforeAll(async () => {
  await connectTestDb('lifecycle');
  org = await createOrg('lc');
  other = await createOrg('lco');
  cust = await make.customer(org.admin, { name: 'Lifecycle Customer' });
  const settings = await Settings.getOrCreateSettings(org.admin._id);
  settings.companyName = 'Lifecycle Printers';
  await settings.save();
  await CreditNote.init(); // the idempotency index, as the server builds at start
});
afterAll(disconnectTestDb);

describe('invoice numbering', () => {
  test('a draft gets a draft identifier, not an official invoice number', async () => {
    const res = await admin().post('/api/invoices', { customerId: String(cust._id), items: [line('Cards', 100, 2)] });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.status).toBe('draft');
    expect(res.body.data.invoice.invoiceNumber).toMatch(/^DRAFT-\d{5}$/);
  });

  test('abandoned drafts leave no gap: issued numbers stay consecutive', async () => {
    const o = await createOrg('lcn');
    const c = await make.customer(o.admin);
    const api = as(o.tokens.admin);
    const d1 = (await api.post('/api/invoices', { customerId: String(c._id), items: [line('A', 1, 100)] })).body.data.invoice;
    await api.post('/api/invoices', { customerId: String(c._id), items: [line('B', 1, 100)] }); // stays a draft
    const d3 = (await api.post('/api/invoices', { customerId: String(c._id), items: [line('C', 1, 100)] })).body.data.invoice;
    const i1 = await api.patch(`/api/invoices/${d1._id}/issue`);
    const i3 = await api.patch(`/api/invoices/${d3._id}/issue`);
    expect(i1.body.data.invoice.invoiceNumber).toBe(`${thisMonth()}0001`);
    expect(i3.body.data.invoice.invoiceNumber).toBe(`${thisMonth()}0002`);
    expect(i1.body.data.invoice.draftNumber).toMatch(/^DRAFT-/);
    expect(i1.body.data.invoice.issuedAt).toBeTruthy();
  });

  test('issuing many drafts at once gives each its own consecutive number', async () => {
    const o = await createOrg('lcc');
    const c = await make.customer(o.admin);
    const api = as(o.tokens.admin);
    const drafts = [];
    for (let i = 0; i < 10; i += 1) drafts.push((await api.post('/api/invoices', { customerId: String(c._id), items: [line('X', 1, 10)] })).body.data.invoice);
    const results = await Promise.all(drafts.map((d) => api.patch(`/api/invoices/${d._id}/issue`)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    const numbers = results.map((r) => r.body.data.invoice.invoiceNumber).sort();
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `${thisMonth()}${String(i + 1).padStart(4, '0')}`));
  });

  test('the same draft issued twice at once is numbered once', async () => {
    const d = (await admin().post('/api/invoices', { customerId: String(cust._id), items: [line('Twice', 1, 10)] })).body.data.invoice;
    const [a, b] = await Promise.all([admin().patch(`/api/invoices/${d._id}/issue`), admin().patch(`/api/invoices/${d._id}/issue`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test('a legacy draft that already holds an official number keeps it when issued', async () => {
    const legacy = await make.invoice(org.admin, cust, { status: 'draft', invoiceNumber: `${thisMonth()}0900` });
    const res = await admin().patch(`/api/invoices/${legacy._id}/issue`);
    expect(res.status).toBe(200);
    expect(res.body.data.invoice.invoiceNumber).toBe(`${thisMonth()}0900`);
  });
});

describe('issued invoices are protected', () => {
  let issued;
  beforeAll(async () => {
    const d = (await admin().post('/api/invoices', { customerId: String(cust._id), items: [line('Posters', 10, 100)] })).body.data.invoice;
    issued = (await admin().patch(`/api/invoices/${d._id}/issue`)).body.data.invoice;
  });

  test('amounts, customer and date cannot be edited', async () => {
    for (const body of [{ items: [line('Posters', 5, 100)] }, { discountAmount: 50 }, { invoiceDate: '2026-01-01' }, { isInterState: true }]) {
      const res = await admin().put(`/api/invoices/${issued._id}`, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVOICE_ISSUED_LOCKED');
    }
    expect((await Invoice.findById(issued._id)).totalAmount).toBe(1180);
  });

  test('notes and terms can still be changed', async () => {
    const res = await admin().put(`/api/invoices/${issued._id}`, { notes: 'Deliver to gate 2' });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toMatchObject({ notes: 'Deliver to gate 2', totalAmount: 1180 });
  });

  test('cannot be deleted, only cancelled — keeping the number', async () => {
    const del = await admin().del(`/api/invoices/${issued._id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('INVOICE_ISSUED_NOT_DELETABLE');
    const cancelled = await admin().patch(`/api/invoices/${issued._id}/cancel`, { reason: 'Raised in error' });
    expect(cancelled.status).toBe(200);
    const after = await Invoice.findById(issued._id).lean();
    expect(after).toMatchObject({ status: 'cancelled', invoiceNumber: issued.invoiceNumber, cancellationReason: 'Raised in error' });
    expect(String(after.cancelledBy)).toBe(String(org.admin._id));
  });

  test('a draft can be edited and deleted', async () => {
    const d = (await admin().post('/api/invoices', { customerId: String(cust._id), items: [line('Draft', 1, 100)] })).body.data.invoice;
    expect((await admin().put(`/api/invoices/${d._id}`, { items: [line('Draft', 2, 100)] })).body.data.invoice.totalAmount).toBe(236);
    expect((await admin().del(`/api/invoices/${d._id}`)).status).toBe(200);
    expect(await Invoice.findById(d._id)).toBeNull();
  });
});

describe('credit and debit notes', () => {
  let invoice;
  let lineRef;

  beforeAll(async () => {
    const d = (await admin().post('/api/invoices', { customerId: String(cust._id), items: [line('Brochures', 1000, 5), line('Stickers', 100, 2, 12)] })).body.data.invoice;
    invoice = (await admin().patch(`/api/invoices/${d._id}/issue`)).body.data.invoice;
    lineRef = String(invoice.items[0]._id);
    // Brochures 5000 + 900 GST; stickers 200 + 24 GST = 6124
    expect(invoice.totalAmount).toBe(6124);
  });

  test('cannot be raised against a draft or another business\'s invoice', async () => {
    const d = (await admin().post('/api/invoices', { customerId: String(cust._id), items: [line('X', 1, 10)] })).body.data.invoice;
    const res = await admin().post('/api/credit-notes', { noteType: 'credit', invoiceId: d._id, reason: 'sales_return', full: true });
    expect(res.status).toBe(409);
    const foreign = await as(other.tokens.admin).post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'sales_return', full: true });
    expect(foreign.status).toBe(404);
  });

  test('a partial credit note is priced at the line\'s GST rate and gets its number only on issue', async () => {
    const res = await admin().post('/api/credit-notes', {
      noteType: 'credit', invoiceId: invoice._id, reason: 'sales_return',
      items: [{ invoiceLineRef: lineRef, quantity: 100, taxableValue: 500 }]
    });
    expect(res.status).toBe(201);
    const note = res.body.data.note;
    expect(note).toMatchObject({ status: 'draft', taxableAmount: 500, totalCgstAmount: 45, totalSgstAmount: 45, totalGstAmount: 90, totalAmount: 590 });
    expect(note.noteNumber).toMatch(/^DRAFT-CN-/);

    const issued = await admin().patch(`/api/credit-notes/${note._id}/issue`);
    expect(issued.status).toBe(200);
    const fy = financialYearOf(new Date()).code;
    expect(issued.body.data.note.noteNumber).toBe(`CN-${fy}-0001`);
    expect(issued.body.data.note).toMatchObject({ status: 'issued', appliedToInvoice: 590, unappliedAmount: 0 });
    expect(issued.body.data.invoice).toMatchObject({ balanceAmount: 5534 });
    const inv = await Invoice.findById(invoice._id);
    expect(inv).toMatchObject({ totalAmount: 6124, creditNoteApplied: 590, balanceAmount: 5534, paymentStatus: 'pending' });
  });

  test('cannot credit more than is left of a line, nor return more than was sold', async () => {
    const tooMuch = await admin().post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'price_revision', items: [{ invoiceLineRef: lineRef, taxableValue: 4600 }] });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.code).toBe('EXCEEDS_LINE');
    expect(tooMuch.body.details.creditable).toBe(4500);
    const qty = await admin().post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'sales_return', items: [{ invoiceLineRef: lineRef, quantity: 901, taxableValue: 10 }] });
    expect(qty.body.code).toBe('EXCEEDS_QUANTITY');
  });

  test('two drafts that together exceed the line: the second fails on issue', async () => {
    const a = (await admin().post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'post_sale_discount', items: [{ invoiceLineRef: lineRef, taxableValue: 3000 }] })).body.data.note;
    const b = (await admin().post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'post_sale_discount', items: [{ invoiceLineRef: lineRef, taxableValue: 3000 }] })).body.data.note;
    expect((await admin().patch(`/api/credit-notes/${a._id}/issue`)).status).toBe(200);
    const second = await admin().patch(`/api/credit-notes/${b._id}/issue`);
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('EXCEEDS_LINE');
    expect((await CreditNote.findById(b._id)).status).toBe('draft');
    // Undo the first for the tests below.
    expect((await admin().patch(`/api/credit-notes/${a._id}/cancel`, { reason: 'test cleanup' })).status).toBe(200);
    await admin().del(`/api/credit-notes/${b._id}`);
    expect((await Invoice.findById(invoice._id)).balanceAmount).toBe(5534);
  });

  test('a repeated create with the same idempotency key makes one note', async () => {
    const body = { noteType: 'credit', invoiceId: invoice._id, reason: 'excess_charged', items: [{ invoiceLineRef: lineRef, taxableValue: 10 }], idempotencyKey: 'abc-123' };
    const [x, y] = await Promise.all([admin().post('/api/credit-notes', body), admin().post('/api/credit-notes', body)]);
    expect(String(x.body.data.note._id)).toBe(String(y.body.data.note._id));
    expect(await CreditNote.countDocuments({ idempotencyKey: 'abc-123' })).toBe(1);
    await admin().del(`/api/credit-notes/${x.body.data.note._id}`);
  });

  test('an issued note cannot be edited or deleted', async () => {
    const issued = await CreditNote.findOne({ invoiceId: invoice._id, status: 'issued' });
    expect((await admin().put(`/api/credit-notes/${issued._id}`, { notes: 'x' })).body.code).toBe('NOTE_LOCKED');
    expect((await admin().del(`/api/credit-notes/${issued._id}`)).body.code).toBe('NOTE_LOCKED');
  });

  test('a debit note raises what is owed; payments then settle it', async () => {
    const res = await admin().post('/api/credit-notes', { noteType: 'debit', invoiceId: invoice._id, reason: 'short_charged', items: [{ invoiceLineRef: lineRef, taxableValue: 100 }] });
    expect(res.status).toBe(201);
    const issued = await admin().patch(`/api/credit-notes/${res.body.data.note._id}/issue`);
    expect(issued.body.data.note.noteNumber).toMatch(/^DN-\d{4}-0001$/);
    expect((await Invoice.findById(invoice._id)).balanceAmount).toBe(5652); // 5534 + 118
    const pay = await admin().post('/api/payments', { customerId: String(cust._id), invoiceId: String(invoice._id), amount: 5652, paymentMethod: 'cash' });
    expect(pay.status).toBe(201);
    expect(await Invoice.findById(invoice._id)).toMatchObject({ balanceAmount: 0, paymentStatus: 'paid', status: 'paid' });
  });

  test('a credit note on a paid invoice is kept as customer credit, never a negative balance', async () => {
    const stickers = String(invoice.items[1]._id);
    const res = await admin().post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'deficiency_in_service', items: [{ invoiceLineRef: stickers, taxableValue: 50 }] });
    const issued = await admin().patch(`/api/credit-notes/${res.body.data.note._id}/issue`);
    expect(issued.body.data.note).toMatchObject({ totalAmount: 56, appliedToInvoice: 0, unappliedAmount: 56 });
    expect(await Invoice.findById(invoice._id)).toMatchObject({ balanceAmount: 0, paymentStatus: 'paid' });
  });

  test('a debit note cannot be cancelled while payments cover it', async () => {
    const dn = await CreditNote.findOne({ invoiceId: invoice._id, noteType: 'debit', status: 'issued' });
    const res = await admin().patch(`/api/credit-notes/${dn._id}/cancel`, { reason: 'mistake' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAID_EXCEEDS_TOTAL');
  });

  test('need the Credit & Debit Notes permission to raise one', async () => {
    await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Invoicing', 'Invoicing: View', 'Invoicing: Create & Edit'] });
    const res = await as(org.tokens.staff1).post('/api/credit-notes', { noteType: 'credit', invoiceId: invoice._id, reason: 'sales_return', full: true });
    expect(res.status).toBe(403);
    const list = await as(org.tokens.staff1).get(`/api/credit-notes?invoiceId=${invoice._id}`);
    expect(list.status).toBe(200);
  });

  test('a note downloads as a PDF', async () => {
    const note = await CreditNote.findOne({ invoiceId: invoice._id, status: 'issued' });
    const res = await admin().get(`/api/credit-notes/${note._id}/pdf`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
