/**
 * GST working papers: every issued invoice lands in one GSTR-1 section, notes
 * adjust the right section, drafts never count, cancelled invoices appear only
 * in Table 13, and the sections add back to the registers.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Settings = require('../src/models/Settings');
const PurchaseBill = require('../src/models/PurchaseBill');
const { connectTestDb, disconnectTestDb } = require('./helpers/db');
const { createOrg, auth } = require('./helpers/fixtures');
const make = require('./helpers/factories');
const { periodOf } = require('../src/routes/gstReports');
const { b2clLimitOn } = require('../src/services/gstReports');

let org;
let other;
const month = (() => { const d = new Date(Date.now() + 330 * 60e3); return d.toISOString().slice(0, 7); })();
const api = (token) => ({
  get: (u) => request(app).get(u).set(auth(token)),
  post: (u, b) => request(app).post(u).set(auth(token)).send(b),
  patch: (u, b) => request(app).patch(u).set(auth(token)).send(b || {})
});
let a;
let report;
const ids = {};

beforeAll(async () => {
  await connectTestDb('gstreports');
  org = await createOrg('gst');
  other = await createOrg('gsto');
  const s = await Settings.getOrCreateSettings(org.admin._id);
  s.companyName = 'GST Printers';
  s.gstNumber = '32AAPFU0939F1Z4'; // Kerala
  s.companyAddress = { state: 'Kerala' };
  await s.save();
  a = api(org.tokens.admin);
  const cust = async (name, gstNumber) => make.customer(org.admin, { name, gstNumber });
  const regKerala = await cust('Kerala Registered', '32AAPFU0939F1Z4');
  const regMaha = await cust('Maharashtra Registered', '27AABCU9603R1ZN');
  const walkin = await cust('Walk-in Buyer');
  const line = (itemName, quantity, unitPrice, gstRate, hsnCode = '4911') => ({ itemName, quantity, unitPrice, gstRate, hsnCode });
  const issue = async (body) => {
    const r = await a.post('/api/invoices', { status: 'sent', ...body });
    expect(r.status).toBe(201);
    return r.body.data.invoice;
  };
  ids.b2bIntra = await issue({ customerId: regKerala._id, items: [line('Cards', 10, 100, 18)] });
  ids.b2bInter = await issue({ customerId: regMaha._id, isInterState: true, items: [line('Books', 10, 200, 12, '4901')] });
  ids.b2cl = await issue({ customerId: walkin._id, isInterState: true, placeOfSupply: '29', items: [line('Banners', 100, 1500, 18)] });
  ids.b2csIntra = await issue({ customerId: walkin._id, items: [line('Flyers', 10, 50, 5)] });
  ids.b2csInter = await issue({ customerId: walkin._id, isInterState: true, placeOfSupply: 'Tamil Nadu', items: [line('Stickers', 10, 100, 18), line('Blank paper', 1, 300, 0)] });
  // Never counted: a draft; a cancelled invoice counts only in Table 13.
  await a.post('/api/invoices', { customerId: walkin._id, items: [line('Draft', 1, 999, 18)] });
  const toCancel = await issue({ customerId: walkin._id, items: [line('Oops', 1, 100, 18)] });
  expect((await a.patch(`/api/invoices/${toCancel._id}/cancel`, { reason: 'wrong customer' })).status).toBe(200);
  // Notes: a credit note to a registered customer (CDNR) and one on a B2CS invoice (netted).
  const cn = async (inv, taxableValue) => {
    const c = await a.post('/api/credit-notes', { noteType: 'credit', invoiceId: inv._id, reason: 'post_sale_discount', items: [{ invoiceLineRef: String(inv.items[0]._id), taxableValue }] });
    expect((await a.patch(`/api/credit-notes/${c.body.data.note._id}/issue`)).status).toBe(200);
  };
  await cn(ids.b2bIntra, 100);
  await cn(ids.b2csIntra, 50);
  await PurchaseBill.create({
    billNumber: 'PB-1', vendorId: new mongoose.Types.ObjectId(), vendorName: 'Paper Mill', vendorGstNumber: '33AAACT2727Q1Z3', billDate: new Date(),
    items: [{ description: 'Art paper', rate: 1000, quantity: 1, gstRate: 18 }], taxableAmount: 1000, totalIgstAmount: 180, totalAmount: 1180, isInterState: true,
    userId: org.admin._id, dataScope: org.dataScope
  });
  const res = await a.get(`/api/gst-reports?month=${month}`);
  expect(res.status).toBe(200);
  report = res.body.data;
});
afterAll(disconnectTestDb);

test('the B2CL limit follows the date of the invoice (₹2.5 lakh before 1 Aug 2024, ₹1 lakh from)', () => {
  expect(b2clLimitOn(new Date('2024-07-31T12:00:00+05:30'))).toBe(250000);
  expect(b2clLimitOn(new Date('2024-08-01T00:00:00+05:30'))).toBe(100000);
});

test('each issued invoice lands in one section', () => {
  const g = report.gstr1;
  expect(g.b2b.map((r) => r.invoiceNumber).sort()).toEqual([ids.b2bIntra.invoiceNumber, ids.b2bInter.invoiceNumber].sort());
  expect(g.b2b.find((r) => r.invoiceNumber === ids.b2bInter.invoiceNumber)).toMatchObject({ placeOfSupply: '27-Maharashtra', rate: 12, taxable: 2000, igst: 240 });
  expect(g.b2cl).toEqual([expect.objectContaining({ invoiceNumber: ids.b2cl.invoiceNumber, placeOfSupply: '29-Karnataka', taxable: 150000, igst: 27000 })]);
  const tn = g.b2cs.find((r) => r.placeOfSupply === '33-Tamil Nadu');
  expect(tn).toMatchObject({ supplyType: 'Inter-state', rate: 18, taxable: 1000, igst: 180 });
  // Flyers 500 at 5% less the 50 credit note.
  expect(g.b2cs.find((r) => r.placeOfSupply === '32-Kerala' && r.rate === 5)).toMatchObject({ taxable: 450, cgst: 11.25, sgst: 11.25 });
  expect(g.nil.taxable).toBe(300);
  expect(report.registers.sales).toHaveLength(5);
});

test('notes go to CDNR or are netted into B2CS', () => {
  expect(report.gstr1.cdnr).toEqual([expect.objectContaining({ gstin: '32AAPFU0939F1Z4', noteType: 'C', taxable: 100, cgst: 9, sgst: 9, originalInvoice: ids.b2bIntra.invoiceNumber })]);
  expect(report.registers.notes.map((n) => n.section).sort()).toEqual(['B2CS (netted)', 'CDNR']);
});

test('Table 13 lists issued invoice numbers with the cancelled one, never drafts', () => {
  const inv = report.gstr1.docs.find((d) => d.nature === 'Invoices for outward supply');
  expect(inv).toMatchObject({ total: 6, cancelled: 1, net: 5 });
  expect(inv.from).toMatch(/^INV-/);
  expect(report.gstr1.docs.find((d) => d.nature === 'Credit Note')).toMatchObject({ total: 2, cancelled: 0 });
});

test('GSTR-3B summary: output net of notes, ITC from registered suppliers', () => {
  const g = report.gstr3b;
  // Taxable: 1000 + 2000 + 150000 + 500 + 1000 (300 nil) − 100 − 50
  expect(g.outwardTaxable.taxable).toBe(154350);
  expect(g.outwardTaxable.igst).toBe(240 + 27000 + 180);
  expect(g.outwardTaxable.cgst).toBe(90 + 12.5 - 9 - 1.25);
  expect(g.nilExempt.taxable).toBe(300);
  expect(g.eligibleItc).toEqual({ igst: 180, cgst: 0, sgst: 0 });
  expect(g.netPayable.igst).toBe(240 + 27000 + 180 - 180);
  expect(g.interStateToUnregistered.map((r) => r.placeOfSupply).sort()).toEqual(['29-Karnataka', '33-Tamil Nadu']);
});

test('sections reconcile with the registers', () => {
  expect(report.reconciliation).toMatchObject({ balanced: true, invoices: 5, classified: 5 });
  expect(report.reconciliation.salesRegisterTaxable).toBe(report.reconciliation.sectionsTaxable);
});

test('HSN summary is split B2B / B2C and net of notes', () => {
  expect(report.gstr1.hsnB2B.find((h) => h.hsn === '4911')).toMatchObject({ rate: 18, taxable: 900 });
  expect(report.gstr1.hsnB2C.find((h) => h.hsn === '4911' && h.rate === 5)).toMatchObject({ taxable: 450 });
});

test('another business sees none of it', async () => {
  const res = await api(other.tokens.admin).get(`/api/gst-reports?month=${month}`);
  expect(res.body.data.registers.sales).toHaveLength(0);
  expect(res.body.data.warnings.map((w) => w.code)).toContain('NO_HOME_STATE');
});

test('exports: Excel workbook and a CSV section', async () => {
  const bin = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
  const xlsx = await a.get(`/api/gst-reports/export?month=${month}&format=xlsx`).buffer(true).parse(bin);
  expect(xlsx.status).toBe(200);
  expect(xlsx.body.slice(0, 2).toString()).toBe('PK');
  const csv = await a.get(`/api/gst-reports/export?month=${month}&format=csv&section=b2b`);
  expect(csv.status).toBe(200);
  expect(csv.text.replace(/^﻿/, '').split('\r\n')[0]).toBe('gstin,receiverName,invoiceNumber,invoiceDate,invoiceValue,placeOfSupply,reverseCharge,invoiceType,rate,taxable,igst,cgst,sgst');
});

test('periods: month, quarter, FY and refused input', async () => {
  expect(periodOf({ quarter: '2026-27', q: '3' }).from.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  expect(periodOf({ quarter: '2026-27', q: '4' }).to.toISOString()).toBe('2027-03-31T18:30:00.000Z');
  expect(periodOf({ fy: '2026-28' })).toBeNull();
  expect((await a.get('/api/gst-reports')).status).toBe(400);
});

test('needs Reports or Accounts', async () => {
  const User = require('../src/models/User');
  await User.updateOne({ _id: org.staff1._id }, { permissions: ['Dashboard', 'Customers'] });
  expect((await api(org.tokens.staff1).get(`/api/gst-reports?month=${month}`)).status).toBe(403);
});
