const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { createTransporter } = require('../utils/mailer');
const { AREA_UNITS, round2, round4, sizeLabel, areaLabel, splitGstAll, gstByRate } = require('../utils/billing');

// Carbon's print colours: the light tokens of client/src/index.css (--print-*).
// Printed pages stay white with ink text; the brand brown marks headings,
// document numbers and totals. No paper tints and no shadows on paper.
const PRINT = {
  ink: '#1f1609',
  ink2: '#5b4b36',
  ink3: '#85735a',
  brand: '#704a00',
  line: '#d9c9ae',
  hair: '#eadfcd',
  success: '#0f7350',
  danger: '#b42318'
};

// Carbon's typefaces for PDFs, bundled in src/assets/fonts (SIL OFL, see
// OFL.txt): Inter for text, Sora for headings, JetBrains Mono for document
// numbers and labels. If the files are missing the PDF falls back to the
// built-in Helvetica / Courier rather than failing.
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = {
  body: 'Inter-Regular.ttf',
  bold: 'Inter-SemiBold.ttf',
  display: 'Sora-SemiBold.ttf',
  displayBold: 'Sora-Bold.ttf',
  mono: 'JetBrainsMono-SemiBold.ttf'
};
const FALLBACK_FONTS = { body: 'Helvetica', bold: 'Helvetica-Bold', display: 'Helvetica-Bold', displayBold: 'Helvetica-Bold', mono: 'Courier-Bold' };
let fontFilesPresent = null;
const carbonFontsAvailable = () => {
  if (fontFilesPresent === null) {
    fontFilesPresent = Object.values(FONT_FILES).every((file) => fs.existsSync(path.join(FONT_DIR, file)));
    if (!fontFilesPresent) console.warn('⚠️ Carbon PDF fonts not found in', FONT_DIR, '- using Helvetica');
  }
  return fontFilesPresent;
};
// Read once; every PDF after the first reuses the bytes.
const fontBuffers = {};
const fontBuffer = (file) => (fontBuffers[file] ||= fs.readFileSync(path.join(FONT_DIR, file)));

class PDFService {
  /** Registers Carbon's fonts on a PDFKit document and returns their names by role. */
  static carbonFonts(doc) {
    if (!carbonFontsAvailable()) return FALLBACK_FONTS;
    const names = {};
    for (const [role, file] of Object.entries(FONT_FILES)) {
      names[role] = `Carbon-${role}`;
      doc.registerFont(names[role], fontBuffer(file));
    }
    return names;
  }

  /** The same fonts as @font-face rules for the HTML (Puppeteer) documents. */
  static carbonFontFaceCss() {
    if (!carbonFontsAvailable()) return '';
    const face = (family, weight, file) =>
      `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${fontBuffer(file).toString('base64')}) format('truetype');}`;
    return [
      face('Inter', 400, FONT_FILES.body),
      face('Inter', 600, FONT_FILES.bold),
      face('Sora', 600, FONT_FILES.display),
      face('Sora', 700, FONT_FILES.displayBold),
      face('JetBrains Mono', 600, FONT_FILES.mono)
    ].join('\n');
  }

  // All customer and supplier PDFs use the shared PDFKit layout, which does
  // not need Chrome or native browser libraries on the server.
  static async generateInvoicePDFFromHTML(invoice, companyInfo) {
    return this.generateInvoicePDF(invoice, companyInfo);
  }

  static async generatePurchaseBillPDFFromHTML(bill, companyInfo) {
    return this.generatePurchaseBillPDF(bill, companyInfo);
  }

  static async generatePurchaseBillPDF(bill, companyInfo) {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const result = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    try {
      this.renderSynxDocument(doc, this.purchaseBillDocument(bill, companyInfo));
      doc.end();
      return await result;
    } catch (error) {
      doc.destroy();
      throw new Error('Failed to generate purchase bill PDF: ' + error.message);
    }
  }

