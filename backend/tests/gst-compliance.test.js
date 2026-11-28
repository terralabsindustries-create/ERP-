/**
 * E-invoice / e-way bill workflow. With no provider configured nothing is
 * "generated"; with a TEST provider (registered only in this file — its values
 * are obviously fake test strings, never shown as government data) the
 * workflow's storage, idempotency, retry and cancellation rules are checked.
 */
const request = require('supertest');
const app = require('../src/app');
const Settings = require('../src/models/Settings');
const { EInvoiceRecord, EwayBillRecord } = require('../src/models/GstCompliance');
const svc = require('../src/services/gstCompliance');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');

let org;
let other;
let inv;
let b2c;
const api = (token) => ({
  get: (u) => request(app).get(u).set(auth(token)),
  post: (u, b) => request(app).post(u).set(auth(token)).send(b || {}),
  put: (u, b) => request(app).put(u).set(auth(token)).send(b || {})
});
let a;
const calls = { irn: 0, cancel: 0, ewb: 0 };
const testProvider = {
  async generateIrn(payload) { calls.irn += 1; if (payload.__fail) throw new Error('boom'); return { irn: `TEST-IRN-${calls.irn}`, ackNo: `TEST-ACK-${calls.irn}`, ackDate: new Date(), signedQrCode: 'TEST-QR' }; },
  async cancelIrn() { calls.cancel += 1; return { ok: true }; },
  async generateEwb() { calls.ewb += 1; return { ewbNumber: `TEST-EWB-${calls.ewb}`, validUntil: new Date(Date.now() + 864e5) }; }
};

beforeAll(async () => {
  await connectTestDb('gstcompliance');
  org = await createOrg('gc');
  other = await createOrg('gco');
  const s = await Settings.getOrCreateSettings(org.admin._id);
  s.companyName = 'Compliance Press';
  s.gstNumber = '32AAPFU0939F1Z4';
  s.companyAddress = { street: '1 Press Rd', city: 'Kochi', state: 'Kerala', zipCode: '682011' };
  await s.save();
  a = api(org.tokens.admin);
  const reg = await make.customer(org.admin, { name: 'Registered Buyer', gstNumber: '27AABCU9603R1ZN', address: 'Andheri, Mumbai 400053' });
  const walk = await make.customer(org.admin, { name: 'Walk-in' });
  inv = (await a.post('/api/invoices', { customerId: reg._id, status: 'sent', isInterState: true, items: [{ itemName: 'Catalogues', quantity: 100, unitPrice: 50, gstRate: 18, hsnCode: '4911' }] })).body.data.invoice;
  b2c = (await a.post('/api/invoices', { customerId: walk._id, status: 'sent', items: [{ itemName: 'Cards', quantity: 1, unitPrice: 100, gstRate: 18 }] })).body.data.invoice;
  await EInvoiceRecord.init();
  await EwayBillRecord.init();
});
afterAll(async () => { svc.unregisterProvider('custom_gsp'); await disconnectTestDb(); });

test('off by default: nothing is attempted', async () => {
  const res = await a.post(`/api/gst-compliance/invoices/${inv._id}/irn`);
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('EINVOICE_DISABLED');
});

test('validation lists every problem before anything is sent', async () => {
  await a.put('/api/gst-compliance/settings', { eInvoiceEnabled: true, eWayBillEnabled: true, provider: 'custom_gsp', eWayBillThreshold: 50000 });
  const res = await a.post(`/api/gst-compliance/invoices/${b2c._id}/irn`);
  expect(res.status).toBe(400);
  expect(res.body.details.problems.join(' ')).toMatch(/no GSTIN/);
  expect(res.body.details.problems.join(' ')).toMatch(/HSN/);
});

