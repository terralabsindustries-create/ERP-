const PDFDocument = require('pdfkit');
const { createTransporter } = require('../utils/mailer');
const { AREA_UNITS, round4, sizeLabel, areaLabel } = require('../utils/billing');

// Puppeteer ships as ES-module only. require() of ESM is unsupported on Node 20
// (which is what Electron bundles), so it is imported on demand instead. That
// keeps this file loadable on every runtime, and Chromium is only touched when
// a PDF is actually rendered.
let puppeteerPromise = null;
const getPuppeteer = () => {
  if (!puppeteerPromise) {
    puppeteerPromise = import('puppeteer').then((m) => m.default || m);
  }
  return puppeteerPromise;
};

class PDFService {
  // Invoices and quotations both render through the shared PDFKit layout
  // (renderSynxDocument), so the two documents stay visually identical and
  // neither depends on a working Chrome install.
  static async generateInvoicePDFFromHTML(invoice, companyInfo) {
    return this.generateInvoicePDF(invoice, companyInfo);
  }

  static async generatePurchaseBillPDFFromHTML(bill, companyInfo) {
    try {
      console.log('🔄 Starting HTML to PDF conversion for purchase bill:', bill.billNumber);

      const htmlContent = this.generatePurchaseBillHTML(bill, companyInfo);

      let browser;
      try {
        const puppeteer = await getPuppeteer();
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
          format: 'A4',
          margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
          printBackground: true
        });

        await browser.close();
        console.log('✅ Purchase bill PDF generated, size:', pdfBuffer.length, 'bytes');
        return Buffer.from(pdfBuffer);
      } catch (puppeteerError) {
        console.warn('⚠️ Puppeteer error for purchase bill:', puppeteerError.message);
        if (browser) {
          try { await browser.close(); } catch (e) { console.warn('Error closing browser:', e.message); }
        }
        throw puppeteerError;
      }
    } catch (error) {
      console.error('❌ Purchase bill PDF generation error:', error.message);
      throw new Error('Failed to generate PDF: ' + error.message);
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
        ? `<td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;font-size:9.5pt;">${num(item.igstAmount)} <span style="color:#888;font-size:8pt;">(${ratePct}%)</span></td>`
        : `<td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;font-size:9.5pt;">${num(item.sgstAmount)} <span style="color:#888;font-size:8pt;">(${(ratePct / 2)}%)</span></td>
           <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;font-size:9.5pt;">${num(item.cgstAmount)} <span style="color:#888;font-size:8pt;">(${(ratePct / 2)}%)</span></td>`;
      return `
      <tr>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center;color:#666;font-size:9pt;">${index + 1}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:9.5pt;">
          <div style="font-weight:600;">${item.description || ''}</div>
          ${item.hsnCode ? `<div style="color:#888;font-size:8pt;margin-top:1px;">HSN/SAC: ${item.hsnCode}</div>` : ''}
        </td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;font-size:9.5pt;">${num(item.rate)}</td>
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;font-size:9.5pt;">${item.quantity || 0}</td>
        ${gstCells}
        <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right;font-size:9.5pt;">${num(item.total)}</td>
      </tr>`;
    }).join('');

    const gstTotals = isInterState
      ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:#555;"><span>IGST Amount</span><span>INR ${num(bill.totalIgstAmount)}</span></div>`
      : `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:#555;"><span>SGST Amount</span><span>INR ${num(bill.totalSgstAmount)}</span></div>
         <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:#555;"><span>CGST Amount</span><span>INR ${num(bill.totalCgstAmount)}</span></div>`;

    const paidRows = (bill.paidAmount || 0) > 0 ? `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:#16a34a;">
        <span>Amount Paid</span><span>INR ${num(bill.paidAmount)}</span>
      </div>
      ${balanceDue > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:10.5pt;font-weight:700;border-top:1px solid #ccc;margin-top:4px;color:#dc2626;">
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
    body { font-family: Arial, Helvetica, sans-serif; color:#333; background:white; font-size:10pt; line-height:1.5; }
    .page { max-width:210mm; margin:0 auto; padding:14mm 18mm; }
  </style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-size:26pt;font-weight:900;color:#8b2fc9;letter-spacing:-1px;line-height:1;">${companyInfo.name || 'Company'}</div>
        <div style="margin-top:8px;">
          <div style="font-weight:700;font-size:10.5pt;">${(companyInfo.name || '').toUpperCase()}</div>
          ${companyInfo.address ? `<div style="font-size:9pt;color:#555;margin-top:3px;">${addressLines}</div>` : ''}
          ${companyInfo.email ? `<div style="font-size:9pt;color:#555;margin-top:2px;">Email: ${companyInfo.email}</div>` : ''}
          ${companyInfo.phone ? `<div style="font-size:9pt;color:#555;margin-top:2px;">Mobile: ${companyPhone}</div>` : ''}
          ${companyInfo.gstNumber ? `<div style="font-size:9pt;color:#555;margin-top:2px;">GSTIN: ${companyInfo.gstNumber}</div>` : ''}
        </div>
      </td>
      <td style="vertical-align:top;text-align:right;">
        <div style="font-size:24pt;font-weight:900;color:#222;letter-spacing:1px;line-height:1;">PURCHASE BILL</div>
        <div style="font-size:9.5pt;color:#555;margin-top:8px;line-height:2.2;">
          <div>Bill Number: <strong style="color:#222;">${bill.billNumber}</strong></div>
          ${bill.vendorInvoiceNumber ? `<div>Invoice Number: <strong style="color:#222;">${bill.vendorInvoiceNumber}</strong></div>` : ''}
          <div>Date: <strong style="color:#222;">${billDate}</strong></div>
          <div>Due Date: <strong style="color:#222;">${dueDate}</strong></div>
        </div>
        ${isFullyPaid ? `<div style="display:inline-block;border:2px solid #16a34a;color:#16a34a;font-weight:700;padding:3px 12px;font-size:9pt;margin-top:8px;letter-spacing:0.5px;">FULLY PAID</div>` : ''}
      </td>
    </tr>
  </table>

  <hr style="border:none;border-top:1px solid #ccc;margin:10px 0 14px 0;">

  <!-- VENDOR -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-weight:700;font-size:10pt;margin-bottom:5px;">Vendor</div>
        <div style="font-weight:600;font-size:10pt;">${bill.vendorName || 'N/A'}</div>
        ${bill.vendorGstNumber ? `<div style="font-size:9pt;color:#555;margin-top:2px;">${bill.vendorGstNumber}</div>` : ''}
        ${vendorAddressLines ? `<div style="font-size:9pt;color:#555;margin-top:2px;">${vendorAddressLines}</div>` : ''}
        ${bill.vendorState ? `<div style="font-size:9pt;color:#555;margin-top:2px;">${bill.vendorState}</div>` : ''}
      </td>
    </tr>
  </table>

  <!-- ITEMS TABLE -->
  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
    <thead>
      <tr style="background:#f5f5f5;border-top:1px solid #ddd;border-bottom:1px solid #ddd;">
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
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:9.5pt;color:#555;"><span>Taxable</span><span>INR ${num(bill.taxableAmount)}</span></div>
        ${gstTotals}
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11pt;font-weight:700;border-top:1px solid #ccc;margin-top:4px;"><span>Total Amount</span><span>INR ${num(bill.totalAmount)}</span></div>
        ${paidRows}
      </td>
    </tr>
  </table>

  <!-- AMOUNT IN WORDS -->
  <div style="border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:8px 0;font-size:9.5pt;margin:12px 0;">
    <strong>Total in Words:</strong> Indian Rupees ${amountInWords} Only
  </div>

  <!-- FOOTER -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;padding-top:14px;border-top:1px solid #ccc;">
    <tr>
      <td style="vertical-align:top;padding-right:30px;">
        ${bill.notes ? `<div style="font-weight:700;font-size:10pt;margin-bottom:6px;">Notes</div>
          <div style="font-size:9pt;color:#555;line-height:1.8;">${bill.notes}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right;min-width:210px;">
        <div style="font-weight:700;font-size:10pt;">For ${companyInfo.name || 'Company'}</div>
        <div style="height:55px;"></div>
        <div style="font-size:9.5pt;color:#555;">Authorised Signatory</div>
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
   * { name, description, quantity, unit, rate, amount, length, width,
   *   areaPerPiece, totalArea }. An area-priced line shows its size and area
   * per piece, its total area, the pieces and the rate per sq ft / sq m.
   */
  static itemRow(line) {
    const size = sizeLabel(line);
    const areaUnit = AREA_UNITS[line.unit];
    const showArea = !!areaUnit && (line.totalArea || 0) > 0;
    return {
      description: line.name || '',
      sub: line.description || '',
      size,
      sizeSub: size && line.areaPerPiece > 0 ? `${areaLabel(line.areaPerPiece, line.unit)} each` : '',
      area: showArea ? areaLabel(line.totalArea, line.unit) : '',
      qty: showArea ? this.fmtQty(line.quantity) : this.formatQtyWithUnit(line.quantity, line.unit),
      rate: this.fmtNum(line.rate),
      rateSub: showArea ? `per ${areaUnit.label}` : '',
      amount: this.fmtNum(line.amount)
    };
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

    const billing = this.splitAddress(invoice.customerAddress || customer.address);

    const items = (invoice.items || []).map((item) => {
      // Older area lines can say "pieces" in their unit; they were priced per sq ft.
      const isArea = item.itemType === 'Square Feet';
      const unit = isArea && !AREA_UNITS[item.unit] ? 'sqft' : item.unit;
      const areaPerPiece = item.areaPerPiece || (isArea && item.length > 0 && item.width > 0 ? round4(item.length * item.width) : 0);
      return this.itemRow({
        name: item.itemName,
        description: item.description,
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
    // Only an invoice issued before GST was removed carries any.
    const legacyGst = invoice.noGst ? 0 : invoice.totalGstAmount || 0;
    const total = invoice.totalAmount || 0;
    const paid = invoice.amountPaid != null ? invoice.amountPaid : (invoice.paidAmount || 0);

    const summary = [{ label: 'Subtotal', value: money(subtotal) }];
    if (designCharge > 0) summary.push({ label: 'Design Charge', value: money(designCharge) });
    if (discount > 0) summary.push({ label: 'Discount', value: '- ' + money(discount) });
    if (legacyGst > 0) summary.push({ label: 'GST', value: money(legacyGst) });
    summary.push({ label: 'Total', value: money(total), bold: true });
    if (paid > 0 && paid < total) {
      summary.push({ label: 'Paid', value: money(paid) });
      summary.push({ label: 'Balance', value: money(total - paid) });
    }

    return {
      type: 'INVOICE',
      number: invoice.invoiceNumber || '',
      meta: [
        { label: 'Date', value: new Date(invoice.invoiceDate || Date.now()).toLocaleDateString('en-GB') },
        ...(invoice.dueDate ? [{ label: 'Due Date', value: new Date(invoice.dueDate).toLocaleDateString('en-GB') }] : [])
      ],
      badge: total > 0 && paid >= total ? { text: 'FULLY PAID', color: '#2e7d32' } : null,
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

  /** Everything the quotation PDF shows, before any drawing. */
  static quotationDocument(quotation, companyInfo) {
    const customer = quotation.customer_id || {};
    const currency = companyInfo.currency || 'INR';
    const money = (n) => currency + ' ' + this.fmtNum(n);

    const custLines = [];
    if (customer.gstNumber) custLines.push('GSTIN: ' + customer.gstNumber);

    const items = (quotation.items || []).map((item) =>
      this.itemRow({
        name: item.item_name,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        rate: item.unit_price || 0,
        // A line written with GST kept the tax inside total_amount.
        amount: item.total_amount != null ? item.total_amount - (item.tax_amount || 0) : (item.quantity || 0) * (item.unit_price || 0),
        length: item.length,
        width: item.width,
        areaPerPiece: item.area_per_piece,
        totalArea: item.total_area
      })
    );

    const designCharge = quotation.design_charge || 0;
    const legacyGst = quotation.gst_type === 'gst' ? quotation.tax_amount || 0 : 0;
    const total = quotation.total_amount || 0;
    const summary = [{ label: 'Subtotal', value: money(quotation.subtotal || 0) }];
    if (designCharge > 0) summary.push({ label: 'Design Charge', value: money(designCharge) });
    if (legacyGst > 0) summary.push({ label: 'GST', value: money(legacyGst) });
    summary.push({ label: 'Total', value: money(total), bold: true });

    const billing = this.splitAddress(customer.address);
    return {
      type: 'QUOTATION',
      number: quotation.quotationNumber || '',
      meta: [
        { label: 'Date', value: new Date(quotation.createdAt || Date.now()).toLocaleDateString('en-GB') },
        ...(quotation.valid_until ? [{ label: 'Valid Until', value: new Date(quotation.valid_until).toLocaleDateString('en-GB') }] : [])
      ],
      badge: null,
      company: companyInfo,
      customer: { name: customer.name || 'N/A', lines: custLines },
      billingLines: billing,
      shippingLines: billing,
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

  static renderSynxDocument(doc, d) {
    const margin = 40;
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const right = pageWidth - margin;
    const contentWidth = right - margin;
    const C = { ink: '#1a1a2e', text: '#2d3748', muted: '#555555', line: '#cccccc', light: '#f5f5f5' };
    let y = margin;

    // ---------- LOGO ----------
    const logoBuf = this.decodeLogo(d.company.logo);
    if (logoBuf) {
      try { doc.image(logoBuf, margin, y, { fit: [130, 46] }); y += 54; } catch (e) { /* ignore bad logo */ }
    }

    const headerTop = y;

    // ---------- LEFT: company block ----------
    doc.fontSize(15).font('Helvetica-Bold').fillColor(C.ink)
       .text((d.company.name || 'COMPANY').toUpperCase(), margin, y, { width: 300 });
    let ly = doc.y + 2;
    doc.fontSize(9.5).font('Helvetica').fillColor(C.text);
    (d.company.addressLines || []).forEach(line => { doc.text(line, margin, ly, { width: 290 }); ly = doc.y; });
    if (d.company.email) { doc.text('Email: ' + d.company.email, margin, ly, { width: 290 }); ly = doc.y; }
    if (d.company.phone) { doc.text('Mobile: ' + d.company.phone, margin, ly, { width: 290 }); ly = doc.y; }
    if (d.company.gstNumber) { doc.text('GSTIN: ' + d.company.gstNumber, margin, ly, { width: 290 }); ly = doc.y; }

    // ---------- RIGHT: doc type + meta ----------
    doc.fontSize(20).font('Helvetica-Bold').fillColor(C.ink)
       .text(d.type, margin, headerTop, { width: contentWidth, align: 'right' });
    let ry = headerTop + 26;
    doc.fontSize(10).font('Helvetica').fillColor(C.text);
    doc.text('Number: ' + d.number, margin, ry, { width: contentWidth, align: 'right' }); ry += 15;
    (d.meta || []).forEach(m => { doc.text(m.label + ': ' + m.value, margin, ry, { width: contentWidth, align: 'right' }); ry += 15; });

    if (d.badge) {
      const bw = 110, bh = 22, bx = right - bw, by = ry + 2;
      doc.roundedRect(bx, by, bw, bh, 3).lineWidth(1).strokeColor(d.badge.color).stroke();
      doc.fontSize(10).font('Helvetica-Bold').fillColor(d.badge.color)
         .text(d.badge.text, bx, by + 7, { width: bw, align: 'center' });
      ry = by + bh;
    }

    y = Math.max(ly, ry) + 12;

    // separator
    doc.moveTo(margin, y).lineTo(right, y).strokeColor(C.line).lineWidth(1).stroke();
    y += 12;

    // ---------- CUSTOMER / BILLING / SHIPPING ----------
    const third = contentWidth / 3;
    const colX = [margin, margin + third, margin + 2 * third];
    const colW = third - 10;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C.ink);
    doc.text('Customer', colX[0], y);
    doc.text('Billing Address', colX[1], y);
    doc.text('Shipping Address', colX[2], y);
    const blockTop = y + 17;

    // Customer column
    doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.text).text(d.customer.name || 'N/A', colX[0], blockTop, { width: colW });
    let cy = doc.y;
    doc.font('Helvetica').fillColor(C.muted);
    (d.customer.lines || []).forEach(l => { doc.text(l, colX[0], cy, { width: colW }); cy = doc.y; });

    // Billing column
    doc.fontSize(9.5).font('Helvetica').fillColor(C.muted);
    let byc = blockTop;
    (d.billingLines && d.billingLines.length ? d.billingLines : ['N/A']).forEach(l => { doc.text(l, colX[1], byc, { width: colW }); byc = doc.y; });

    // Shipping column
    let bys = blockTop;
    (d.shippingLines && d.shippingLines.length ? d.shippingLines : ['N/A']).forEach(l => { doc.text(l, colX[2], bys, { width: colW }); bys = doc.y; });

    y = Math.max(cy, byc, bys) + 12;

    // ---------- ITEMS TABLE ----------
    // Size and Area are filled for lines priced by area (6 × 4 ft, 24 sq ft
    // each, 240 sq ft for 10 pieces); other lines leave them blank.
    const colsW = { sno: 24, desc: 165, size: 70, area: 64, qty: 52, rate: 62, total: 78 };
    const cols = { sno: margin };
    cols.desc = cols.sno + colsW.sno;
    cols.size = cols.desc + colsW.desc;
    cols.area = cols.size + colsW.size;
    cols.qty = cols.area + colsW.area;
    cols.rate = cols.qty + colsW.qty;
    cols.total = cols.rate + colsW.rate;

    const headerH = 24;
    doc.rect(margin, y, contentWidth, headerH).fill(C.light);
    doc.fillColor(C.ink).fontSize(9).font('Helvetica-Bold');
    const headY = y + 8;
    doc.text('Sl.', cols.sno + 2, headY, { width: colsW.sno - 2 });
    doc.text('Description of Items', cols.desc, headY, { width: colsW.desc });
    doc.text('Size (L × W)', cols.size, headY, { width: colsW.size - 4, align: 'right' });
    doc.text('Area', cols.area, headY, { width: colsW.area - 4, align: 'right' });
    doc.text('Qty', cols.qty, headY, { width: colsW.qty - 4, align: 'right' });
    doc.text('Rate', cols.rate, headY, { width: colsW.rate - 4, align: 'right' });
    doc.text('Amount', cols.total, headY, { width: colsW.total, align: 'right' });
    y += headerH + 5;

    // Draws a cell's value with an optional smaller line under it and returns
    // the height used, so the row can be as tall as its tallest cell.
    const cell = (x, w, main, sub, align = 'right', y0) => {
      doc.font('Helvetica').fillColor(C.text).fontSize(9.5);
      doc.text(main || '-', x, y0, { width: w, align });
      let h = doc.heightOfString(main || '-', { width: w });
      if (sub) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor(C.muted);
        doc.text(sub, x, y0 + h, { width: w, align });
        h += doc.heightOfString(sub, { width: w });
      }
      return h;
    };

    d.items.forEach((it, idx) => {
      if (y > pageHeight - 180) { doc.addPage(); y = margin; }
      const startY = y;
      const heights = [
        cell(cols.sno + 2, colsW.sno - 2, String(idx + 1), '', 'left', startY),
        cell(cols.desc, colsW.desc - 6, it.description, it.sub, 'left', startY),
        cell(cols.size, colsW.size - 4, it.size, it.sizeSub, 'right', startY),
        cell(cols.area, colsW.area - 4, it.area, '', 'right', startY),
        cell(cols.qty, colsW.qty - 4, it.qty, '', 'right', startY),
        cell(cols.rate, colsW.rate - 4, it.rate, it.rateSub, 'right', startY),
        cell(cols.total, colsW.total, it.amount, '', 'right', startY)
      ];
      y = startY + Math.max(15, ...heights) + 6;
      doc.moveTo(margin, y - 3).lineTo(right, y - 3).strokeColor('#eeeeee').lineWidth(0.5).stroke();
    });

    doc.moveTo(margin, y).lineTo(right, y).strokeColor(C.line).lineWidth(0.7).stroke();
    y += 8;
    if (y > pageHeight - 200) { doc.addPage(); y = margin; }

    // ---------- BANK (left) + SUMMARY (right) ----------
    const sumLabelX = margin + 290, sumValueX = margin + 372;
    let bankY = y, sumY = y;
    if (d.bankLines && d.bankLines.length) {
      doc.fontSize(9.5).font('Helvetica').fillColor(C.text);
      d.bankLines.forEach(l => { doc.text(l, margin, bankY, { width: 290 }); bankY += 15; });
    }
    d.summary.forEach(s => {
      doc.fontSize(s.bold ? 11.5 : 10).font(s.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(s.bold ? C.ink : C.text);
      doc.text(s.label, sumLabelX, sumY, { width: sumValueX - sumLabelX - 4 });
      doc.text(s.value, sumValueX, sumY, { width: right - sumValueX, align: 'right' });
      sumY += s.bold ? 18 : 16;
    });
    y = Math.max(bankY, sumY) + 6;

    // ---------- AMOUNT IN WORDS ----------
    doc.moveTo(margin, y).lineTo(right, y).strokeColor(C.line).lineWidth(0.7).stroke();
    y += 7;
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C.ink)
       .text('Total in Words: ' + d.amountWords, margin, y, { width: contentWidth, align: 'right' });
    y = doc.y + 6;
    doc.moveTo(margin, y).lineTo(right, y).strokeColor(C.line).lineWidth(0.7).stroke();
    y += 16;

    // ---------- FOOTER ----------
    const hasPayment = d.qrCode || d.paymentLink || d.upiId;
    if (y > pageHeight - 160) { doc.addPage(); y = margin; }
    const footY = y;

    // Left: Terms & Conditions
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C.ink).text('Terms & Conditions', margin, footY, { width: 200 });
    let ty = footY + 16;
    if (d.footerNote) {
      doc.fontSize(9.5).font('Helvetica').fillColor(C.muted).text(d.footerNote, margin, ty, { width: 200 });
      ty = doc.y + 4;
    }
    doc.fontSize(9.5).font('Helvetica').fillColor(C.muted).text(d.terms, margin, ty, { width: 200 });

    // Middle: Payment (QR code + UPI + link)
    if (hasPayment) {
      const payX = margin + 215;
      const payW = 150;
      let payY = footY;
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C.ink).text('Payment', payX, payY, { width: payW });
      payY += 16;

      const qrBuf = this.decodeLogo(d.qrCode);
      if (qrBuf) {
        try {
          doc.image(qrBuf, payX, payY, { fit: [72, 72] });
          doc.fontSize(8.5).font('Helvetica').fillColor(C.muted).text('Scan to Pay', payX, payY + 74, { width: 72, align: 'center' });
          payY += 88;
        } catch (e) { /* ignore bad QR */ }
      }
      if (d.upiId) {
        doc.fontSize(9.5).font('Helvetica').fillColor(C.text).text('UPI: ' + d.upiId, payX, payY, { width: payW });
        payY = doc.y + 2;
      }
      if (d.paymentLink) {
        doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.ink).text('Payment Link:', payX, payY, { width: payW });
        payY = doc.y;
        doc.fontSize(8.5).font('Helvetica').fillColor('#8b2fc9')
           .text(d.paymentLink, payX, payY, { width: payW, link: d.paymentLink, underline: true });
      }
    }

    // Right: signatory
    const sigX = margin + 375;
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C.ink)
       .text('For ' + (d.company.name || 'Company'), sigX, footY, { width: right - sigX, align: 'right' });
    doc.fontSize(9.5).font('Helvetica').fillColor(C.muted)
       .text('Authorised Signatory', sigX, footY + 60, { width: right - sigX, align: 'right' });
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
