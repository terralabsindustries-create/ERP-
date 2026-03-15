const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');

class PDFService {
  static async generateInvoicePDFFromHTML(invoice, companyInfo) {
    try {
      console.log('🔄 Starting HTML to PDF conversion for invoice:', invoice.invoiceNumber);

      // Generate HTML template
      const htmlContent = this.generateInvoiceHTML(invoice, companyInfo);

      // Use Puppeteer to convert HTML to PDF
      let browser;
      try {
        console.log('📦 Launching Puppeteer browser...');
        browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        const pdfBuffer = await page.pdf({
          format: 'A4',
          margin: {
            top: '20mm',
            right: '20mm',
            bottom: '20mm',
            left: '20mm'
          },
          printBackground: true
        });

        await browser.close();

        console.log('✅ PDF generated from HTML, size:', pdfBuffer.length, 'bytes');
        return pdfBuffer;
      } catch (puppeteerError) {
        console.warn('⚠️ Puppeteer error, falling back to PDFKit:', puppeteerError.message);
        if (browser) {
          try {
            await browser.close();
          } catch (e) {
            console.warn('Error closing browser:', e.message);
          }
        }
        // Fallback to PDFKit if Puppeteer fails (e.g., Chrome not installed)
        console.log('🔄 Falling back to PDFKit generation...');
        return await this.generateInvoicePDF(invoice, companyInfo);
      }
    } catch (error) {
      console.error('❌ PDF generation error:', error.message);
      throw new Error('Failed to generate PDF: ' + error.message);
    }
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

  static generateInvoiceHTML(invoice, companyInfo) {
    const invoiceDate = new Date(invoice.invoiceDate).toLocaleDateString('en-IN');
    const dueDate = new Date(invoice.dueDate).toLocaleDateString('en-IN');
    
    // Format phone numbers
    const companyPhone = this.formatPhone(companyInfo.phone);
    const customerPhone = this.formatPhone(invoice.customerId?.phone);
    
    // Calculate GST breakdown
    const isInterState = invoice.isInterState;
    const gstRate = invoice.totalGstAmount > 0 && invoice.taxableAmount > 0 
      ? (invoice.totalGstAmount / invoice.taxableAmount * 100).toFixed(0)
      : 0;
    
    // Amount in words
    const amountInWords = this.numberToWords(Math.floor(invoice.totalAmount || 0));
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Tax Invoice ${invoice.invoiceNumber}</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: white;
          color: #1a1a1a;
          line-height: 1.5;
          font-size: 11pt;
        }
        .invoice-container {
          max-width: 210mm;
          margin: 0 auto;
          padding: 15mm;
          border: 2px solid #1e3a8a;
        }
        
        /* Header Section */
        .invoice-header {
          border-bottom: 3px solid #1e3a8a;
          padding-bottom: 15px;
          margin-bottom: 20px;
        }
        .header-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }
        .company-details {
          flex: 1;
        }
        .company-name {
          font-size: 26pt;
          font-weight: 700;
          color: #1e3a8a;
          margin-bottom: 8px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .company-info-line {
          font-size: 10pt;
          color: #444;
          margin: 3px 0;
        }
        .company-info-line strong {
          color: #1e3a8a;
        }
        
        .invoice-title-section {
          text-align: right;
        }
        .invoice-title {
          font-size: 24pt;
          font-weight: 800;
          color: #1e3a8a;
          letter-spacing: 3px;
          margin-bottom: 10px;
        }
        .invoice-type {
          font-size: 10pt;
          color: #666;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        
        /* Invoice Info Grid */
        .invoice-info-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 15px;
          background: #f8fafc;
          padding: 15px;
          border: 1px solid #e2e8f0;
          margin-bottom: 20px;
        }
        .info-box {
          text-align: center;
        }
        .info-label {
          font-size: 8pt;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 5px;
        }
        .info-value {
          font-size: 11pt;
          font-weight: 700;
          color: #1e3a8a;
        }
        
        /* Party Details */
        .party-section {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 25px;
        }
        .party-box {
          border: 1px solid #cbd5e1;
          padding: 15px;
          background: #fafafa;
        }
        .party-title {
          font-size: 9pt;
          color: #1e3a8a;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
          border-bottom: 2px solid #1e3a8a;
          padding-bottom: 8px;
          margin-bottom: 12px;
        }
        .party-name {
          font-size: 12pt;
          font-weight: 700;
          color: #1a1a1a;
          margin-bottom: 8px;
        }
        .party-detail {
          font-size: 9pt;
          color: #444;
          margin: 4px 0;
        }
        .party-gst {
          font-size: 9pt;
          color: #1e3a8a;
          font-weight: 600;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px dashed #cbd5e1;
        }
        
        /* Items Table */
        .items-section {
          margin-bottom: 20px;
        }
        .items-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 9pt;
        }
        .items-table thead {
          background: #1e3a8a;
          color: white;
        }
        .items-table th {
          padding: 10px 8px;
          font-weight: 600;
          text-transform: uppercase;
          font-size: 8pt;
          letter-spacing: 0.5px;
          border-right: 1px solid rgba(255,255,255,0.2);
        }
        .items-table th:last-child {
          border-right: none;
        }
        .items-table td {
          padding: 8px;
          border: 1px solid #e2e8f0;
          vertical-align: top;
        }
        .items-table tbody tr:nth-child(even) {
          background: #f8fafc;
        }
        .items-table .text-right {
          text-align: right;
        }
        .items-table .text-center {
          text-align: center;
        }
        .item-name {
          font-weight: 600;
          color: #1a1a1a;
        }
        .item-desc {
          font-size: 8pt;
          color: #666;
        }
        