test('with no provider plugged in, generation is refused and nothing looks generated', async () => {
  const res = await a.post(`/api/gst-compliance/invoices/${inv._id}/irn`);
  expect(res.status).toBe(503);
  expect(res.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  const rec = await EInvoiceRecord.findOne({ invoiceId: inv._id });
  expect(rec.status).toBe('pending');
  expect(rec.irn).toBeUndefined();
  expect(rec.events[0]).toMatchObject({ action: 'generate', outcome: 'blocked' });
});

test('the payload uses NIC e-invoice fields and the invoice values', async () => {
  const { payload, problems } = await svc.eInvoiceCheck(org.admin, { ...inv, customerAddress: 'Andheri, Mumbai 400053' });
  expect(problems).toEqual([]);
  expect(payload).toMatchObject({ Version: '1.1', TranDtls: { SupTyp: 'B2B' }, DocDtls: { Typ: 'INV', No: inv.invoiceNumber }, SellerDtls: { Gstin: '32AAPFU0939F1Z4', Stcd: '32', Pin: 682011 }, BuyerDtls: { Gstin: '27AABCU9603R1ZN', Pos: '27', Pin: 400053 } });
  expect(payload.ValDtls).toMatchObject({ AssVal: 5000, IgstVal: 900, TotInvVal: 5900 });
  expect(payload.ItemList[0]).toMatchObject({ HsnCd: '4911', GstRt: 18, IgstAmt: 900 });
});

test('a provider response is stored as returned; a second request never asks again', async () => {
  svc.registerProvider('custom_gsp', testProvider);
  const [x, y] = await Promise.all([a.post(`/api/gst-compliance/invoices/${inv._id}/irn`), a.post(`/api/gst-compliance/invoices/${inv._id}/irn`)]);
  expect([x.status, y.status].sort()).toEqual([200, 409]);
  expect(calls.irn).toBe(1);
  const rec = await EInvoiceRecord.findOne({ invoiceId: inv._id });
  expect(rec).toMatchObject({ status: 'generated', irn: 'TEST-IRN-1', ackNo: 'TEST-ACK-1' });
  const again = await a.post(`/api/gst-compliance/invoices/${inv._id}/irn`);
  expect(again.body.code).toBe('IRN_EXISTS');
});

test('cancellation needs a reason and is allowed only within 24 hours', async () => {
  expect((await a.post(`/api/gst-compliance/invoices/${inv._id}/irn/cancel`, { reasonCode: 9 })).body.code).toBe('INVALID_REASON');
  await EInvoiceRecord.updateOne({ invoiceId: inv._id }, { $set: { ackDate: new Date(Date.now() - 25 * 3600e3) } });
  expect((await a.post(`/api/gst-compliance/invoices/${inv._id}/irn/cancel`, { reasonCode: 2 })).body.code).toBe('CANCEL_WINDOW_PASSED');
  await EInvoiceRecord.updateOne({ invoiceId: inv._id }, { $set: { ackDate: new Date() } });
  const ok = await a.post(`/api/gst-compliance/invoices/${inv._id}/irn/cancel`, { reasonCode: 2, remark: 'wrong rate' });
  expect(ok.status).toBe(200);
  expect(ok.body.data.eInvoice).toMatchObject({ status: 'cancelled', cancelReasonCode: '2' });
});

test('e-way bill: transport validation, one active bill per invoice, threshold reported', async () => {
  const bad = await a.post(`/api/gst-compliance/invoices/${inv._id}/eway-bill`, { transportMode: 'road', vehicleNumber: 'X1', distanceKm: 9000, fromPincode: '682011', toPincode: '4000' });
  expect(bad.status).toBe(400);
  expect(bad.body.details.problems).toHaveLength(3);
  const good = { transportMode: 'road', vehicleNumber: 'KL 07 AB 1234', distanceKm: 1400, fromPincode: '682011', toPincode: '400053' };
  const first = await a.post(`/api/gst-compliance/invoices/${inv._id}/eway-bill`, good);
  expect(first.status).toBe(200);
  expect(first.body.data.eWayBill).toMatchObject({ status: 'generated', ewbNumber: 'TEST-EWB-1', vehicleNumber: 'KL07AB1234' });
  expect((await a.post(`/api/gst-compliance/invoices/${inv._id}/eway-bill`, good)).body.code).toBe('EWB_EXISTS');
  const st = (await a.get(`/api/gst-compliance/invoices/${inv._id}`)).body.data;
  expect(st.eWayBillRequired).toBe(false); // ₹5,900 < the ₹50,000 the business entered
  expect(st.settings).toMatchObject({ providerReady: true, eWayBillThreshold: 50000 });
});

test('a provider failure is recorded and can be retried', async () => {
  svc.registerProvider('custom_gsp', { ...testProvider, generateIrn: async () => { throw new Error('IRP timeout'); } });
  const inv2 = (await a.post('/api/invoices', { customerId: inv.customerId._id || inv.customerId, status: 'sent', isInterState: true, items: [{ itemName: 'Posters', quantity: 1, unitPrice: 100, gstRate: 18, hsnCode: '4911' }] })).body.data.invoice;
  const r = await a.post(`/api/gst-compliance/invoices/${inv2._id}/irn`);
  expect(r.status).toBe(502);
  expect(await EInvoiceRecord.findOne({ invoiceId: inv2._id })).toMatchObject({ status: 'failed', lastError: 'IRP timeout', inFlightAt: null });
  svc.registerProvider('custom_gsp', testProvider);
  expect((await a.post(`/api/gst-compliance/invoices/${inv2._id}/irn`)).status).toBe(200);
  expect((await EInvoiceRecord.findOne({ invoiceId: inv2._id })).attempts).toBe(2);
});

test('another business cannot see or act on these invoices', async () => {
  expect((await api(other.tokens.admin).get(`/api/gst-compliance/invoices/${inv._id}`)).status).toBe(404);
  expect((await api(other.tokens.admin).post(`/api/gst-compliance/invoices/${inv._id}/irn`)).status).toBe(404);
});
