const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const PDFService = require('./PDFService');

/*
  The monthly report (routes/reports.js buildMonthlyReport + the design charge
  year) as a downloadable PDF or Excel workbook. Figures come from the server's
  own report objects; only the free-text notes come from the caller.
*/

const inr = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rateOf = (key) => Number(String(key).replace('gst', ''));
const generatedLabel = (d) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** Rows shared by both formats, so the PDF and the workbook always agree. */
function sections(report, design, month) {
  const hasGst = report.totalTaxPayable > 0;
  const designMonth = design && design.year === Number(month.slice(0, 4)) ? design.months[Number(month.slice(5, 7)) - 1] : null;
  return {
    hasGst,
    summary: [
      ['Invoices issued', report.totalInvoices, false],
      ['Taxable value', report.taxableAmount, true],
      ['Discounts', report.totalDiscounts, true],
      ...(hasGst ? [['GST', report.totalTaxPayable, true]] : []),
      ['Total invoiced', report.totalRevenue, true]
    ],
    slabs: hasGst
      ? Object.entries(report.gstBreakdown).sort(([a], [b]) => rateOf(a) - rateOf(b)).map(([k, s]) => [`${rateOf(k)}%`, s.count, s.amount, s.tax])
      : [],
    taxSplit: hasGst ? [['CGST', report.cgstAmount], ['SGST', report.sgstAmount], ['IGST', report.igstAmount]] : [],
    designMonth,
    designYear: design
      ? design.months.map((m) => [m.label, m.invoiced.amount, m.invoiced.count, m.quoted.amount, m.quoted.count, m.convertedQuotes.amount])
      : []
  };
}

function fileName(company, month, ext) {
  const who = (company?.name || 'Carbon').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'Carbon';
  return `Monthly_report_${who}_${month}.${ext}`;
}

async function writeXlsx(res, { report, design, notes, company, month }) {
  const s = sections(report, design, month);
  const wb = new ExcelJS.Workbook();
  wb.creator = company?.name || 'Carbon';
  const ws = wb.addWorksheet('Monthly report');
  const money = '₹#,##,##0.00';
  const bold = (row) => { ws.getRow(row.number).font = { bold: true }; return row; };
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 22 }];

  bold(ws.addRow([company?.name || '']));
  if (company?.gstNumber) ws.addRow([`GSTIN ${company.gstNumber}`]);
  ws.getRow(ws.addRow([`Monthly report — ${report.month}`]).number).font = { bold: true, size: 14 };
  ws.addRow([`Generated ${generatedLabel(report.generatedAt)}`]);
  ws.addRow([]);

  bold(ws.addRow(['Summary']));
  for (const [label, value, isMoney] of s.summary) {
    const row = ws.addRow([label, value]);
    if (isMoney) row.getCell(2).numFmt = money;
  }

  if (s.hasGst) {
    ws.addRow([]);
    bold(ws.addRow(['GST rate', 'Invoices', 'Taxable value', 'GST']));
    for (const r of s.slabs) {
      const row = ws.addRow(r);
      row.getCell(3).numFmt = money;
      row.getCell(4).numFmt = money;
    }
    ws.addRow([]);
    for (const r of s.taxSplit) ws.addRow(r).getCell(2).numFmt = money;
  }

  if (s.designYear.length) {
    ws.addRow([]);
    bold(ws.addRow([`Design charges ${design.year}`, 'Invoiced', 'Invoices', 'Quoted', 'Quotations', 'Of quoted, converted']));
    for (const r of s.designYear) {
      const row = ws.addRow(r);
      [2, 4, 6].forEach((c) => { row.getCell(c).numFmt = money; });
    }
    const t = design.totals;
    const total = bold(ws.addRow([`${design.year} total`, t.invoiced.amount, t.invoiced.count, t.quoted.amount, t.quoted.count, t.convertedQuotes.amount]));
    [2, 4, 6].forEach((c) => { total.getCell(c).numFmt = money; });
    ws.addRow(['Invoiced and quoted are separate figures and are never added together.']);
  }

  ws.addRow([]);
  const excluded = ws.addRow(['Older No GST bills (not included above)', report.excludedNoGst.count, report.excludedNoGst.amount]);
  excluded.getCell(3).numFmt = money;
  if (notes) {
    ws.addRow([]);
    bold(ws.addRow(['Notes to accountant']));
    ws.addRow([notes]).getCell(1).alignment = { wrapText: true, vertical: 'top' };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(company, month, 'xlsx')}"`);
  await wb.xlsx.write(res);
  res.end();
}