  static generatePurchaseBillHTML(bill, companyInfo) {
    const fmt = (d) => d
      ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'N/A';
    const billDate = fmt(bill.billDate);
    const dueDate = fmt(bill.dueDate);

    const companyPhone = this.formatPhone(companyInfo.phone);
    const isInterState = bill.isInterState;
    const amountInWords = this.numberToWords(Math.floor(bill.totalAmount || 0));
    const isFullyPaid = (bill.paidAmount || 0) >= (bill.totalAmount || 0) && (bill.totalAmount || 0) > 0;
    const balanceDue = Math.max(0, (bill.totalAmount || 0) - (bill.paidAmount || 0));
    const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // GST column header(s)
    const gstHead = isInterState
      ? `<th style="padding:9px 6px;text-align:right;font-size:9pt;width:13%;font-weight:700;">IGST</th>`
      : `<th style="padding:9px 6px;text-align:right;font-size:9pt;width:12%;font-weight:700;">SGST</th>
         <th style="padding:9px 6px;text-align:right;font-size:9pt;width:12%;font-weight:700;">CGST</th>`;

    const itemsRows = (bill.items || []).map((item, index) => {
      const ratePct = item.gstRate || 0;
      const gstCells = isInterState
        ? `<td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:right;font-size:9.5pt;">${num(item.igstAmount)} <span style="color:${PRINT.ink3};font-size:8pt;">(${ratePct}%)</span></td>`
        : `<td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:right;font-size:9.5pt;">${num(item.sgstAmount)} <span style="color:${PRINT.ink3};font-size:8pt;">(${(ratePct / 2)}%)</span></td>
           <td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:right;font-size:9.5pt;">${num(item.cgstAmount)} <span style="color:${PRINT.ink3};font-size:8pt;">(${(ratePct / 2)}%)</span></td>`;
      return `
      <tr>
        <td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:center;color:${PRINT.ink2};font-size:9pt;">${index + 1}</td>
        <td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};font-size:9.5pt;">
          <div style="font-weight:600;">${item.description || ''}</div>
          ${item.hsnCode ? `<div style="color:${PRINT.ink3};font-size:8pt;margin-top:1px;">HSN/SAC: ${item.hsnCode}</div>` : ''}
        </td>
        <td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:right;font-size:9.5pt;">${num(item.rate)}</td>
        <td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:right;font-size:9.5pt;">${item.quantity || 0}</td>
        ${gstCells}
        <td style="padding:8px 6px;border-bottom:1px solid ${PRINT.hair};text-align:right;font-size:9.5pt;">${num(item.total)}</td>
      </tr>`;
    }).join('');

    const gstTotals = isInterState
      ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:${PRINT.ink2};"><span>IGST Amount</span><span>INR ${num(bill.totalIgstAmount)}</span></div>`
      : `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:${PRINT.ink2};"><span>SGST Amount</span><span>INR ${num(bill.totalSgstAmount)}</span></div>
         <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:${PRINT.ink2};"><span>CGST Amount</span><span>INR ${num(bill.totalCgstAmount)}</span></div>`;

    const paidRows = (bill.paidAmount || 0) > 0 ? `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:${PRINT.success};">
        <span>Amount Paid</span><span>INR ${num(bill.paidAmount)}</span>
      </div>
      ${balanceDue > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:10.5pt;font-weight:700;border-top:1px solid ${PRINT.line};margin-top:4px;color:${PRINT.danger};">
        <span>Balance Due</span><span>INR ${num(balanceDue)}</span>
      </div>` : ''}` : '';

    const addressLines = (companyInfo.address || '').split(',').map(s => s.trim()).filter(Boolean).join('<br>');
    const vendorAddressLines = (bill.vendorAddress || '').split(',').map(s => s.trim()).filter(Boolean).join('<br>');

    return this.enlargeBodyText(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Purchase Bill ${bill.billNumber}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    ${this.carbonFontFaceCss()}
    body { font-family: Inter, Arial, Helvetica, sans-serif; color:${PRINT.ink}; background:white; font-size:10pt; line-height:1.5; font-feature-settings:'tnum'; }
    .display { font-family: Sora, Inter, Arial, sans-serif; letter-spacing:-0.02em; }
    .id { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight:600; color:${PRINT.brand}; }
    .page { max-width:210mm; margin:0 auto; padding:14mm 18mm; }
  </style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
    <tr>
      <td style="vertical-align:top;">
        <div class="display" style="font-size:26pt;font-weight:700;color:${PRINT.ink};line-height:1;">${companyInfo.name || 'Company'}</div>
        <div style="margin-top:8px;">
          <div style="font-weight:700;font-size:10.5pt;">${(companyInfo.name || '').toUpperCase()}</div>
          ${companyInfo.address ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:3px;">${addressLines}</div>` : ''}
          ${companyInfo.email ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:2px;">Email: ${companyInfo.email}</div>` : ''}
          ${companyInfo.phone ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:2px;">Mobile: ${companyPhone}</div>` : ''}
          ${companyInfo.gstNumber ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:2px;">GSTIN: ${companyInfo.gstNumber}</div>` : ''}
        </div>
      </td>
      <td style="vertical-align:top;text-align:right;">
        <div class="display" style="font-size:24pt;font-weight:700;color:${PRINT.brand};line-height:1;">PURCHASE BILL</div>
        <div style="font-size:9.5pt;color:${PRINT.ink2};margin-top:8px;line-height:2.2;">
          <div>Bill Number: <strong class="id">${bill.billNumber}</strong></div>
          ${bill.vendorInvoiceNumber ? `<div>Invoice Number: <strong style="color:${PRINT.ink};">${bill.vendorInvoiceNumber}</strong></div>` : ''}
          <div>Date: <strong style="color:${PRINT.ink};">${billDate}</strong></div>
          <div>Due Date: <strong style="color:${PRINT.ink};">${dueDate}</strong></div>
        </div>
        ${isFullyPaid ? `<div style="display:inline-block;border:2px solid ${PRINT.success};color:${PRINT.success};font-weight:700;padding:3px 12px;font-size:9pt;margin-top:8px;letter-spacing:0.5px;">FULLY PAID</div>` : ''}
      </td>
    </tr>
  </table>

  <hr style="border:none;border-top:1px solid ${PRINT.line};margin:10px 0 14px 0;">

  <!-- VENDOR -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-weight:700;font-size:10pt;margin-bottom:5px;">Vendor</div>
        <div style="font-weight:600;font-size:10pt;">${bill.vendorName || 'N/A'}</div>
        ${bill.vendorGstNumber ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:2px;">${bill.vendorGstNumber}</div>` : ''}
        ${vendorAddressLines ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:2px;">${vendorAddressLines}</div>` : ''}
        ${bill.vendorState ? `<div style="font-size:9pt;color:${PRINT.ink2};margin-top:2px;">${bill.vendorState}</div>` : ''}
      </td>
    </tr>
  </table>

  <!-- ITEMS TABLE -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
    <thead>
      <tr style="border-top:1px solid ${PRINT.line};border-bottom:1px solid ${PRINT.ink};">
        <th style="padding:9px 6px;text-align:center;font-size:9pt;width:6%;font-weight:700;">Sno.</th>
        <th style="padding:9px 6px;text-align:left;font-size:9pt;font-weight:700;">Description</th>
        <th style="padding:9px 6px;text-align:right;font-size:9pt;width:13%;font-weight:700;">Rate</th>
        <th style="padding:9px 6px;text-align:right;font-size:9pt;width:7%;font-weight:700;">Qty</th>
        ${gstHead}
        <th style="padding:9px 6px;text-align:right;font-size:9pt;width:14%;font-weight:700;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows}
    </tbody>
  </table>

  <!-- TOTALS -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
    <tr>
      <td style="vertical-align:top;"></td>
      <td style="vertical-align:top;text-align:right;white-space:nowrap;min-width:240px;">
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:${PRINT.ink2};"><span>Taxable</span><span>INR ${num(bill.taxableAmount)}</span></div>
        ${gstTotals}
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11pt;font-weight:700;border-top:1px dashed ${PRINT.line};margin-top:4px;color:${PRINT.brand};"><span>Total Amount</span><span>INR ${num(bill.totalAmount)}</span></div>
        ${paidRows}
      </td>
    </tr>
  </table>

  <!-- AMOUNT IN WORDS -->
  <div style="border-top:1px solid ${PRINT.line};border-bottom:1px solid ${PRINT.line};padding:8px 0;font-size:9.5pt;margin:12px 0;">
    <strong>Total in Words:</strong> Indian Rupees ${amountInWords} Only
  </div>

  <!-- FOOTER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;padding-top:14px;border-top:1px solid ${PRINT.line};">
    <tr>
      <td style="vertical-align:top;padding-right:30px;">
        ${bill.notes ? `<div style="font-weight:700;font-size:10pt;margin-bottom:6px;">Notes</div>
          <div style="font-size:9pt;color:${PRINT.ink2};line-height:1.8;">${bill.notes}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right;min-width:210px;">
        <div style="font-weight:700;font-size:10pt;">For ${companyInfo.name || 'Company'}</div>
        <div style="height:55px;"></div>
        <div style="font-size:9.5pt;color:${PRINT.ink2};">Authorised Signatory</div>
      </td>
    </tr>
  </table>

</div>
</body>
</html>`);
  }

  // Body copy on this document printed too small to read comfortably. Every size
  // below the ceiling is lifted; the big headings keep the size they were given.
  static enlargeBodyText(html, factor = 1.2, ceilingPt = 12) {
    return html.replace(/font-size:\s*([\d.]+)pt/g, (match, size) => {
      const pt = parseFloat(size);
      return pt < ceilingPt ? `font-size:${(pt * factor).toFixed(1)}pt` : match;
    });
  }

  static formatPhone(phone) {
    if (!phone) return '';
    
    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');
    
    // Check if already has country code (starts with +)
    const hasPlus = phone.trim().startsWith('+');
    
    // Detect country code
    if (digits.startsWith('91') || (hasPlus && digits.startsWith('91')) || digits.length === 10) {
      // Indian number
      const last10 = digits.slice(-10);
      return `+91 ${last10.slice(0, 5)} ${last10.slice(5)}`;
    } else if (digits.startsWith('1') || (hasPlus && digits.startsWith('1'))) {
      // US/Canada: +1 (XXX) XXX-XXXX
      const last10 = digits.slice(-10);
      return `+1 (${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`;
    } else if (digits.startsWith('44') || (hasPlus && digits.startsWith('44'))) {
      // UK: +44 XXXX XXXXXX
      const withoutCode = digits.slice(-10);
      return `+44 ${withoutCode.slice(0, 4)} ${withoutCode.slice(4)}`;
    } else if (digits.startsWith('971') || (hasPlus && digits.startsWith('971'))) {
      // UAE: +971 XX XXX XXXX
      const withoutCode = digits.slice(-9);
      return `+971 ${withoutCode.slice(0, 2)} ${withoutCode.slice(2, 5)} ${withoutCode.slice(5)}`;
    } else if (digits.length > 10) {
      // Generic international format with country code
      const countryCode = digits.slice(0, -10);
      const number = digits.slice(-10);
      return `+${countryCode} ${number.slice(0, 5)} ${number.slice(5)}`;
    } else if (digits.length === 10) {
      // Assume Indian if 10 digits without country code
      return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    }
    
    // Return as-is if doesn't match patterns
    return phone;
  }

  // Same shared PDFKit layout as the invoice — see generateInvoicePDFFromHTML.
  static async generateQuotationPDFFromHTML(quotation, companyInfo) {
    return this.generateQuotationPDF(quotation, companyInfo);
  }

  static async generateQuotationPDF(quotation, companyInfo) {
    try {
      console.log('🔄 Starting PDFKit generation for quotation:', quotation.quotationNumber);

      const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));

      this.createSimpleQuotation(doc, quotation, companyInfo);

      return new Promise((resolve, reject) => {
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(chunks);
          console.log('✅ Quotation PDF generated, size:', pdfBuffer.length, 'bytes');
          resolve(pdfBuffer);
        });
        doc.on('error', reject);
        doc.end();
      });
    } catch (error) {
      console.error('❌ Quotation PDF generation error:', error.message);
      throw new Error('Failed to generate quotation PDF: ' + error.message);
    }
  }

  static createSimpleQuotation(doc, quotation, companyInfo) {
    return this.renderSynxQuotation(doc, quotation, companyInfo);
  }

  static async generateInvoicePDF(invoice, companyInfo) {
    try {
      console.log('🔄 Starting PDF generation for invoice:', invoice.invoiceNumber);

      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));

      this.createSimpleInvoice(doc, invoice, companyInfo);

      return new Promise((resolve, reject) => {
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(chunks);
          console.log('✅ PDF generated, size:', pdfBuffer.length, 'bytes');
          resolve(pdfBuffer);
        });

        doc.on('error', (error) => {
          console.error('❌ PDF generation error:', error.message);
          reject(error);
        });

        doc.end();
      });
    } catch (error) {
      console.error('❌ PDF generation error:', error.message);
      throw new Error('Failed to generate PDF: ' + error.message);
    }
  }

  static createSimpleInvoice(doc, invoice, companyInfo) {
    return this.renderSynxInvoice(doc, invoice, companyInfo);
  }

  // ==================== SynX-style PDF helpers ====================

  static decodeLogo(logo) {
    try {
      if (!logo || typeof logo !== 'string') return null;
      // PDFKit supports PNG and JPEG only
      const m = logo.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
      if (m) return Buffer.from(m[2], 'base64');
      return null;
    } catch (e) {
      return null;
    }
  }

  static fmtNum(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  static fmtQty(n) {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  // "5 boxes", "12.5 sq ft". Pieces is the default unit, so it is left off and
  // a plain count reads the same as it always has.
  static formatQtyWithUnit(n, unit) {
    const UNIT_LABELS = { grams: 'g', liters: 'L', meters: 'm', sqft: 'sq ft', sqm: 'sq m' };
    const qty = this.fmtQty(n);
    if (!unit || unit === 'pieces') return qty;
    return `${qty} ${UNIT_LABELS[unit] || unit}`;
  }

  static splitAddress(str) {
    if (!str || typeof str !== 'string') return [];
    const parts = str.includes('\n') ? str.split('\n') : str.split(',');
    return parts.map(p => p.trim()).filter(Boolean);
  }

  static currencyWords(currency) {
    const map = {
      INR: 'Indian Rupees',
      USD: 'United States Dollar',
      EUR: 'Euro',
      GBP: 'British Pound'
    };
    return map[currency] || 'Indian Rupees';
  }

  static bankLines(companyInfo) {
    const lines = [];
    if (companyInfo.bankName) lines.push('Bank Name: ' + companyInfo.bankName);
    if (companyInfo.accountName) lines.push('Account Name: ' + companyInfo.accountName);
    if (companyInfo.accountNumber) lines.push('Account Number: ' + companyInfo.accountNumber);
    if (companyInfo.ifscCode) lines.push('IFSC Code: ' + companyInfo.ifscCode);
    if (companyInfo.branchName) lines.push('Branch: ' + companyInfo.branchName);
    return lines;
  }

  /**
   * One row of the items table, from a line in either document's terms:
   * { name, description, hsn, quantity, unit, rate, amount, length, width,
   *   areaPerPiece, totalArea }. An area-priced line shows its size and area
   * per piece, its total area, the pieces and the rate per sq ft / sq m. The
   * line's note and HSN code print under its name.
   */
  static itemRow(line) {
    const size = sizeLabel(line);
    const areaUnit = AREA_UNITS[line.unit];
    const showArea = !!areaUnit && (line.totalArea || 0) > 0;
    const hsnGst = [line.hsn ? 'HSN: ' + line.hsn : '', line.gstRate > 0 ? `GST ${this.fmtQty(line.gstRate)}%` : ''].filter(Boolean).join(' · ');
    return {
      description: line.name || '',
      sub: [line.description, hsnGst].filter(Boolean).join('\n'),
      size,
      sizeSub: size && line.areaPerPiece > 0 ? `${areaLabel(line.areaPerPiece, line.unit)} each` : '',
      area: showArea ? areaLabel(line.totalArea, line.unit) : '',
      qty: showArea ? this.fmtQty(line.quantity) : this.formatQtyWithUnit(line.quantity, line.unit),
      rate: this.fmtNum(line.rate),
      rateSub: showArea ? `per ${areaUnit.label}` : '',
      amount: this.fmtNum(line.amount)
    };
  }

  /**
   * The tax rows of a document's summary, from its taxed parts (lines and the
   * design charge): "Taxable Amount", then CGST and SGST at half of each rate
   * (or IGST at the full rate between states), and a GST total when there is
   * more than one rate. Nothing when the document carries no tax.
   */
  static taxRows(parts, taxableAmount, money) {
    const rates = gstByRate(parts);
    if (!rates.length) return [];
    const pct = (n) => this.fmtQty(n) + '%';
    const rows = [{ label: 'Taxable Amount', value: money(taxableAmount) }];
    for (const r of rates) {
      if (r.cgst + r.sgst > 0) {
        rows.push({ label: `CGST @ ${pct(r.rate / 2)}`, value: money(r.cgst) });
        rows.push({ label: `SGST @ ${pct(r.rate / 2)}`, value: money(r.sgst) });
      }
      if (r.igst > 0) rows.push({ label: `IGST @ ${pct(r.rate)}`, value: money(r.igst) });
    }
    if (rates.length > 1) rows.push({ label: 'Total GST', value: money(rates.reduce((t, r) => t + r.gst, 0)) });
    return rows;
  }

  /** Everything the invoice PDF shows, before any drawing. */
  static invoiceDocument(invoice, companyInfo) {
    const customer = invoice.customerId || {};
    const currency = companyInfo.currency || 'INR';
    const money = (n) => currency + ' ' + this.fmtNum(n);

    const custName = invoice.customerName || customer.name || 'N/A';
    const custLines = [];
    const custGst = invoice.customerGstNumber || customer.gstNumber;
    if (custGst) custLines.push('GSTIN: ' + custGst);
    if (customer.phone) custLines.push('Phone: ' + customer.phone);
    if (customer.email) custLines.push('Email: ' + customer.email);

    const billing = this.splitAddress(invoice.customerAddress || customer.address);

    const items = (invoice.items || []).map((item) => {
      // Older area lines can say "pieces" in their unit; they were priced per sq ft.
      const isArea = item.itemType === 'Square Feet';
      const unit = isArea && !AREA_UNITS[item.unit] ? 'sqft' : item.unit;
      const areaPerPiece = item.areaPerPiece || (isArea && item.length > 0 && item.width > 0 ? round4(item.length * item.width) : 0);
      return this.itemRow({
        name: item.itemName,
        description: item.description,
        hsn: item.hsnCode,
        gstRate: invoice.noGst ? 0 : item.gstRate || 0,
        quantity: item.quantity,
        unit,
        rate: item.unitPrice || 0,
        amount: item.totalAmount != null ? item.totalAmount : (item.quantity || 0) * (item.unitPrice || 0),
        length: item.length,
        width: item.width,
        areaPerPiece,
        totalArea: isArea ? item.totalSquareFeet || 0 : 0
      });
    });

    const subtotal = invoice.subtotal != null ? invoice.subtotal : (invoice.items || []).reduce((s, i) => s + (i.totalAmount || 0), 0);
    const designCharge = invoice.designCharge || 0;
    const discount = invoice.discountAmount || 0;
    const total = invoice.totalAmount || 0;
    const paid = invoice.amountPaid != null ? invoice.amountPaid : (invoice.paidAmount || 0);

    // The tax each line and the design charge carry, as stored when priced.
    const taxParts = invoice.noGst ? [] : [
      ...(invoice.items || []).map((i) => ({
        gstRate: i.gstRate,
        taxableValue: i.taxableValue != null ? i.taxableValue : i.totalAmount,
        cgstAmount: i.cgstAmount,
        sgstAmount: i.sgstAmount,
        igstAmount: i.igstAmount
      })),
      {
        gstRate: invoice.designChargeGstRate,
        taxableValue: invoice.designChargeTaxableValue,
        cgstAmount: invoice.designChargeCgstAmount,
        sgstAmount: invoice.designChargeSgstAmount,
        igstAmount: invoice.designChargeIgstAmount
      }
    ];
    const taxableAmount = invoice.taxableAmount != null ? invoice.taxableAmount : round2(subtotal + designCharge - discount);

    const summary = [{ label: 'Subtotal', value: money(subtotal) }];
    if (designCharge > 0) summary.push({ label: 'Design Charge', value: money(designCharge) });
    if (discount > 0) summary.push({ label: 'Discount', value: '- ' + money(discount) });
    summary.push(...this.taxRows(taxParts, taxableAmount, money));
    summary.push({ label: 'Total', value: money(total), bold: true });
    if (paid > 0 && paid < total) {
      summary.push({ label: 'Paid', value: money(paid) });
      summary.push({ label: 'Balance Due', value: money(round2(total - paid)), strong: true });
    }

    return {
      type: 'INVOICE',
      numberLabel: 'Invoice No.',
      number: invoice.invoiceNumber || '',
      meta: [
        { label: 'Invoice Date', value: new Date(invoice.invoiceDate || Date.now()).toLocaleDateString('en-GB') },
        ...(invoice.dueDate ? [{ label: 'Due Date', value: new Date(invoice.dueDate).toLocaleDateString('en-GB') }] : [])
      ],
      badge: total > 0 && paid >= total ? { text: 'FULLY PAID', color: PRINT.success } : null,
      company: companyInfo,
      customer: { name: custName, lines: custLines },
      billingLines: billing,
      shippingLines: billing,
      items,
      bankLines: this.bankLines(companyInfo),
      summary,
      amountWords: this.currencyWords(currency) + ' ' + this.numberToWords(Math.floor(total)) + ' Only',
      terms: invoice.termsAndConditions || 'Payment must be completed as per the agreed terms.',
      footerNote: null,
      qrCode: companyInfo.paymentQRCode || '',
      paymentLink: invoice.paymentLink || '',
      upiId: companyInfo.upiId || ''
    };
  }

  /** Supplier bill data for the same browser-free layout as invoices. */
  static purchaseBillDocument(bill, companyInfo) {
    const currency = companyInfo.currency || 'INR';
    const money = (n) => currency + ' ' + this.fmtNum(n);
    const total = Number(bill.totalAmount) || 0;
    const paid = Number(bill.paidAmount) || 0;
    const summary = [{ label: 'Taxable', value: money(bill.taxableAmount) }];
    if (bill.isInterState) {
      if (bill.totalIgstAmount) summary.push({ label: 'IGST', value: money(bill.totalIgstAmount) });
    } else {
      if (bill.totalCgstAmount) summary.push({ label: 'CGST', value: money(bill.totalCgstAmount) });
      if (bill.totalSgstAmount) summary.push({ label: 'SGST', value: money(bill.totalSgstAmount) });
    }
    summary.push({ label: 'Total', value: money(total), bold: true });
    if (paid > 0 && paid < total) {
      summary.push({ label: 'Paid', value: money(paid) });
      summary.push({ label: 'Balance Due', value: money(round2(total - paid)), strong: true });
    }

    return {
      type: 'PURCHASE BILL',
      numberLabel: 'Bill No.',
      number: bill.billNumber || '',
      meta: [
        ...(bill.vendorInvoiceNumber ? [{ label: 'Vendor Invoice', value: bill.vendorInvoiceNumber }] : []),
        { label: 'Bill Date', value: new Date(bill.billDate || Date.now()).toLocaleDateString('en-GB') },
        ...(bill.dueDate ? [{ label: 'Due Date', value: new Date(bill.dueDate).toLocaleDateString('en-GB') }] : [])
      ],
      badge: total > 0 && paid >= total ? { text: 'FULLY PAID', color: PRINT.success } : null,
      company: companyInfo,
      customer: { name: bill.vendorName || 'N/A', lines: [bill.vendorGstNumber && `GSTIN: ${bill.vendorGstNumber}`, bill.vendorState].filter(Boolean) },
      billingLines: this.splitAddress(bill.vendorAddress),
      shippingLines: [],
      items: (bill.items || []).map((item) => this.itemRow({
        name: item.description,
        hsn: item.hsnCode,
        gstRate: item.gstRate,
        quantity: item.quantity,
        rate: item.rate,
        amount: item.taxableAmount != null ? item.taxableAmount : round2((item.rate || 0) * (item.quantity || 0))
      })),
      bankLines: [],
      summary,
      amountWords: this.currencyWords(currency) + ' ' + this.numberToWords(Math.floor(total)) + ' Only',
      terms: bill.notes || '',
      footerNote: null,
      qrCode: '',
      paymentLink: '',
      upiId: ''
    };
  }

  /** Everything the quotation PDF shows, before any drawing. */
  static quotationDocument(quotation, companyInfo) {
    const customer = quotation.customer_id || {};
    const currency = companyInfo.currency || 'INR';
    const money = (n) => currency + ' ' + this.fmtNum(n);

    const custLines = [];
    if (customer.gstNumber) custLines.push('GSTIN: ' + customer.gstNumber);
    if (customer.phone) custLines.push('Phone: ' + customer.phone);
    if (customer.email) custLines.push('Email: ' + customer.email);

    const items = (quotation.items || []).map((item) =>
      this.itemRow({
        name: item.item_name,
        description: item.description,
        hsn: item.hsn_code,
        gstRate: item.tax_amount > 0 ? item.tax_rate || 0 : 0,
        quantity: item.quantity,
        unit: item.unit,
        rate: item.unit_price || 0,
        // A line keeps its tax inside total_amount.
        amount: item.total_amount != null ? item.total_amount - (item.tax_amount || 0) : (item.quantity || 0) * (item.unit_price || 0),
        length: item.length,
        width: item.width,
        areaPerPiece: item.area_per_piece,
        totalArea: item.total_area
      })
    );

    const designCharge = quotation.design_charge || 0;
    const total = quotation.total_amount || 0;
    // Quotation lines store only their tax; it splits the way it was charged
    // (lines, then the design charge — utils/billing.js applyGst).
    const interstate = quotation.is_interstate === true;
    const rawParts = [
      ...(quotation.items || []).map((i) => ({ gstRate: i.tax_rate, taxableValue: (i.total_amount || 0) - (i.tax_amount || 0), gstAmount: round2(i.tax_amount || 0) })),
      { gstRate: quotation.design_charge_tax_rate, taxableValue: designCharge, gstAmount: round2(quotation.design_charge_tax_amount || 0) }
    ];
    const splits = splitGstAll(rawParts.map((p) => p.gstAmount), interstate);
    const taxParts = rawParts.map((p, i) => ({ ...p, ...splits[i] }));
    const discount = quotation.discount_amount || 0;
    const summary = [{ label: 'Subtotal', value: money(quotation.subtotal || 0) }];
    if (designCharge > 0) summary.push({ label: 'Design Charge', value: money(designCharge) });
    if (discount > 0) summary.push({ label: 'Discount', value: '- ' + money(discount) });
    summary.push(...this.taxRows(taxParts, round2((quotation.subtotal || 0) + designCharge - discount), money));
    summary.push({ label: 'Total', value: money(total), bold: true });

    const billing = this.splitAddress(customer.address);
    const shipping = this.splitAddress(quotation.shipping_address || customer.address);
    return {
      type: 'QUOTATION',
      numberLabel: 'Quotation No.',
      number: quotation.quotationNumber || '',
      meta: [
        { label: 'Date', value: new Date(quotation.createdAt || Date.now()).toLocaleDateString('en-GB') },
        ...(quotation.valid_until ? [{ label: 'Valid Until', value: new Date(quotation.valid_until).toLocaleDateString('en-GB') }] : [])
      ],
      badge: null,
      company: companyInfo,
      customer: { name: customer.name || 'N/A', lines: custLines },
      billingLines: billing,
      shippingLines: shipping,
      items,
      bankLines: this.bankLines(companyInfo),
      summary,
      amountWords: this.currencyWords(currency) + ' ' + this.numberToWords(Math.floor(total)) + ' Only',
      terms: quotation.terms_conditions ||
        '1. This quotation is valid for the period mentioned above.\n2. Prices are subject to change without prior notice after validity.\n3. All disputes subject to local jurisdiction.',
      footerNote: null,
      qrCode: companyInfo.paymentQRCode || '',
      paymentLink: quotation.payment_link || '',
      upiId: companyInfo.upiId || ''
    };
  }

  static renderSynxInvoice(doc, invoice, companyInfo) {
    return this.renderSynxDocument(doc, this.invoiceDocument(invoice, companyInfo));
  }

  static renderSynxQuotation(doc, quotation, companyInfo) {
    return this.renderSynxDocument(doc, this.quotationDocument(quotation, companyInfo));
  }

  // ==================== The invoice / quotation page ====================
  //
  // One A4 layout for both documents, drawn with PDFKit at fixed point sizes.
  // The PDF it makes is the document itself: it is what is downloaded, emailed,
  // sent on WhatsApp and printed (the app prints this file's pages — see
  // client/src/lib/printPdf.ts), so there is a single rendering of an invoice
  // and nothing that can drift from it.
  //
  // Sizes are chosen for paper, not the screen: 10.5 pt lines, nothing under
  // 9 pt but small-capital labels and page numbers, dark ink, and a 100 pt
  // (≈ 35 mm) payment QR.
  // Columns are only drawn when a line uses them, so an invoice without sized
  // items gives the width to its descriptions. Every block is measured before it
  // is drawn: a page breaks only when the next item row, totals or sign-off
  // would not fit, the table heading repeats on each page, and an item row is
  // never split.

  static get PAGE_LAYOUT() {
    return {
      margin: 36, // 12.7 mm sides and top: clear of any printer's unprintable edge
      contentBottom: 46, // the body stops this far above the bottom edge…
      footer: 28, // …and the page numbers sit here, below it
      size: { title: 24, company: 16, detail: 10, label: 8.5, party: 12, meta: 10.5, th: 9.5, cell: 10.5, sub: 9, sum: 10.5, total: 13, words: 10.5, terms: 9.5, sign: 10.5, footer: 8.5 },
      qr: 100
    };
  }

  static renderSynxDocument(doc, d) {
    const { margin: M, contentBottom, footer: FOOTER, size: S, qr: QR } = this.PAGE_LAYOUT;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = M;
    const right = pageW - M;
    const W = right - left;
    const bottom = pageH - contentBottom;
    const C = { ink: PRINT.ink, text: PRINT.ink, muted: PRINT.ink2, rule: PRINT.ink3, hair: PRINT.line, brand: PRINT.brand };
    const F = this.carbonFonts(doc);
    // Figures line up in columns (Inter's tabular numbers); the built-in fonts have none to ask for.
    const TNUM = F === FALLBACK_FONTS ? undefined : ['tnum'];
    const LINE_GAP = 1.5;
    const docName = d.type.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

    // Each position is set explicitly and each block measured before it is
    // drawn, so PDFKit's own flowing page break must never fire. Without a
    // bottom margin it cannot.
    doc.page.margins.bottom = 0;

    // face: 'display' (Sora) for headings, 'mono' (JetBrains Mono) for document
    // numbers and labels; text is Inter.
    const fontOf = (bold, face) =>
      face === 'display' ? (bold ? F.displayBold : F.display) : face === 'mono' ? F.mono : bold ? F.bold : F.body;
    const style = (size, bold, color, face) => doc.font(fontOf(bold, face)).fontSize(size).fillColor(color || C.text);
    const measure = (text, size, width, bold = false, face, features) => {
      if (text == null || text === '') return 0;
      style(size, bold, undefined, face);
      return doc.heightOfString(String(text), { width, lineGap: LINE_GAP, features });
    };
    // Draws text and returns the y just under it.
    const write = (text, x, y, size, o = {}) => {
      if (text == null || text === '') return y;
      style(size, o.bold, o.color, o.face);
      doc.text(String(text), x, y, { width: o.width, align: o.align || 'left', lineGap: LINE_GAP, characterSpacing: o.spacing || 0, link: o.link || null, underline: !!o.link, features: o.features });
      return y + measure(text, size, o.width, o.bold, o.face, o.features);
    };
    const label = (text, x, y, width, align = 'left') =>
      write(String(text).toUpperCase(), x, y, S.label, { bold: true, face: 'mono', color: C.muted, width, align, spacing: 0.2 });
    const rule = (y, color = C.hair, weight = 0.75) => {
      doc.moveTo(left, y).lineTo(right, y).lineWidth(weight).strokeColor(color).stroke();
    };

    let y = M;

    // A later page starts with what it continues, so a loose sheet is still
    // identifiable.
    const continuation = () => {
      doc.addPage({ size: 'A4', margins: { top: M, left: M, right: M, bottom: 0 } });
      y = M;
      write(`${docName} ${d.number} (continued)`, left, y, 11, { bold: true, color: C.ink, width: W * 0.6 });
      write(d.customer.name || '', left + W * 0.6, y + 1, S.detail, { color: C.muted, width: W * 0.4, align: 'right' });
      y += 18;
      rule(y, C.ink, 1);
      y += 10;
    };

    // ---------- HEADER: logo and business (left), the document (right) ----------
    const headR = 160;
    const headL = W - headR - 16;
    write(d.type, right - headR, y - 3, d.type === 'PURCHASE BILL' ? 16 : S.title, { bold: true, face: 'display', color: C.brand, width: headR, align: 'right' });
    let ry = y + 32;
    if (d.type === 'QUOTATION') {
      [{ label: d.numberLabel || 'Number', value: d.number, id: true }, ...(d.meta || [])].forEach((row) => {
        write(row.label, right - 210, ry, S.detail, { width: 86, align: 'right', color: C.muted });
        ry = write(row.value, right - 116, ry, S.meta, { width: 116, align: 'right', bold: true, ...(row.id ? { face: 'mono', color: C.brand } : { color: C.ink }) }) + 2;
      });
    }
    if (d.badge) {
      const bw = 104;
      const bh = 21;
      const bx = right - bw;
      doc.roundedRect(bx, ry, bw, bh, 3).lineWidth(1.2).strokeColor(d.badge.color).stroke();
      write(d.badge.text, bx, ry + 6, 9.5, { bold: true, color: d.badge.color, width: bw, align: 'center' });
      ry += bh + 4;
    }

    // The logo sits beside the business's name and address, not above them.
    let textX = left;
    let logoBottom = y;
    const logo = this.decodeLogo(d.company.logo);
    if (logo) {
      try {
        const img = doc.openImage(logo);
        const scale = Math.min(110 / img.width, 64 / img.height);
        doc.image(img, left, y, { width: img.width * scale, height: img.height * scale });
        textX = left + img.width * scale + 14;
        logoBottom = y + img.height * scale;
      } catch (e) {
        /* an unreadable logo is left off */
      }
    }
    const textW = left + headL - textX;
    let ly = write((d.company.name || 'Company').toUpperCase(), textX, y, S.company, { bold: true, face: 'display', color: C.ink, width: textW }) + 2;
    // Phone and email share a line when it fits; so do GSTIN and PAN.
    const pair = (a, b) => {
      if (!a || !b) return [a || b];
      style(S.detail);
      return doc.widthOfString(a + '    ' + b) <= textW ? [a + '    ' + b] : [a, b];
    };
    const companyLines = [
      ...(d.company.addressLines || []),
      ...pair(d.company.phone && 'Phone: ' + d.company.phone, d.company.email && 'Email: ' + d.company.email),
      ...pair(d.company.gstNumber && 'GSTIN: ' + d.company.gstNumber, d.company.panNumber && 'PAN: ' + d.company.panNumber)
    ].filter(Boolean);
    for (const line of companyLines) ly = write(line, textX, ly, S.detail, { width: textW });

    y = Math.max(ly, ry, logoBottom) + 10;
    rule(y, C.ink, 1.2);
    y += 12;

    // ---------- CUSTOMER AND ADDRESSES ----------
    const metaW = 220;
    const metaX = right - metaW;
    const partyW = W - metaW - 24;
    const billing = d.billingLines || [];
    const shipping = d.shippingLines || [];
    const shipDiffers = shipping.length > 0 && shipping.join('\n') !== billing.join('\n');
    const partyCol = shipDiffers ? (partyW - 16) / 2 : partyW;

    if (d.type === 'QUOTATION') {
      const gap = 16;
      const colW = (W - gap * 2) / 3;
      const sections = [
        { title: 'Customer', lines: [d.customer.name || 'N/A', ...(d.customer.lines || [])] },
        { title: 'Billing Address', lines: billing.length ? billing : ['N/A'] },
        { title: 'Shipping Address', lines: shipping.length ? shipping : ['N/A'] }
      ];
      let bottomOfParty = y;
      sections.forEach((section, index) => {
        const x = left + index * (colW + gap);
        let sy = label(section.title, x, y, colW) + 4;
        section.lines.forEach((line, lineIndex) => {
          sy = write(line, x, sy, lineIndex === 0 && index === 0 ? S.party : S.detail, {
            bold: lineIndex === 0 && index === 0,
            color: C.ink,
            width: colW
          });
        });
        bottomOfParty = Math.max(bottomOfParty, sy);
      });
      y = bottomOfParty + 14;
    } else {
      let py = label(d.type === 'PURCHASE BILL' ? 'Vendor' : 'Bill To', left, y, partyCol) + 3;
      py = write(d.customer.name || 'N/A', left, py, S.party, { bold: true, color: C.ink, width: partyCol }) + 1;
      for (const line of [...billing, ...(d.customer.lines || [])]) py = write(line, left, py, S.detail, { width: partyCol });
      if (shipDiffers) {
        const sx = left + partyCol + 16;
        let sy = label('Ship To', sx, y, partyCol) + 3;
        for (const line of shipping) sy = write(line, sx, sy, S.detail, { width: partyCol });
        py = Math.max(py, sy);
      }

      let my = y;
      const metaLabelW = 96;
      for (const row of [{ label: d.numberLabel || 'Number', value: d.number, id: true }, ...(d.meta || [])]) {
        const face = row.id ? 'mono' : undefined;
        const h = Math.max(measure(row.label, S.detail, metaLabelW), measure(row.value, S.meta, metaW - metaLabelW, true, face));
        write(row.label, metaX, my + 0.5, S.detail, { color: C.muted, width: metaLabelW });
        write(row.value, metaX + metaLabelW, my, S.meta, { bold: true, face, color: row.id ? C.brand : C.ink, width: metaW - metaLabelW, align: 'right' });
        my += h + 4;
      }
      y = Math.max(py, my) + 14;
    }

    // ---------- ITEMS ----------
    // Size and Area appear when a line is priced by area (6 × 4 ft, 24 sq ft
    // each, 240 sq ft for 10 pieces); otherwise their width goes to Description.
    const hasArea = d.items.some((it) => it.size || it.area);
    const cols = hasArea
      ? [{ key: 'sno', head: '#', w: 22 }, { key: 'desc', head: 'Item & Description' }, { key: 'size', head: 'Size (L × W)', w: 76 }, { key: 'area', head: 'Area', w: 62 }, { key: 'qty', head: 'Qty', w: 52 }, { key: 'rate', head: 'Rate', w: 70 }, { key: 'amount', head: 'Amount', w: 88 }]
      : [{ key: 'sno', head: '#', w: 22 }, { key: 'desc', head: 'Item & Description' }, { key: 'qty', head: 'Qty', w: 76 }, { key: 'rate', head: 'Rate', w: 86 }, { key: 'amount', head: 'Amount', w: 96 }];
    const fixedW = cols.reduce((sum, c) => sum + (c.w || 0), 0);
    let cx = left;
    for (const c of cols) {
      c.w = c.w || W - fixedW;
      c.x = cx;
      c.align = c.key === 'sno' || c.key === 'desc' ? 'left' : 'right';
      cx += c.w;
    }
    const PAD = 5;
    const ROW_PAD = 5;
    const TH_H = 22;
    const cellsOf = (it, i) => ({
      sno: [String(i + 1)],
      desc: [it.description, it.sub],
      size: [it.size || '–', it.sizeSub],
      area: [it.area || '–'],
      qty: [it.qty],
      rate: [it.rate, it.rateSub],
      amount: [it.amount]
    });
    const rowHeight = (cells) =>
      Math.max(
        ...cols.map((c) => {
          const [main, sub] = cells[c.key];
          const w = c.w - PAD * 2;
          const features = c.align === 'right' ? TNUM : undefined;
          return measure(main || ' ', S.cell, w, false, undefined, features) + (sub ? 1.5 + measure(sub, S.sub, w, false, undefined, features) : 0);
        })
      ) + ROW_PAD * 2;
    // The heading row is ruled above and below rather than shaded: no tint on paper.
    const tableHead = () => {
      rule(y, C.hair, 0.75);
      for (const c of cols) write(c.head, c.x + PAD, y + 6.5, S.th, { bold: true, color: C.ink, width: c.w - PAD * 2, align: c.align });
      y += TH_H;
      rule(y, C.ink, 0.9);
    };
    const drawRow = (cells, h) => {
      for (const c of cols) {
        const [main, sub] = cells[c.key];
        const w = c.w - PAD * 2;
        const features = c.align === 'right' ? TNUM : undefined;
        const under = write(main, c.x + PAD, y + ROW_PAD, S.cell, { width: w, align: c.align, color: C.ink, features });
        if (sub) write(sub, c.x + PAD, under + 1.5, S.sub, { width: w, align: c.align, color: C.muted, features });
      }
      y += h;
      rule(y, C.hair, 0.6);
    };

    const rows = d.items.map((it, i) => {
      const cells = cellsOf(it, i);
      return { cells, h: rowHeight(cells) };
    });
    // The heading never sits alone at the foot of a page.
    if (rows.length && y + TH_H + rows[0].h > bottom) continuation();
    tableHead();
    let rowsOnPage = 0;
    for (const row of rows) {
      if (y + row.h > bottom && rowsOnPage > 0) {
        continuation();
        tableHead();
        rowsOnPage = 0;
      }
      drawRow(row.cells, row.h);
      rowsOnPage += 1;
    }
    rule(y, C.rule, 0.9);

    // ---------- CLOSING BLOCK, in three columns kept together ----------
    // Left: amount in words, bank details, terms. Middle: the payment QR and
    // UPI ID. Right: the totals, then the signature. Side by side rather than
    // stacked, so an invoice of a few described lines still fits one page.
    const qr = this.decodeLogo(d.qrCode);
    const hasPay = !!(qr || d.upiId || d.paymentLink);
    const GAP = 18;
    const sumW = 206;
    const payW = hasPay ? QR : 0;
    const sideW = W - sumW - GAP - (hasPay ? payW + GAP : 0);
    const sumX = right - sumW;
    const payX = left + sideW + GAP;
    const SUM_ROW = 16;
    const TOTAL_ROW = 26;
    const SIGN_SPACE = 40;
    const LABEL_H = 12 + 3;
    const BLOCK_GAP = 14;

    const BANK_LABELS = { 'Bank Name': 'Bank', 'Account Name': 'A/c Name', 'Account Number': 'A/c No.', 'IFSC Code': 'IFSC' };
    const bank = (d.bankLines || []).map((line) => {
      const at = line.indexOf(': ');
      if (at < 0) return { label: '', value: line };
      const name = line.slice(0, at);
      return { label: BANK_LABELS[name] || name, value: line.slice(at + 2) };
    });
    const bankLabelW = 58;
    const bankRowH = (r) => Math.max(measure(r.label, S.detail, bankLabelW), measure(r.value, S.detail, sideW - bankLabelW, true)) + 2;
    const termsText = [d.footerNote, d.terms].filter(Boolean).join('\n');
    const sideH =
      LABEL_H + measure(d.amountWords, S.words, sideW, true) +
      (bank.length ? BLOCK_GAP + LABEL_H + bank.reduce((h, r) => h + bankRowH(r), 0) : 0) +
      (termsText ? BLOCK_GAP + LABEL_H + measure(termsText, S.terms, sideW) : 0);
    // A UPI ID has no spaces to wrap at. It is set small enough to fit on one
    // line (it may run into the gutter); one too long for that even at 8.5 pt
    // goes onto two lines at its "@", never broken at an arbitrary letter.
    const upiW = payW + GAP - 4;
    let upiText = d.upiId || '';
    let upiSize = 9.5;
    if (upiText) {
      const fit = (text) => {
        style(9.5, true);
        const widest = Math.max(...text.split('\n').map((part) => doc.widthOfString(part)));
        return Math.min(9.5, (9.5 * upiW) / widest);
      };
      if (fit(upiText) < 8.5 && upiText.includes('@')) upiText = upiText.replace('@', '\n@');
      upiSize = Math.max(8.5, fit(upiText));
    }
    const upiH = upiText ? measure('UPI ID', S.label, payW, true) + measure(upiText, upiSize, upiW, true) : 0;
    const payH = hasPay ? LABEL_H + (qr ? QR + 4 : 0) + upiH + (d.paymentLink ? 2 + measure(d.paymentLink, 9, payW) : 0) : 0;
    const signer = 'For ' + (d.company.name || 'Company');
    const sumH =
      d.summary.reduce((h, s) => h + (s.bold ? TOTAL_ROW + 4 : SUM_ROW), 0) +
      22 + measure(signer, S.sign, sumW, true) + SIGN_SPACE + 4 + 13;

    y += 12;
    if (y + Math.max(sideH, payH, sumH) > bottom) continuation();
    const blockTop = y;

    // Right: totals, then the signature under them.
    let sy = blockTop;
    for (const s of d.summary) {
      if (s.bold) {
        // The total: a dashed rule above it and the figure in the brand colour
        sy += 2;
        doc.save().moveTo(sumX, sy).lineTo(right, sy).lineWidth(0.9).dash(3, { space: 2 }).strokeColor(PRINT.line).stroke().restore();
        write(s.label, sumX + 8, sy + 6.5, S.total, { bold: true, color: C.brand, width: 70 });
        write(s.value, sumX + 78, sy + 6.5, S.total, { bold: true, color: C.brand, width: sumW - 86, align: 'right', features: TNUM });
        sy += TOTAL_ROW + 2;
      } else {
        const color = s.strong ? C.ink : C.text;
        write(s.label, sumX + 8, sy, S.sum, { bold: !!s.strong, color, width: sumW * 0.5 - 8 });
        write(s.value, sumX + sumW * 0.5, sy, S.sum, { bold: !!s.strong, color, width: sumW * 0.5 - 8, align: 'right', features: TNUM });
        sy += SUM_ROW;
      }
    }
    sy = write(signer, sumX, sy + 22, S.sign, { bold: true, color: C.ink, width: sumW, align: 'right' }) + SIGN_SPACE;
    doc.moveTo(sumX + 30, sy).lineTo(right, sy).lineWidth(0.75).strokeColor(C.rule).stroke();
    sy = write('Authorised Signatory', sumX, sy + 4, S.terms, { color: C.muted, width: sumW, align: 'right' });

    // Middle: how to pay.
    let qy = blockTop;
    if (hasPay) {
      qy = label(qr ? 'Scan to pay' : 'Payment', payX, qy, payW) + 3;
      if (qr) {
        try {
          doc.image(qr, payX, qy, { fit: [QR, QR] });
          qy += QR + 4;
        } catch (e) {
          /* an unreadable QR image is left off */
        }
      }
      if (d.upiId) {
        qy = label('UPI ID', payX, qy, payW);
        qy = write(upiText, payX, qy, upiSize, { bold: true, color: C.ink, width: upiW });
      }
      if (d.paymentLink) qy = write(d.paymentLink, payX, qy + 2, 9, { color: C.brand, width: payW, link: d.paymentLink });
    }

    // Left: the amount in words, where to pay, and the terms.
    let wy = label('Amount in words', left, blockTop, sideW) + 3;
    wy = write(d.amountWords, left, wy, S.words, { bold: true, color: C.ink, width: sideW });
    if (bank.length) {
      wy = label('Bank details', left, wy + BLOCK_GAP, sideW) + 3;
      for (const r of bank) {
        const h = bankRowH(r);
        write(r.label, left, wy, S.detail, { color: C.muted, width: bankLabelW });
        write(r.value, left + bankLabelW, wy, S.detail, { bold: true, color: C.ink, width: sideW - bankLabelW });
        wy += h;
      }
    }
    if (termsText) {
      wy = label('Terms & Conditions', left, wy + BLOCK_GAP, sideW) + 3;
      wy = write(termsText, left, wy, S.terms, { width: sideW });
    }
    y = Math.max(sy, qy, wy);

    // ---------- PAGE NUMBERS, once the page count is known ----------
    if (doc.options.bufferPages) {
      const range = doc.bufferedPageRange();
      if (range.count > 1) {
        for (let i = 0; i < range.count; i += 1) {
          doc.switchToPage(range.start + i);
          doc.page.margins.bottom = 0;
          const fy = pageH - FOOTER;
          rule(fy - 6, C.hair, 0.6);
          write(`${docName} ${d.number}`, left, fy, S.footer, { color: C.muted, width: W / 2 });
          write(`Page ${i + 1} of ${range.count}`, left + W / 2, fy, S.footer, { color: C.muted, width: W / 2, align: 'right' });
        }
      }
    }
  }

  static numberToWords(num) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const scales = ['', 'Thousand', 'Lakh', 'Crore'];

    if (num === 0) return 'Zero';

    let words = '';
    let scaleIndex = 0;

    while (num > 0 && scaleIndex < scales.length) {
      const chunk = num % (scaleIndex === 0 ? 1000 : 100);
      if (chunk > 0) {
        words = this.convertChunk(chunk, ones, teens, tens) + (scales[scaleIndex] ? ' ' + scales[scaleIndex] : '') + (words ? ' ' + words : '');
      }
      num = Math.floor(num / (scaleIndex === 0 ? 1000 : 100));
      scaleIndex++;
    }

    return words;
  }

  static convertChunk(num, ones, teens, tens) {
    let words = '';

    if (num >= 100) {
      words += ones[Math.floor(num / 100)] + ' Hundred';
      num %= 100;
      if (num > 0) words += ' ';
    }

    if (num >= 20) {
      words += tens[Math.floor(num / 10)];
      if (num % 10 > 0) words += ' ' + ones[num % 10];
    } else if (num >= 10) {
      words += teens[num - 10];
    } else if (num > 0) {
      words += ones[num];
    }

    return words;
  }

  static async sendInvoiceEmail(invoiceBuffer, recipientEmail, invoiceName, customMessage = null) {
    try {
      const transporter = createTransporter();

      // Use custom message if provided, otherwise use default
      const emailBody = customMessage
        ? customMessage.replace(/\n/g, '<br>')
        : '<p>Please find the attached invoice.</p>';

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: recipientEmail,
        subject: `Invoice: ${invoiceName}`,
        html: emailBody,
        attachments: [
          {
            filename: `${invoiceName}.pdf`,
            content: invoiceBuffer
          }
        ]
      });

      console.log('✅ Email sent successfully to:', recipientEmail);
    } catch (error) {
      console.error('❌ Email sending error:', error.message);
      throw error;
    }
  }
}

module.exports = PDFService;
