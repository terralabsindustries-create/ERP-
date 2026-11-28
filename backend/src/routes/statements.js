const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { customerStatement, supplierStatement, StatementError } = require('../services/statements');
const { IST_OFFSET_MS } = require('../utils/financialYear');

/*
  GET /api/statements/customer/:id?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=pdf|xlsx]
  GET /api/statements/supplier/:id?…
  Customer statements need Customers + (Invoicing or Payments or Accounts);
  supplier statements need Vendors or Purchase Bills (checked here).
*/
const router = express.Router();
router.use(protect);

const day = (s, end) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + (end ? 1 : 0)) - IST_OFFSET_MS) : null;
};
const ist = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const inr = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function range(req) {
  // Default: the last 90 days up to and including today (India time).
  const today = ist(Date.now());
  const to = day(req.query.to, true) || day(today, true);
  const from = day(req.query.from) || new Date(to.getTime() - 90 * 864e5);
  return from < to ? { from, to } : null;
}

async function render(res, st, format, company) {
  const name = `${st.kind === 'customer' ? 'Statement' : 'Supplier_statement'}_${st.party.name.replace(/[^\w-]+/g, '_')}_${ist(st.period.from)}_${ist(st.period.to - 1)}`;
  const rows = st.lines.map((l) => [fmtDay(l.date), l.type, l.reference, l.description || '', l.debit || '', l.credit || '', l.balance]);
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRows([[company?.name || ''], [`Statement of account — ${st.party.name}`], [`${fmtDay(st.period.from)} to ${fmtDay(st.period.to - 1)}`], [], ['Opening balance', '', '', '', '', '', st.opening], ['Date', 'Type', 'Reference', 'Details', 'Debit', 'Credit', 'Balance'], ...rows, [], ['Closing balance', '', '', '', st.debits, st.credits, st.closing]]);
    ws.getRow(6).font = { bold: true };
    ws.columns.forEach((c, i) => { c.width = [14, 18, 20, 36, 14, 14, 14][i]; });
    if (st.ageing) {
      ws.addRows([[], ['Ageing (days past due)', 'Current', '1–30', '31–60', '61–90', '90+'], ['', st.ageing.current, st.ageing.d1_30, st.ageing.d31_60, st.ageing.d61_90, st.ageing.d90plus]]);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  doc.pipe(res);
  doc.font('Helvetica-Bold').fontSize(14).text(company?.name || '', { continued: false });
  if (company?.gstNumber) doc.font('Helvetica').fontSize(9).text(`GSTIN ${company.gstNumber}`);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(16).text('STATEMENT OF ACCOUNT');
  doc.font('Helvetica').fontSize(10).text(`${st.party.name}${st.party.gstNumber ? `  ·  GSTIN ${st.party.gstNumber}` : ''}`);
  doc.text(`${fmtDay(st.period.from)} to ${fmtDay(st.period.to - 1)}`);
  doc.moveDown(0.6);
  const cols = [70, 80, 90, 120, 60, 60, 60];
  const header = ['Date', 'Type', 'Reference', 'Details', 'Debit', 'Credit', 'Balance'];
  const drawRow = (cells, bold) => {
    const y = doc.y;
    let x = 36;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    cells.forEach((c, i) => {
      const money = i >= 4;
      doc.text(money && c !== '' ? inr(c) : String(c), x, y, { width: cols[i] - 4, align: money ? 'right' : 'left', lineBreak: false, ellipsis: true });
      x += cols[i];
    });
    doc.moveDown(0.45);
    doc.x = 36;
    if (doc.y > doc.page.height - 80) doc.addPage();
  };
  drawRow(header, true);
  drawRow(['', 'Opening balance', '', '', '', '', st.opening], true);
  rows.forEach((r) => drawRow(r));
  drawRow(['', 'Closing balance', '', '', st.debits, st.credits, st.closing], true);
  if (st.ageing) {
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9).text('Outstanding by age (days past due)', 36);
    doc.font('Helvetica').text(`Current ${inr(st.ageing.current)}   1–30 ${inr(st.ageing.d1_30)}   31–60 ${inr(st.ageing.d31_60)}   61–90 ${inr(st.ageing.d61_90)}   90+ ${inr(st.ageing.d90plus)}`);
  }
  if (st.voided?.length) {
    doc.moveDown(0.6).font('Helvetica-Bold').text('Cancelled documents (not in the balance)');
    doc.font('Helvetica');
    st.voided.forEach((v) => doc.text(`${fmtDay(v.date)}  ${v.type} ${v.reference}  ${inr(v.amount)}${v.reason ? ` — ${v.reason}` : ''}`));
  }
  if (st.note) doc.moveDown(0.6).fontSize(8).fillColor('#555').text(st.note);
  doc.end();
  return undefined;
}

const handle = (kind) => async (req, res) => {
  try {
    const ok = kind === 'customer'
      ? userCan(req.user, 'Customers') && (userCan(req.user, 'Invoicing') || userCan(req.user, 'Payments') || userCan(req.user, 'Accounts'))
      : userCan(req.user, 'Vendors') || userCan(req.user, 'Purchase Bills');
    if (!ok) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to see this statement.' });
    const r = range(req);
    if (!r) return res.status(400).json({ status: 'error', message: 'The start date must be before the end date.' });
    const st = kind === 'customer' ? await customerStatement(req.user, req.params.id, r.from, r.to) : await supplierStatement(req.user, req.params.id, r.from, r.to);
    if (req.query.format === 'pdf' || req.query.format === 'xlsx') {
      const { getCompanyInfo } = require('./invoices');
      const company = await getCompanyInfo(req.user).catch(() => null);
      return render(res, st, req.query.format, company?.isConfigured ? company : null);
    }
    res.json({ status: 'success', data: st });
  } catch (error) {
    if (error instanceof StatementError) return res.status(error.status).json({ status: 'error', message: error.message });
    console.error('Statement error:', error);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Could not prepare the statement.' });
  }
};

router.get('/customer/:id', handle('customer'));
router.get('/supplier/:id', handle('supplier'));

module.exports = router;
