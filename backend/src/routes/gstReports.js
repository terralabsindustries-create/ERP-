const express = require('express');
const ExcelJS = require('exceljs');
const { protect } = require('../middleware/auth');
const { buildGstReport } = require('../services/gstReports');
const { parseFinancialYear, IST_OFFSET_MS } = require('../utils/financialYear');

/*
  GET /api/gst-reports?month=2026-11              one return month (India time)
  GET /api/gst-reports?quarter=2026-27&q=3         Oct–Dec of FY 2026-27
  GET /api/gst-reports?fy=2026-27                  the financial year
  GET /api/gst-reports?from=2026-11-01&to=2026-11-30
  GET /api/gst-reports/export?…&format=xlsx|csv&section=b2b
  Mounted behind moduleGuard (Reports / Accounts / Invoicing readers).
*/
const router = express.Router();
router.use(protect);

const istDay = (y, m, d = 1) => new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);

function periodOf(q) {
  if (q.month) {
    const m = /^(\d{4})-(\d{2})$/.exec(q.month);
    if (!m) return null;
    const y = Number(m[1]); const mo = Number(m[2]) - 1;
    return { from: istDay(y, mo), to: istDay(y, mo + 1), label: q.month };
  }
  if (q.quarter) {
    const fy = parseFinancialYear(q.quarter);
    const n = Number(q.q);
    if (!fy || !(n >= 1 && n <= 4)) return null;
    const startMonth = 3 + (n - 1) * 3; // Apr, Jul, Oct, Jan(+12)
    return { from: istDay(fy.start, startMonth), to: istDay(fy.start, startMonth + 3), label: `${q.quarter} Q${n}` };
  }
  if (q.fy) {
    const fy = parseFinancialYear(q.fy);
    return fy ? { from: fy.from, to: fy.to, label: `FY ${fy.label}` } : null;
  }
  if (q.from && q.to) {
    const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.from); const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.to);
    if (!f || !t) return null;
    const from = istDay(+f[1], +f[2] - 1, +f[3]); const to = istDay(+t[1], +t[2] - 1, +t[3] + 1);
    return to > from ? { from, to, label: `${q.from} to ${q.to}` } : null;
  }
  return null;
}

const load = async (req, res) => {
  const period = periodOf(req.query);
  if (!period) {
    res.status(400).json({ status: 'error', message: 'Choose a period: month=YYYY-MM, quarter=YYYY-YY&q=1..4, fy=YYYY-YY, or from/to dates.' });
    return null;
  }
  const hsnDigits = req.query.hsnDigits === '6' ? 6 : 4;
  const report = await buildGstReport(req.user, period.from, period.to, { hsnDigits });
  return { ...report, period: { ...report.period, label: period.label } };
};

router.get('/', async (req, res) => {
  try {
    const report = await load(req, res);
    if (report) res.json({ status: 'success', data: report });
  } catch (error) {
    console.error('GST report error:', error);
    res.status(500).json({ status: 'error', message: 'Could not prepare the GST report.' });
  }
});

