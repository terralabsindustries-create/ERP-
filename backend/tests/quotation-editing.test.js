/**
 * Editing a quotation (PUT /api/quotations/:id): which quotations can be
 * changed, that every figure is priced again, that the change is what the
 * list, the record, the PDF and the invoice raised from it show — and, in the
 * client's form helper, that Enter never submits the quotation form.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const Quotation = require('../src/models/Quotation');
const PDFService = require('../src/services/PDFService');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let cust;
let cust2;
const as = (token) => ({
  get: (url) => request(app).get(url).set(auth(token)),
  post: (url, body) => request(app).post(url).set(auth(token)).send(body),
  put: (url, body) => request(app).put(url).set(auth(token)).send(body),
  patch: (url, body) => request(app).patch(url).set(auth(token)).send(body)
});
const admin = () => as(org.tokens.admin);
const company = { name: 'Test Printers', currency: 'INR', addressLines: [] };

const brochure = { item_name: 'Brochure', description: 'A4 tri-fold', quantity: 100, unit: 'pieces', unit_price: 10, tax_rate: 18 };
const flex = { item_name: 'Flex banner', quantity: 2, unit: 'sqft', unit_price: 12, length: 6, width: 4, tax_rate: 18 };

const createDraft = async (extra = {}) => {
  const res = await admin().post('/api/quotations', { customer_id: String(cust._id), items: [brochure], ...extra });
  expect(res.status).toBe(201);
  return res.body.data.quotation;
};

// The whole quotation, as the edit dialog sends it.
const edited = (q, patch = {}) => ({
  customer_id: String(cust._id),
  valid_until: q.valid_until,
  terms_conditions: q.terms_conditions,
  notes: q.notes,
  items: q.items.map(({ item_name, description, quantity, unit, unit_price, length, width, hsn_code, tax_rate }) => ({ item_name, description, quantity, unit, unit_price, length, width, hsn_code, tax_rate })),
  design_charge: q.design_charge,
  design_charge_tax_rate: q.design_charge_tax_rate,
  discount_amount: q.discount_amount,
  is_interstate: q.is_interstate,
  ...patch
});

beforeAll(async () => {
  await connectTestDb('quoteedit');
  // Staff who may change a quotation's status but not its contents.
  org = await createOrg('qe', { staffPermissions: ['Dashboard', 'Quotations', 'Quotations: Change Status'] });
  other = await createOrg('qx');
  cust = await make.customer(org.admin, { name: 'Lotus Events' });
  cust2 = await make.customer(org.admin, { name: 'Sun Traders' });
});
afterAll(disconnectTestDb);

describe('editing a draft quotation', () => {
  let q;
  beforeAll(async () => {
    q = await createDraft({ design_charge: 500, design_charge_tax_rate: 18, notes: 'First draft' });
    // 1,000 + 18% = 1,180; design 500 + 18% = 590.
    expect(q).toMatchObject({ subtotal: 1000, total_amount: 1770, status: 'draft' });
  });

  test('adds items, changes quantities, rates, discount, GST and customer, and prices it all again', async () => {
    const res = await admin().put(`/api/quotations/${q._id}`, edited(q, {
      customer_id: String(cust2._id),
      items: [
        { ...brochure, quantity: 200, unit_price: 9 },
        flex,
        { item_name: 'Standee', quantity: 1, unit: 'pieces', unit_price: 1500, tax_rate: 12 }
      ],
      design_charge: 600,
      design_charge_tax_rate: 18,
      discount_amount: 100,
      notes: 'Revised after the call',
      valid_until: '2026-12-31',
      // Totals sent by the client are never trusted.
      subtotal: 1,
      total_amount: 1,
      status: 'approved'
    }));
    expect(res.status).toBe(200);
    const after = res.body.data.quotation;
    // Lines 1,800 + 576 + 1,500 = 3,876; + 600 design = 4,476; − 100 = 4,376 taxable.
    expect(after).toMatchObject({
      quotationNumber: q.quotationNumber,
      status: 'draft',
      subtotal: 3876,
      design_charge: 600,
      discount_amount: 100,
      notes: 'Revised after the call',
      gst_type: 'gst'
    });
    expect(after.customer_id._id).toBe(String(cust2._id));
    expect(after.items).toHaveLength(3);
    expect(after.items[1]).toMatchObject({ item_name: 'Flex banner', area_per_piece: 24, total_area: 48, tax_rate: 18 });
    const tax = after.items.reduce((s, i) => s + i.tax_amount, 0) + after.design_charge_tax_amount;
    expect(after.tax_amount).toBeCloseTo(tax, 2);
    expect(after.total_amount).toBeCloseTo(4376 + after.tax_amount, 2);
    expect(after.cgst_amount + after.sgst_amount).toBeCloseTo(after.tax_amount, 2);
    expect(new Date(after.valid_until).toISOString().slice(0, 10)).toBe('2026-12-31');
    q = after;
  });

  test('the change is what the record, the list and the PDF show', async () => {
    const one = (await admin().get(`/api/quotations/${q._id}`)).body.data.quotation;
    expect(one).toMatchObject({ total_amount: q.total_amount, discount_amount: 100 });
    expect(one.items).toHaveLength(3);

    const listed = (await admin().get('/api/quotations?limit=100')).body.data.quotations.find((x) => x._id === q._id);
    expect(listed.total_amount).toBe(q.total_amount);

    const stored = await Quotation.findById(q._id).populate('customer_id');
    const d = PDFService.quotationDocument(stored, company);
    expect(d.items.map((i) => i.description)).toEqual(['Brochure', 'Flex banner', 'Standee']);
    expect(d.summary.find((s) => s.label === 'Discount').value).toBe('- INR 100.00');
    expect(d.summary.find((s) => s.label === 'Taxable Amount').value).toBe('INR 4,376.00');
    expect(d.summary.find((s) => s.label === 'Total').value).toBe(`INR ${q.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
  });

  test('refuses what create refuses', async () => {
    expect((await admin().put(`/api/quotations/${q._id}`, edited(q, { items: [] }))).status).toBe(400);
    expect((await admin().put(`/api/quotations/${q._id}`, edited(q, { items: [{ ...brochure, unit_price: 0 }] }))).status).toBe(400);
    expect((await admin().put(`/api/quotations/${q._id}`, edited(q, { items: [{ ...brochure, tax_rate: 150 }] }))).status).toBe(400);
    const tooMuch = await admin().put(`/api/quotations/${q._id}`, edited(q, { discount_amount: 999999 }));
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toMatch(/Discount/);
    // Nothing was changed by the refused edits.
    expect((await Quotation.findById(q._id)).total_amount).toBe(q.total_amount);
  });

  test('converts to an invoice at the edited lines, discount, GST and total', async () => {
    const res = await admin().post(`/api/quotations/${q._id}/convert-to-invoice`, {});
    expect(res.status).toBe(201);
    const inv = res.body.data.invoice;
    expect(inv.items).toHaveLength(3);
    expect(inv).toMatchObject({ subtotal: 3876, designCharge: 600, discountAmount: 100, taxableAmount: 4376 });
    expect(inv.totalGstAmount).toBeCloseTo(q.tax_amount, 2);
    expect(inv.totalAmount).toBeCloseTo(q.total_amount, 2);
  });

  test('once invoiced it can no longer be edited', async () => {
    const res = await admin().put(`/api/quotations/${q._id}`, edited(q, { notes: 'Too late' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTATION_LOCKED');
    expect(res.body.message).toMatch(/invoice INV-/);
    expect((await Quotation.findById(q._id)).notes).toBe('Revised after the call');
  });
});

describe('which quotations can be edited', () => {
  test('a sent quotation can be revised and stays sent', async () => {
    const q = await createDraft();
    await admin().patch(`/api/quotations/${q._id}/status`, { status: 'sent' });
    const res = await admin().put(`/api/quotations/${q._id}`, edited(q, { items: [brochure, flex] }));
    expect(res.status).toBe(200);
    expect(res.body.data.quotation).toMatchObject({ status: 'sent' });
    expect(res.body.data.quotation.items).toHaveLength(2);
  });

  test.each(['approved', 'rejected', 'expired', 'closed'])('a %s quotation is reopened as a draft before it is changed', async (status) => {
    const q = await createDraft();
    await admin().patch(`/api/quotations/${q._id}/status`, { status });
    const locked = await admin().put(`/api/quotations/${q._id}`, edited(q, { notes: 'Change' }));
    expect(locked.status).toBe(409);
    expect(locked.body.message).toMatch(/Reopen it as a draft/);

    expect((await admin().patch(`/api/quotations/${q._id}/status`, { status: 'draft' })).status).toBe(200);
    const res = await admin().put(`/api/quotations/${q._id}`, edited(q, { notes: 'Change' }));
    expect(res.status).toBe(200);
    expect(res.body.data.quotation.notes).toBe('Change');
  });

  test('needs Quotations: Create & Edit, and stays inside the business', async () => {
    const q = await createDraft();
    expect((await as(org.tokens.staff1).put(`/api/quotations/${q._id}`, edited(q))).status).toBe(403);
    expect((await as(other.tokens.admin).put(`/api/quotations/${q._id}`, edited(q))).status).toBe(404);
    const theirs = await make.customer(other.admin, { name: 'Elsewhere' });
    expect((await admin().put(`/api/quotations/${q._id}`, edited(q, { customer_id: String(theirs._id) }))).status).toBe(404);
    expect((await admin().put('/api/quotations/not-an-id', edited(q))).status).toBe(404);
  });

  test('creating a quotation with a discount prices it the same way', async () => {
    const q = await createDraft({ items: [brochure], discount_amount: 100 });
    // 1,000 − 100 = 900 taxable; 18% = 162.
    expect(q).toMatchObject({ subtotal: 1000, discount_amount: 100, tax_amount: 162, total_amount: 1062 });
  });
});

/*
 * The quotation form's Enter handling (client/src/lib/formKeys.ts), loaded the
 * way billing-math.test.js loads the client's billing code. Skipped when the
 * client's dependencies are not installed next to the backend.
 */