        /* Totals Section */
        .totals-wrapper {
          display: flex;
          justify-content: flex-end;
          margin-top: 10px;
        }
        .totals-box {
          width: 320px;
          border: 2px solid #1e3a8a;
        }
        .totals-row {
          display: flex;
          justify-content: space-between;
          padding: 8px 15px;
          border-bottom: 1px solid #e2e8f0;
          font-size: 9pt;
        }
        .totals-row:last-child {
          border-bottom: none;
        }
        .totals-label {
          color: #64748b;
        }
        .totals-value {
          font-weight: 600;
          color: #1a1a1a;
        }
        .totals-row.taxable {
          background: #f1f5f9;
          font-weight: 600;
        }
        .totals-row.gst-breakdown {
          background: #fff7ed;
          font-size: 8pt;
        }
        .totals-row.gst-breakdown .totals-label {
          color: #9a3412;
        }
        .totals-row.total {
          background: #1e3a8a;
          color: white;
          font-size: 12pt;
          font-weight: 700;
        }
        .totals-row.total .totals-label,
        .totals-row.total .totals-value {
          color: white;
        }
        .totals-row.balance {
          background: #fef2f2;
          color: #dc2626;
          font-weight: 700;
        }
        
        /* Amount in Words */
        .amount-words {
          margin: 20px 0;
          padding: 12px 15px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-left: 4px solid #1e3a8a;
        }
        .amount-words-label {
          font-size: 8pt;
          color: #64748b;
          text-transform: uppercase;
          margin-bottom: 5px;
        }
        .amount-words-value {
          font-size: 10pt;
          font-weight: 700;
          color: #1e3a8a;
          text-transform: uppercase;
        }
        