const ist = (d) => (d ? new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) : '');
const SECTIONS = {
  b2b: { title: 'GSTR-1 B2B (4A)', rows: (r) => r.gstr1.b2b, cols: ['gstin', 'receiverName', 'invoiceNumber', 'invoiceDate', 'invoiceValue', 'placeOfSupply', 'reverseCharge', 'invoiceType', 'rate', 'taxable', 'igst', 'cgst', 'sgst'] },
  b2cl: { title: 'GSTR-1 B2CL (5)', rows: (r) => r.gstr1.b2cl, cols: ['invoiceNumber', 'invoiceDate', 'invoiceValue', 'placeOfSupply', 'rate', 'taxable', 'igst'] },
  b2cs: { title: 'GSTR-1 B2CS (7)', rows: (r) => r.gstr1.b2cs, cols: ['placeOfSupply', 'supplyType', 'rate', 'taxable', 'igst', 'cgst', 'sgst'] },
  cdnr: { title: 'GSTR-1 CDNR (9B)', rows: (r) => r.gstr1.cdnr, cols: ['gstin', 'receiverName', 'noteNumber', 'noteDate', 'noteType', 'originalInvoice', 'placeOfSupply', 'noteValue', 'rate', 'taxable', 'igst', 'cgst', 'sgst'] },
  cdnur: { title: 'GSTR-1 CDNUR (9B)', rows: (r) => r.gstr1.cdnur, cols: ['urType', 'noteNumber', 'noteDate', 'noteType', 'originalInvoice', 'placeOfSupply', 'noteValue', 'rate', 'taxable', 'igst'] },
  hsnB2B: { title: 'HSN summary B2B (12)', rows: (r) => r.gstr1.hsnB2B, cols: ['hsn', 'description', 'uqc', 'quantity', 'rate', 'taxable', 'igst', 'cgst', 'sgst'] },
  hsnB2C: { title: 'HSN summary B2C (12)', rows: (r) => r.gstr1.hsnB2C, cols: ['hsn', 'description', 'uqc', 'quantity', 'rate', 'taxable', 'igst', 'cgst', 'sgst'] },
  docs: { title: 'Documents issued (13)', rows: (r) => r.gstr1.docs, cols: ['nature', 'from', 'to', 'total', 'cancelled', 'net'] },
  sales: { title: 'Sales register', rows: (r) => r.registers.sales, cols: ['invoiceNumber', 'invoiceDate', 'customerName', 'customerGstin', 'placeOfSupply', 'reverseCharge', 'invoiceValue', 'taxable', 'igst', 'cgst', 'sgst', 'totalTax'] },
  purchases: { title: 'Purchase register', rows: (r) => r.registers.purchases, cols: ['billNumber', 'supplierInvoiceNumber', 'billDate', 'supplierName', 'supplierGstin', 'taxable', 'igst', 'cgst', 'sgst', 'total'] },
  notes: { title: 'Credit & debit note register', rows: (r) => r.registers.notes, cols: ['noteNumber', 'noteType', 'noteDate', 'invoiceNumber', 'customerName', 'customerGstin', 'reason', 'section', 'noteValue', 'taxable', 'igst', 'cgst', 'sgst'] },
  warnings: { title: 'Validation', rows: (r) => r.warnings, cols: ['code', 'message', 'ref'] }
};
const cell = (v, key) => (/Date$/.test(key) ? ist(v) : v ?? '');
const csvEscape = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

router.get('/export', async (req, res) => {
  try {
    const report = await load(req, res);
    if (!report) return;
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const safeLabel = report.period.label.replace(/[^\w-]+/g, '_');
    if (format === 'csv') {
      const sec = SECTIONS[req.query.section];
      if (!sec) return res.status(400).json({ status: 'error', message: `Choose a section: ${Object.keys(SECTIONS).join(', ')}` });
      const lines = [sec.cols.join(','), ...sec.rows(report).map((row) => sec.cols.map((c) => csvEscape(cell(row[c], c))).join(','))];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="GST_${req.query.section}_${safeLabel}.csv"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Carbon Print Flow';
    const summary = wb.addWorksheet('Summary');
    summary.addRows([
      ['GST working papers', report.period.label],
      ['Business GSTIN', report.business.gstin || 'Not set'],
      ['Note', report.disclaimer],
      [],
      ['GSTR-3B 3.1(a) taxable value', report.gstr3b.outwardTaxable.taxable],
      ['IGST', report.gstr3b.outwardTaxable.igst], ['CGST', report.gstr3b.outwardTaxable.cgst], ['SGST/UTGST', report.gstr3b.outwardTaxable.sgst],
      ['3.1(c) nil / exempt', report.gstr3b.nilExempt.taxable],
      ['4 eligible ITC — IGST', report.gstr3b.eligibleItc.igst], ['CGST', report.gstr3b.eligibleItc.cgst], ['SGST', report.gstr3b.eligibleItc.sgst],
      ['Reconciled', report.reconciliation.balanced ? 'Yes' : 'NO — see Validation']
    ]);
    summary.getColumn(1).width = 34; summary.getColumn(2).width = 60;
    for (const [key, sec] of Object.entries(SECTIONS)) {
      const ws = wb.addWorksheet(sec.title.slice(0, 31));
      ws.addRow(sec.cols);
      ws.getRow(1).font = { bold: true };
      for (const row of sec.rows(report)) ws.addRow(sec.cols.map((c) => cell(row[c], c)));
      ws.columns.forEach((c) => { c.width = 16; });
      if (key === 'warnings') ws.getColumn(2).width = 90;
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="GST_${safeLabel}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('GST export error:', error);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Could not export the GST report.' });
  }
});

module.exports = router;
module.exports.periodOf = periodOf;