function writePdf(res, { report, design, notes, company, month }) {
  const s = sections(report, design, month);
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Monthly report ${report.month}` } });
  const f = PDFService.carbonFonts(doc);
  const left = 40;
  const width = doc.page.width - 80;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(company, month, 'pdf')}"`);
  doc.pipe(res);

  const ensureSpace = (h) => { if (doc.y + h > doc.page.height - 50) doc.addPage(); };
  const heading = (text) => {
    ensureSpace(40);
    doc.moveDown(0.8).font(f.display).fontSize(11.5).fillColor('#1f1a14').text(text, left, doc.y);
    doc.moveDown(0.3);
  };
  // cols: [{ w, align }]; money cells are formatted by the caller.
  const row = (cells, cols, { bold = false, shade = false } = {}) => {
    ensureSpace(18);
    const y = doc.y;
    if (shade) doc.rect(left, y - 3, width, 17).fill('#f4ede1');
    doc.font(bold ? f.bold : f.body).fontSize(9).fillColor('#1f1a14');
    let x = left;
    cells.forEach((c, i) => {
      doc.text(String(c ?? ''), x + 4, y, { width: cols[i].w - 8, align: cols[i].align || 'left', lineBreak: false, ellipsis: true });
      x += cols[i].w;
    });
    doc.x = left;
    doc.y = y + 17;
    doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3).lineWidth(0.4).strokeColor('#eadfcd').stroke();
  };

  doc.font(f.displayBold).fontSize(15).fillColor('#1f1a14').text(company?.name || 'Monthly report', left, 40);
  const sub = [company?.gstNumber && `GSTIN ${company.gstNumber}`, company?.address].filter(Boolean).join('  ·  ');
  if (sub) doc.font(f.body).fontSize(8.5).fillColor('#5b4b36').text(sub, { width });
  doc.moveDown(0.8).font(f.display).fontSize(13).fillColor('#704a00').text(`Monthly report — ${report.month}`);
  doc.font(f.body).fontSize(8.5).fillColor('#85735a').text(`Issued invoices only (not drafts, cancelled or refunded). Generated ${generatedLabel(report.generatedAt)}.`);

  heading('Summary');
  const two = [{ w: width * 0.6 }, { w: width * 0.4, align: 'right' }];
  s.summary.forEach(([label, value, isMoney], i) => row([label, isMoney ? inr(value) : value], two, { bold: i === s.summary.length - 1 }));

  if (s.hasGst) {
    heading('GST by rate');
    const four = [{ w: width * 0.25 }, { w: width * 0.2, align: 'right' }, { w: width * 0.3, align: 'right' }, { w: width * 0.25, align: 'right' }];
    row(['Rate', 'Invoices', 'Taxable value', 'GST'], four, { bold: true, shade: true });
    s.slabs.forEach(([rate, count, amount, tax]) => row([rate, count, inr(amount), inr(tax)], four));
    doc.moveDown(0.4);
    s.taxSplit.forEach(([label, value]) => row([label, inr(value)], two));
  }

  if (s.designYear.length) {
    heading(`Design charges ${design.year}`);
    const six = [{ w: width * 0.22 }, { w: width * 0.2, align: 'right' }, { w: width * 0.1, align: 'right' }, { w: width * 0.2, align: 'right' }, { w: width * 0.1, align: 'right' }, { w: width * 0.18, align: 'right' }];
    row(['Month', 'Invoiced', 'Inv.', 'Quoted', 'Quot.', 'Converted'], six, { bold: true, shade: true });
    const current = s.designMonth?.label;
    s.designYear.forEach(([label, ia, ic, qa, qc, ca]) => row([label, inr(ia), ic, inr(qa), qc, inr(ca)], six, { bold: label === current }));
    const t = design.totals;
    row([`${design.year} total`, inr(t.invoiced.amount), t.invoiced.count, inr(t.quoted.amount), t.quoted.count, inr(t.convertedQuotes.amount)], six, { bold: true, shade: true });
    doc.font(f.body).fontSize(8).fillColor('#85735a').text('Invoiced and quoted are separate figures and are never added together; a converted quotation is counted under invoiced once its invoice is issued.', left, doc.y + 2, { width });
  }

  if (report.excludedNoGst.count > 0) {
    ensureSpace(30);
    doc.moveDown(0.8).font(f.body).fontSize(9).fillColor('#5b4b36')
      .text(`${report.excludedNoGst.count} older No GST bill${report.excludedNoGst.count === 1 ? '' : 's'} totalling ${inr(report.excludedNoGst.amount)} ${report.excludedNoGst.count === 1 ? 'is' : 'are'} not included in these figures.`, left, doc.y, { width });
  }

  if (notes) {
    heading('Notes to accountant');
    doc.font(f.body).fontSize(9.5).fillColor('#1f1a14').text(notes, left, doc.y, { width });
  }

  doc.end();
}

module.exports = { writePdf, writeXlsx, sections, fileName };