        /* Bank Details */
        .bank-details {
          margin: 20px 0;
          padding: 15px;
          border: 1px solid #cbd5e1;
          background: #fafafa;
        }
        .bank-title {
          font-size: 10pt;
          font-weight: 700;
          color: #1e3a8a;
          text-transform: uppercase;
          margin-bottom: 10px;
          border-bottom: 1px solid #e2e8f0;
          padding-bottom: 8px;
        }
        .bank-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px 20px;
          font-size: 9pt;
        }
        .bank-item {
          display: flex;
        }
        .bank-label {
          color: #64748b;
          min-width: 100px;
        }
        .bank-value {
          font-weight: 600;
          color: #1a1a1a;
        }
        
        /* Terms & QR Section */
        .footer-section {
          display: grid;
          grid-template-columns: ${companyInfo.paymentQRCode ? '1fr 150px' : '1fr'};
          gap: 20px;
          margin-top: 20px;
          border-top: 2px solid #1e3a8a;
          padding-top: 20px;
        }
        .terms-section {
          font-size: 8pt;
          color: #444;
        }
        .terms-title {
          font-weight: 700;
          color: #1e3a8a;
          margin-bottom: 8px;
          font-size: 9pt;
        }
        .terms-text {
          line-height: 1.6;
        }
        .qr-section {
          text-align: center;
        }
        .qr-title {
          font-size: 8pt;
          font-weight: 700;
          color: #1e3a8a;
          margin-bottom: 8px;
        }
        .qr-image {
          max-width: 130px;
          max-height: 130px;
          border: 1px solid #e2e8f0;
          padding: 5px;
          background: white;
        }
        
        /* Signature Section */
        .signature-section {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 40px;
          margin-top: 40px;
          padding-top: 20px;
          border-top: 1px dashed #cbd5e1;
        }
        .signature-box {
          text-align: center;
        }
        .signature-line {
          border-top: 1px solid #1a1a1a;
          margin: 50px auto 10px;
          width: 200px;
        }
        .signature-label {
          font-size: 9pt;
          color: #64748b;
        }
        .signature-company {
          font-size: 9pt;
          font-weight: 700;
          color: #1e3a8a;
          margin-top: 5px;
        }
        
        /* Declaration */
        .declaration {
          margin-top: 25px;
          padding: 10px 15px;
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          font-size: 8pt;
          color: #1e40af;
          text-align: center;
        }
        
        @media print {
          body {
            background: white;
          }
          .invoice-container {
            border: 2px solid #1e3a8a;
            max-width: 100%;
          }
        }
      </style>
    </head>
    <body>
      <div class="invoice-container">
        <!-- Header -->
        <div class="invoice-header">
          <div class="header-top">
            <div class="company-details">
              <div class="company-name">${companyInfo.name || 'Company Name'}</div>
              <div class="company-info-line">${companyInfo.address || 'Company Address'}</div>
              ${companyInfo.phone ? `<div class="company-info-line"><strong>Phone:</strong> ${companyPhone}</div>` : ''}
              ${companyInfo.email ? `<div class="company-info-line"><strong>Email:</strong> ${companyInfo.email}</div>` : ''}
              ${companyInfo.gstNumber ? `<div class="company-info-line"><strong>GSTIN:</strong> ${companyInfo.gstNumber}</div>` : ''}
              ${companyInfo.panNumber ? `<div class="company-info-line"><strong>PAN:</strong> ${companyInfo.panNumber}</div>` : ''}
            </div>
            <div class="invoice-title-section">
              <div class="invoice-title">TAX INVOICE</div>
              <div class="invoice-type">${isInterState ? 'INTER-STATE' : 'INTRA-STATE'} SUPPLY</div>
            </div>
          </div>
        </div>
        
        <!-- Invoice Info Grid -->
        <div class="invoice-info-grid">
          <div class="info-box">
            <div class="info-label">Invoice Number</div>
            <div class="info-value">${invoice.invoiceNumber}</div>
          </div>
          <div class="info-box">
            <div class="info-label">Invoice Date</div>
            <div class="info-value">${invoiceDate}</div>
          </div>
          <div class="info-box">
            <div class="info-label">Due Date</div>
            <div class="info-value">${dueDate}</div>
          </div>
        </div>
        
        <!-- Party Details -->
        <div class="party-section">
          <div class="party-box">
            <div class="party-title">Bill To (Customer)</div>
            <div class="party-name">${invoice.customerId?.name || 'N/A'}</div>
            ${invoice.customerId?.address ? `<div class="party-detail">${invoice.customerId.address}</div>` : ''}
            ${invoice.customerId?.phone ? `<div class="party-detail"><strong>Phone:</strong> ${customerPhone}</div>` : ''}
            ${invoice.customerId?.email ? `<div class="party-detail"><strong>Email:</strong> ${invoice.customerId.email}</div>` : ''}
            ${invoice.customerId?.gstNumber ? `<div class="party-gst"><strong>GSTIN:</strong> ${invoice.customerId.gstNumber}</div>` : ''}
          </div>
          <div class="party-box">
            <div class="party-title">Ship To</div>
            <div class="party-name">${invoice.customerId?.name || 'N/A'}</div>
            ${invoice.customerId?.address ? `<div class="party-detail">${invoice.customerId.address}</div>` : ''}
            ${invoice.customerId?.phone ? `<div class="party-detail"><strong>Phone:</strong> ${customerPhone}</div>` : ''}
            ${invoice.jobId ? `<div class="party-detail" style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;"><strong>Job Ref:</strong> ${invoice.jobId.title || 'N/A'}</div>` : ''}
          </div>
        </div>
        
        <!-- Items Table -->
        <div class="items-section">
          <table class="items-table">
            <thead>
              <tr>
                <th style="width:5%">S.No</th>
                <th style="width:30%">Description of Goods/Services</th>
                <th style="width:8%">HSN</th>
                <th style="width:8%">Qty</th>
                <th style="width:8%">Unit</th>
                <th style="width:10%">Rate (₹)</th>
                <th style="width:10%">Amount (₹)</th>
                <th style="width:8%">GST%</th>
                <th style="width:13%">Total (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${invoice.items.map((item, index) => {
                const unit = item.itemType === 'Square Feet' ? 'Sq.Ft' : (item.itemType === 'Running Feet' ? 'R.Ft' : 'Nos');
                return `
                <tr>
                  <td class="text-center">${index + 1}</td>
                  <td>
                    <div class="item-name">${item.itemName}</div>
                    ${item.length && item.width ? `<div class="item-desc">${item.length} × ${item.width} ${unit}</div>` : ''}
                  </td>
                  <td class="text-center">${item.hsnCode || '-'}</td>
                  <td class="text-center">${(item.quantity || 0).toFixed(2)}</td>
                  <td class="text-center">${unit}</td>
                  <td class="text-right">${(item.unitPrice || 0).toFixed(2)}</td>
                  <td class="text-right">${(item.totalAmount || 0).toFixed(2)}</td>
                  <td class="text-center">${(item.gstRate || 0).toFixed(0)}%</td>
                  <td class="text-right"><strong>${(item.itemTotal || 0).toFixed(2)}</strong></td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        
        <!-- Totals -->
        <div class="totals-wrapper">
          <div class="totals-box">
            <div class="totals-row">
              <span class="totals-label">Subtotal</span>
              <span class="totals-value">₹ ${(invoice.subtotal || 0).toFixed(2)}</span>
            </div>
            ${(invoice.discountAmount || 0) > 0 ? `
            <div class="totals-row">
              <span class="totals-label">Discount</span>
              <span class="totals-value" style="color:#dc2626">-₹ ${(invoice.discountAmount || 0).toFixed(2)}</span>
            </div>
            ` : ''}
            <div class="totals-row taxable">
              <span class="totals-label">Taxable Value</span>
              <span class="totals-value">₹ ${(invoice.taxableAmount || 0).toFixed(2)}</span>
            </div>
            ${!invoice.noGst && isInterState ? `
            <div class="totals-row gst-breakdown">
              <span class="totals-label">IGST @ ${gstRate}%</span>
              <span class="totals-value">₹ ${(invoice.totalGstAmount || 0).toFixed(2)}</span>
            </div>
            ` : !invoice.noGst ? `
            <div class="totals-row gst-breakdown">
              <span class="totals-label">CGST @ ${(gstRate/2).toFixed(0)}% | SGST @ ${(gstRate/2).toFixed(0)}%</span>
              <span class="totals-value">₹ ${(invoice.totalGstAmount || 0).toFixed(2)}</span>
            </div>
            ` : ''}
            <div class="totals-row total">
              <span class="totals-label">TOTAL AMOUNT</span>
              <span class="totals-value">₹ ${(invoice.totalAmount || 0).toFixed(2)}</span>
            </div>
            ${(invoice.amountPaid || 0) > 0 ? `
            <div class="totals-row">
              <span class="totals-label">Amount Paid</span>
              <span class="totals-value" style="color:#16a34a">₹ ${(invoice.amountPaid || 0).toFixed(2)}</span>
            </div>
            <div class="totals-row balance">
              <span class="totals-label">BALANCE DUE</span>
              <span class="totals-value">₹ ${((invoice.totalAmount || 0) - (invoice.amountPaid || 0)).toFixed(2)}</span>
            </div>
            ` : ''}
          </div>
        </div>
        
        <!-- Amount in Words -->
        <div class="amount-words">
          <div class="amount-words-label">Amount Chargeable (in words)</div>
          <div class="amount-words-value">Indian Rupees ${amountInWords} Only</div>
        </div>
        
        <!-- Bank Details -->
        <div class="bank-details">
          <div class="bank-title">Bank Account Details for Payment</div>
          <div class="bank-grid">
            <div class="bank-item">
              <span class="bank-label">Account Name:</span>
              <span class="bank-value">${companyInfo.name || 'N/A'}</span>
            </div>
            <div class="bank-item">
              <span class="bank-label">Bank Name:</span>
              <span class="bank-value">${companyInfo.bankName || 'N/A'}</span>
            </div>
            <div class="bank-item">
              <span class="bank-label">Account No:</span>
              <span class="bank-value">${companyInfo.accountNumber || 'N/A'}</span>
            </div>
            <div class="bank-item">
              <span class="bank-label">IFSC Code:</span>
              <span class="bank-value">${companyInfo.ifscCode || 'N/A'}</span>
            </div>
            ${companyInfo.branchName ? `
            <div class="bank-item">
              <span class="bank-label">Branch:</span>
              <span class="bank-value">${companyInfo.branchName}</span>
            </div>
            ` : ''}
            ${companyInfo.upiId ? `
            <div class="bank-item">
              <span class="bank-label">UPI ID:</span>
              <span class="bank-value">${companyInfo.upiId}</span>
            </div>
            ` : ''}
          </div>
        </div>
        
        <!-- Terms & QR -->
        <div class="footer-section">
          <div class="terms-section">
            <div class="terms-title">Terms & Conditions</div>
            <div class="terms-text">
              ${invoice.termsAndConditions || `
              1. Goods once sold will not be taken back.<br>
              2. Interest @ 18% per annum will be charged on overdue payments.<br>
              3. All disputes subject to local jurisdiction.<br>
              4. This is a computer generated invoice and does not require signature.
              `}
            </div>
          </div>
          ${companyInfo.paymentQRCode ? `
          <div class="qr-section">
            <div class="qr-title">Scan to Pay</div>
            <img src="${companyInfo.paymentQRCode}" alt="Payment QR" class="qr-image" />
          </div>
          ` : ''}
        </div>
        
        <!-- Signature Section -->
        <div class="signature-section">
          <div class="signature-box">
            <div class="signature-line"></div>
            <div class="signature-label">Customer Signature</div>
            <div style="font-size:8pt;color:#999;">(With Stamp)</div>
          </div>
          <div class="signature-box">
            <div class="signature-line"></div>
            <div class="signature-label">For ${companyInfo.name || 'Company'}</div>
            <div class="signature-company">Authorized Signatory</div>
          </div>
        </div>
        
        <!-- Declaration -->
        <div class="declaration">
          <strong>Declaration:</strong> We declare that this invoice shows the actual price of the goods/services described and that all particulars are true and correct. 
          ${invoice.noGst ? '<br><strong>Note: </strong>This is a non-GST invoice as per applicable GST rules.' : ''}
        </div>
      </div>
    </body>
    </html>
    `;
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
    const margin = 40;
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const contentWidth = pageWidth - (margin * 2);

    let yPos = margin;

    // Colors
    const colors = {
      primary: '#000000',
      secondary: '#333333',
      text: '#2d3748',
      lightGray: '#e2e8f0'
    };

    // ======================== HEADER ========================
    // Company Name
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor(colors.primary)
       .text(companyInfo.name || 'COMPANY NAME', margin, yPos, { width: contentWidth });
    yPos += 28;

    // Company Info
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor(colors.secondary);

    if (companyInfo.address) {
      doc.text(companyInfo.address, margin, yPos, { width: contentWidth - 150 });
      yPos += 14;
    }

    doc.text(`Phone: ${companyInfo.phone || 'N/A'} | Email: ${companyInfo.email || 'N/A'}`, margin, yPos, { width: contentWidth - 150 });
    yPos += 12;

    doc.text(`GST: ${companyInfo.gstNumber} | State: ${companyInfo.stateName}`, margin, yPos, { width: contentWidth - 150 });
    yPos += 18;

    // Invoice Number on the right
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor(colors.secondary)
       .text(`Invoice #${invoice.invoiceNumber}`, margin, yPos - 44, { width: contentWidth, align: 'right' });

    // Separator
    doc.moveTo(margin, yPos)
       .lineTo(pageWidth - margin, yPos)
       .strokeColor(colors.lightGray)
       .lineWidth(1)
       .stroke();

    yPos += 20;

    // ======================== INVOICE DETAILS ========================
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor(colors.primary);

    const col1 = margin;
    const col2 = margin + 120;
    const col3 = margin + 240;
    const col4 = margin + contentWidth - 100;

    doc.text('INVOICE DATE', col1, yPos);
    doc.text('DUE DATE', col2, yPos);
    doc.text('JOB REFERENCE', col3, yPos);

    yPos += 14;

    doc.fontSize(9)
       .font('Helvetica')
       .fillColor(colors.text);

    doc.text(new Date(invoice.invoiceDate).toLocaleDateString('en-IN'), col1, yPos);
    doc.text(new Date(invoice.dueDate).toLocaleDateString('en-IN'), col2, yPos);
    doc.text((invoice.jobId?.title || 'N/A').substring(0, 30), col3, yPos, { width: 100 });

    yPos += 24;

    // ======================== BILL TO & SHIP TO ========================
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor(colors.primary)
       .text('BILL TO', col1, yPos);

    doc.text('SHIP TO', col3, yPos);

    yPos += 14;

    const customer = invoice.customerId;
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor(colors.text)
       .text(customer.name || 'N/A', col1, yPos, { width: 150 });

    doc.text(customer.name || 'N/A', col3, yPos, { width: 150 });

    yPos += 14;

    doc.fontSize(8)
       .font('Helvetica')
       .fillColor(colors.secondary);

    if (customer.address) {
      doc.text(customer.address, col1, yPos, { width: 180 });
      const addressHeight = doc.heightOfString(customer.address, { width: 180 });
      doc.text(customer.address || 'Same as billing', col3, yPos, { width: 180 });
      yPos += Math.max(addressHeight, 12) + 4;
    }

    if (customer.email) {
      doc.text(customer.email, col1, yPos, { width: 180 });
      yPos += 12;
    }

    if (customer.phone) {
      doc.text(customer.phone, col1, yPos, { width: 180 });
      yPos += 12;
    }

    if (customer.gstNumber) {
      doc.text(`GST: ${customer.gstNumber}`, col1, yPos, { width: 180 });
      yPos += 12;
    }

    yPos += 10;

    // ======================== ITEMS TABLE ========================
    // Define table column positions for A4 page (595pt width)
    // Margin: 40pt on each side = 515pt content width
    // Column distribution: 20 + 250 + 50 + 40 + 50 + 35 + 70 = 515pt
    const tableColPositions = {
      slNo: margin,                    // 40
      slNoWidth: 18,
      item: margin + 18,               // 58
      itemWidth: 85,
      length: margin + 103,            // 143
      lengthWidth: 35,
      width: margin + 138,             // 178
      widthWidth: 35,
      qty: margin + 173,               // 213
      qtyWidth: 38,
      rate: margin + 211,              // 251
      rateWidth: 52,
      amount: margin + 263,            // 303
      amountWidth: 52,
      hsn: margin + 315,               // 355
      hsnWidth: 38,
      tax: margin + 353,               // 393
      taxWidth: 30,
      gst: margin + 383,               // 423
      gstWidth: 50,
      total: margin + 433              // 473
    };

    // Table Header
    doc.rect(margin, yPos, contentWidth, 26)
       .fillAndStroke('#f0f0f0', colors.lightGray);

    doc.fontSize(6.5)
       .font('Helvetica-Bold')
       .fillColor(colors.primary);

    const headerY = yPos + 8;
    doc.text('#', tableColPositions.slNo, headerY, { width: tableColPositions.slNoWidth });
    doc.text('Item', tableColPositions.item, headerY, { width: tableColPositions.itemWidth });
    doc.text('Length', tableColPositions.length, headerY, { width: tableColPositions.lengthWidth, align: 'center' });
    doc.text('Width', tableColPositions.width, headerY, { width: tableColPositions.widthWidth, align: 'center' });
    doc.text('Qty', tableColPositions.qty, headerY, { width: tableColPositions.qtyWidth, align: 'right' });
    doc.text('Rate', tableColPositions.rate, headerY, { width: tableColPositions.rateWidth, align: 'right' });
    doc.text('Amount', tableColPositions.amount, headerY, { width: tableColPositions.amountWidth, align: 'right' });
    doc.text('HSN', tableColPositions.hsn, headerY, { width: tableColPositions.hsnWidth, align: 'center' });
    doc.text('GST%', tableColPositions.tax, headerY, { width: tableColPositions.taxWidth, align: 'right' });
    doc.text('GST', tableColPositions.gst, headerY, { width: tableColPositions.gstWidth, align: 'right' });
    doc.text('Total', tableColPositions.total, headerY, { width: 60, align: 'right' });

    yPos += 30;

    // Table Rows
    let rowNum = 1;
    let subtotal = 0;
    let totalTax = 0;

    doc.fontSize(7.5)
       .font('Helvetica')
       .fillColor(colors.text);

    if (invoice.items && Array.isArray(invoice.items)) {
      invoice.items.forEach((item) => {
        if (yPos > pageHeight - 150) {
          doc.addPage();
          yPos = margin;
        }

        const qty = item.quantity || item.totalSquareFeet || 0;
        const rate = item.unitPrice || 0;
        const itemAmount = qty * rate;
        const taxRate = item.gstRate || 0;
        const gstAmount = item.gstAmount || (itemAmount * (taxRate / 100));
        const itemTotal = item.itemTotal || (itemAmount + gstAmount);

        subtotal += itemAmount;
        totalTax += gstAmount;

        // Row line
        doc.moveTo(margin, yPos)
           .lineTo(pageWidth - margin, yPos)
           .strokeColor(colors.lightGray)
           .lineWidth(0.5)
           .stroke();

        yPos += 5;
        const rowY = yPos;

        // Get item name (without dimensions - we have separate columns)
        const itemName = item.itemName;
        const lengthDisplay = (item.itemType === 'Square Feet' && item.length) ? item.length.toFixed(0) : '-';
        const widthDisplay = (item.itemType === 'Square Feet' && item.width) ? item.width.toFixed(0) : '-';

        doc.fontSize(7)
           .font('Helvetica')
           .fillColor(colors.text);

        doc.text(rowNum.toString(), tableColPositions.slNo, rowY, { width: tableColPositions.slNoWidth });
        doc.text(itemName.substring(0, 30), tableColPositions.item, rowY, { width: tableColPositions.itemWidth });
        doc.text(lengthDisplay, tableColPositions.length, rowY, { width: tableColPositions.lengthWidth, align: 'center' });
        doc.text(widthDisplay, tableColPositions.width, rowY, { width: tableColPositions.widthWidth, align: 'center' });
        doc.text(qty.toFixed(2), tableColPositions.qty, rowY, { width: tableColPositions.qtyWidth, align: 'right' });
        doc.text('₹' + rate.toFixed(2), tableColPositions.rate, rowY, { width: tableColPositions.rateWidth, align: 'right' });
        doc.text('₹' + itemAmount.toFixed(2), tableColPositions.amount, rowY, { width: tableColPositions.amountWidth, align: 'right' });
        doc.text(item.hsnCode || 'N/A', tableColPositions.hsn, rowY, { width: tableColPositions.hsnWidth, align: 'center' });
        doc.text(taxRate.toFixed(0) + '%', tableColPositions.tax, rowY, { width: tableColPositions.taxWidth, align: 'right' });
        doc.text('₹' + gstAmount.toFixed(2), tableColPositions.gst, rowY, { width: tableColPositions.gstWidth, align: 'right' });
        doc.text('₹' + itemTotal.toFixed(2), tableColPositions.total, rowY, { width: 60, align: 'right' });

        yPos += 18;
        rowNum++;
      });

      // Design Charge Row
      if (invoice.designCharge && invoice.designCharge.amount > 0) {
        if (yPos > pageHeight - 150) {
          doc.addPage();
          yPos = margin;
        }

        doc.moveTo(margin, yPos)
           .lineTo(pageWidth - margin, yPos)
           .strokeColor(colors.lightGray)
           .lineWidth(0.5)
           .stroke();

        yPos += 5;
        const designRowY = yPos;

        const designAmount = invoice.designCharge.amount || 0;
        const designGstRate = invoice.designCharge.gstRate || 18;
        const designTax = designAmount * (designGstRate / 100);
        const designTotal = designAmount + designTax;

        subtotal += designAmount;
        totalTax += designTax;

        doc.fontSize(7)
           .font('Helvetica')
           .fillColor(colors.text);

        doc.text(rowNum.toString(), tableColPositions.slNo, designRowY, { width: tableColPositions.slNoWidth });
        doc.text('Design Charge', tableColPositions.item, designRowY, { width: tableColPositions.itemWidth });
        doc.text('-', tableColPositions.length, designRowY, { width: tableColPositions.lengthWidth, align: 'center' });
        doc.text('-', tableColPositions.width, designRowY, { width: tableColPositions.widthWidth, align: 'center' });
        doc.text('1', tableColPositions.qty, designRowY, { width: tableColPositions.qtyWidth, align: 'right' });
        doc.text('₹' + designAmount.toFixed(2), tableColPositions.rate, designRowY, { width: tableColPositions.rateWidth, align: 'right' });
        doc.text('₹' + designAmount.toFixed(2), tableColPositions.amount, designRowY, { width: tableColPositions.amountWidth, align: 'right' });
        doc.text('', tableColPositions.hsn, designRowY, { width: tableColPositions.hsnWidth, align: 'center' });
        doc.text(designGstRate.toFixed(0) + '%', tableColPositions.tax, designRowY, { width: tableColPositions.taxWidth, align: 'right' });
        doc.text('₹' + designTax.toFixed(2), tableColPositions.gst, designRowY, { width: tableColPositions.gstWidth, align: 'right' });
        doc.text('₹' + designTotal.toFixed(2), tableColPositions.total, designRowY, { width: 60, align: 'right' });

        yPos += 18;
        rowNum++;
      }
    }

    // Table Bottom
    doc.moveTo(margin, yPos)
       .lineTo(pageWidth - margin, yPos)
       .strokeColor(colors.primary)
       .lineWidth(1.5)
       .stroke();

    yPos += 20;

    // ======================== SUMMARY ========================
    // Summary section with proper spacing
    const summaryLabelX = margin + 310;
    const summaryValueX = margin + 430;

    doc.fontSize(8)
       .font('Helvetica')
       .fillColor(colors.text);

    // Subtotal
    doc.text('Subtotal:', summaryLabelX, yPos, { width: 110 });
    doc.text(`₹ ${(invoice.subtotal || subtotal).toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
    yPos += 14;

    // Discount
    if ((invoice.discountAmount || 0) > 0) {
      doc.text('Discount:', summaryLabelX, yPos, { width: 110 });
      doc.text(`₹ ${(invoice.discountAmount || 0).toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
      yPos += 14;
    }

    // Taxable Amount
    const taxableAmount = (invoice.subtotal || subtotal) - (invoice.discountAmount || 0);
    doc.text('Taxable Amount:', summaryLabelX, yPos, { width: 110 });
    doc.text(`₹ ${taxableAmount.toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
    yPos += 14;

    // Total GST
    const totalGstAmount = invoice.totalGstAmount || totalTax;
    doc.text('Total GST Amount:', summaryLabelX, yPos, { width: 110 });
    doc.text(`₹ ${totalGstAmount.toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
    yPos += 14;

    doc.moveTo(summaryLabelX, yPos)
       .lineTo(pageWidth - margin, yPos)
       .strokeColor(colors.primary)
       .lineWidth(1)
       .stroke();

    yPos += 12;

    // Total Amount
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor(colors.primary);

    doc.text('Total Amount:', summaryLabelX, yPos, { width: 110 });
    doc.text(`₹ ${(invoice.totalAmount || 0).toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
    yPos += 14;

    // Amount Paid
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor(colors.text);

    doc.text('Amount Paid:', summaryLabelX, yPos, { width: 110 });
    doc.text(`₹ ${(invoice.amountPaid || 0).toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
    yPos += 14;

    // Balance Due
    const balanceDue = (invoice.totalAmount || 0) - (invoice.amountPaid || 0);
    doc.text('Balance Due:', summaryLabelX, yPos, { width: 110 });
    doc.text(`₹ ${balanceDue.toFixed(2)}`, summaryValueX, yPos, { width: 85, align: 'right' });
    yPos += 14;

    doc.moveTo(summaryLabelX, yPos)
       .lineTo(pageWidth - margin, yPos)
       .strokeColor(colors.primary)
       .lineWidth(2)
       .stroke();

    yPos += 20;

    // ======================== AMOUNT IN WORDS ========================
    doc.fontSize(8)
       .font('Helvetica-Bold')
       .fillColor(colors.primary);

    const amountInWords = this.numberToWords(Math.floor(invoice.totalAmount || 0));
    doc.text('Amount in Words:', margin, yPos);
    yPos += 12;

    doc.fontSize(8)
       .font('Helvetica')
       .fillColor(colors.text);

    doc.text(amountInWords.toUpperCase() + ' RUPEES ONLY', margin, yPos, { width: contentWidth - 100 });
    yPos += 30;

    // ======================== BANK DETAILS ========================
    if (yPos < pageHeight - 100) {
      doc.fontSize(9)
         .font('Helvetica-Bold')
         .fillColor(colors.primary)
         .text('BANK DETAILS', margin, yPos);

      yPos += 14;

      doc.fontSize(8)
         .font('Helvetica')
         .fillColor(colors.text);

      doc.text(`Bank: ${companyInfo.bankName || 'N/A'}`, margin, yPos);
      yPos += 10;

      doc.text(`Account: ${companyInfo.accountNumber || 'N/A'}`, margin, yPos);
      yPos += 10;

      doc.text(`IFSC: ${companyInfo.ifscCode || 'N/A'}`, margin, yPos);
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
      // Validate email credentials
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw new Error('Email credentials not configured. Please set EMAIL_USER and EMAIL_PASS in .env file');
      }

      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        tls: {
          rejectUnauthorized: false
        }
      });

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