const clientDir = path.join(__dirname, '../../client');
let ts = null;
try {
  ts = require(path.join(clientDir, 'node_modules/typescript'));
} catch {
  ts = null;
}

(ts ? describe : describe.skip)('Enter in the quotation form', () => {
  let keys;
  beforeAll(() => {
    const source = fs.readFileSync(path.join(clientDir, 'src/lib/formKeys.ts'), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require);
    keys = mod.exports;
  });

  test('the form source wires it in, so implicit submission cannot save the quotation', () => {
    const dialog = fs.readFileSync(path.join(clientDir, 'src/components/quotations/CreateQuotationDialog.tsx'), 'utf8');
    expect(dialog).toMatch(/<form onSubmit=\{handleSubmit\} onKeyDown=\{moveFocusOnEnter\}/);
  });

  test('Enter in any single-line field moves on instead of submitting', () => {
    for (const type of ['text', 'number', 'date', 'url', 'email', '']) {
      expect(keys.enterAction({ key: 'Enter' }, { tagName: 'INPUT', type })).toBe('next');
    }
    expect(keys.enterAction({ key: 'Enter', shiftKey: true }, { tagName: 'INPUT', type: 'text' })).toBe('previous');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(keys.enterAction({ key: 'Enter', [mod]: true }, { tagName: 'INPUT', type: 'number' })).toBe('block');
    }
  });

  test('textareas, buttons, checkboxes, other keys and IME composition keep their own behaviour', () => {
    expect(keys.enterAction({ key: 'Enter' }, { tagName: 'TEXTAREA' })).toBe('default');
    expect(keys.enterAction({ key: 'Enter' }, { tagName: 'BUTTON', type: 'submit' })).toBe('default');
    expect(keys.enterAction({ key: 'Enter' }, { tagName: 'INPUT', type: 'checkbox' })).toBe('default');
    expect(keys.enterAction({ key: 'Tab' }, { tagName: 'INPUT', type: 'text' })).toBe('default');
    expect(keys.enterAction({ key: 'Enter', isComposing: true }, { tagName: 'INPUT', type: 'text' })).toBe('default');
  });

  // A stand-in for the form: fields in document order.
  const field = (tagName, extra = {}) => ({
    tagName,
    type: 'text',
    tabIndex: 0,
    disabled: false,
    hasAttribute: (name) => !!extra[name],
    getClientRects: () => (extra.hidden ? [] : [{}]),
    focus: jest.fn(),
    select: jest.fn(),
    ...extra
  });
  const press = (target, fields, init = {}) => {
    const event = {
      key: 'Enter',
      target,
      currentTarget: { querySelectorAll: () => fields },
      nativeEvent: {},
      preventDefault: jest.fn(),
      ...init
    };
    keys.moveFocusOnEnter(event);
    return event;
  };

  test('moves focus to the next usable field, skipping disabled, hidden and read-only ones', () => {
    const name = field('INPUT');
    const disabled = field('INPUT', { disabled: true });
    const hidden = field('INPUT', { hidden: true });
    const readonly = field('INPUT', { readonly: true });
    const qty = field('INPUT', { type: 'number' });
    const e = press(name, [name, disabled, hidden, readonly, qty]);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(qty.focus).toHaveBeenCalled();
    expect(qty.select).toHaveBeenCalled();
    expect(disabled.focus).not.toHaveBeenCalled();
  });

  test('on the last field Enter does nothing — it still does not submit', () => {
    const notes = field('INPUT');
    const e = press(notes, [field('INPUT'), notes]);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  test('Enter in a textarea is left alone', () => {
    const area = field('TEXTAREA');
    const e = press(area, [area, field('INPUT')]);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
