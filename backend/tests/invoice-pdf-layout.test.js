/**
 * The invoice PDF on A4 paper. The same file is downloaded, emailed, sent on
 * WhatsApp and printed, so its layout is checked here directly: every piece of
 * text and every image PDFKit draws is recorded with its page, position and
 * size, and the tests read that record the way a printed sheet would be read.
 */
const PDFDocument = require('pdfkit');
const PDFService = require('../src/services/PDFService');

const A4 = { width: 595.28, height: 841.89 };
const { margin: MARGIN, contentBottom, size: SIZE } = PDFService.PAGE_LAYOUT;
const BODY_BOTTOM = A4.height - contentBottom;
// A valid 1×1 PNG: enough for PDFKit to place a logo or a QR code.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const company = {
  name: 'Lotus Prints & Graphics',
  addressLines: ['12/440, Mavoor Road', 'Kozhikode - 673004', 'KERALA, INDIA'],
  logo: PNG,
  currency: 'INR',
  phone: '+91 98470 12345',
  email: 'accounts@lotusprints.in',
  gstNumber: '32ABCDE1234F1Z5',
  paymentQRCode: PNG,
  bankName: 'HDFC Bank',
  accountName: 'Lotus Prints & Graphics',
  accountNumber: '50200012345678',
  ifscCode: 'HDFC0001234',
  branchName: 'Mavoor Road, Kozhikode',
  upiId: 'lotusprintsandgraphics@okhdfcbank'
};

const flex = (n) => ({
  itemName: `Flex banner ${n}`, description: 'Star flex, eyelets on all sides', hsnCode: '4911', itemType: 'Square Feet', unit: 'sqft',
  length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 48, quantity: 2, unitPrice: 18, totalAmount: 864, taxableValue: 864, gstRate: 18, cgstAmount: 77.76, sgstAmount: 77.76
});
const cards = (n) => ({
  itemName: `Visiting cards ${n}`, description: '350 gsm art card, matte lamination, both sides', hsnCode: '4911', itemType: 'Numbers', unit: 'pieces',
  quantity: 1000, unitPrice: 1.2, totalAmount: 1200, taxableValue: 1200, gstRate: 12, cgstAmount: 72, sgstAmount: 72
});

const invoiceOf = (items, extra = {}) => {
  const subtotal = items.reduce((s, i) => s + i.totalAmount, 0);
  const gst = items.reduce((s, i) => s + i.cgstAmount + i.sgstAmount, 0);
  return {
    invoiceNumber: 'INV-2026-11-0041', invoiceDate: new Date('2026-11-05'), dueDate: new Date('2026-12-05'),
    customerName: 'Malabar Events & Weddings', customerGstNumber: '32AAACM9876K1Z2',
    customerAddress: '2nd Floor, Hilite Business Park\nThondayad Bypass\nKozhikode - 673014',
    customerId: { phone: '+91 99460 11223' },
    items, subtotal, taxableAmount: subtotal, totalAmount: Math.round((subtotal + gst) * 100) / 100, amountPaid: 0,
    termsAndConditions: '1. Payment due within 30 days.\n2. Goods once delivered will not be taken back.',
    ...extra
  };
};

/** Renders a document and returns everything drawn, page by page. */
function render(d) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const texts = [];
  const images = [];
  const pageOf = () => doc._pageBuffer.indexOf(doc.page);
  const text = doc.text.bind(doc);
  doc.text = (str, x, y, opts = {}) => {
    texts.push({
      str: String(str), x, y, w: opts.width, h: doc.heightOfString(String(str), opts),
      size: doc._fontSize, bold: /Bold/.test(doc._font.name), page: pageOf()
    });
    return text(str, x, y, opts);
  };
  const image = doc.image.bind(doc);
  doc.image = (src, x, y, opts = {}) => {
    images.push({ x, y, w: opts.width || opts.fit?.[0], h: opts.height || opts.fit?.[1], page: pageOf() });
    return image(src, x, y, opts);
  };
  PDFService.renderSynxDocument(doc, d);
  const pages = doc._pageBuffer.map((p) => ({ width: p.width, height: p.height }));
  doc.end();
  const find = (str) => texts.filter((t) => t.str === str);
  const onPage = (p) => texts.filter((t) => t.page === p);
  return { texts, images, pages, find, onPage };
}

const isPageFooter = (t) => t.y > BODY_BOTTOM;

describe('a short invoice', () => {
  const d = PDFService.invoiceDocument(invoiceOf([flex(1), cards(2)]), company);
  const out = render(d);

  test('is one A4 page with every part of the invoice on it', () => {
    expect(out.pages).toEqual([{ width: A4.width, height: A4.height }]);
    for (const part of [
      'INVOICE', 'LOTUS PRINTS & GRAPHICS', 'GSTIN: 32ABCDE1234F1Z5', 'BILL TO', 'Malabar Events & Weddings', 'GSTIN: 32AAACM9876K1Z2',
      'Phone: +91 99460 11223', 'Invoice No.', 'INV-2026-11-0041', 'Invoice Date', '05/11/2026', 'Due Date', '05/12/2026',
      'Item & Description', 'Size (L × W)', 'Area', 'Qty', 'Rate', 'Amount', 'Flex banner 1', 'Visiting cards 2',
      'AMOUNT IN WORDS', 'BANK DETAILS', '50200012345678', 'HDFC0001234', 'TERMS & CONDITIONS', 'SCAN TO PAY',
      'UPI ID', 'Total', 'For Lotus Prints & Graphics', 'Authorised Signatory'
    ]) {
      expect(out.find(part).length).toBeGreaterThan(0);
    }
    // One page needs no page numbers.
    expect(out.texts.some((t) => /^Page \d+ of \d+$/.test(t.str))).toBe(false);
  });

  test('prints every figure the invoice stores, unchanged', () => {
    for (const row of d.summary) {
      expect(out.find(row.label)).toHaveLength(1);
      // Subtotal and Taxable Amount are the same figure when nothing is added or taken off.
      expect(out.find(row.value)).toHaveLength(d.summary.filter((r) => r.value === row.value).length);
    }
    expect(out.find('INR 2,363.52')).toHaveLength(1);
    for (const amount of ['864.00', '1,200.00', '18.00', '1.20']) expect(out.find(amount)).toHaveLength(1);
    expect(out.find('6 × 4 ft')).toHaveLength(1);
    expect(out.find('48 sq ft')).toHaveLength(1);
  });

  test('uses type sizes that read on paper', () => {
    expect(Math.min(...out.texts.map((t) => t.size))).toBeGreaterThanOrEqual(8.5);
    expect(out.find('Flex banner 1')[0].size).toBeGreaterThanOrEqual(10.5);
    expect(out.find('864.00')[0].size).toBeGreaterThanOrEqual(10.5);
    expect(out.find('Star flex, eyelets on all sides\nHSN: 4911 · GST 18%')[0].size).toBeGreaterThanOrEqual(9);
    expect(out.find('Total')[0].size).toBeGreaterThanOrEqual(13);
    expect(out.find('INVOICE')[0].size).toBeGreaterThanOrEqual(22);
    // Only small capitals labels sit under 9 pt.
    for (const t of out.texts.filter((x) => x.size < 9)) expect(t.str).toBe(t.str.toUpperCase());
  });

  test('keeps everything inside the printable area of the sheet', () => {
    for (const t of out.texts) {
      expect(t.x).toBeGreaterThanOrEqual(MARGIN - 0.01);
      expect(t.x + t.w).toBeLessThanOrEqual(A4.width - MARGIN + 0.01);
      expect(t.y).toBeGreaterThanOrEqual(MARGIN - 4);
      expect(t.y + t.h).toBeLessThanOrEqual(BODY_BOTTOM + 0.5);
    }
  });

  test('prints the payment QR large enough to scan, and the UPI ID unbroken', () => {
    const [logo, qr] = out.images;
    expect(qr.w).toBeGreaterThanOrEqual(90); // ≥ 32 mm square
    expect(qr.h).toBeGreaterThanOrEqual(90);
    expect(logo.w).toBeLessThanOrEqual(110);
    expect(logo.h).toBeLessThanOrEqual(64);
    // This ID is too long for one line, so it goes onto two at its "@".
    const upi = out.texts.find((t) => t.str.replace('\n', '') === company.upiId);
    expect(upi.str).toBe('lotusprintsandgraphics\n@okhdfcbank');
    expect(upi.h).toBeLessThan(2 * upi.size * 1.6);
    expect(upi.size).toBeGreaterThanOrEqual(8.5);
    // A shorter one stays whole on one line.
    const short = render(PDFService.invoiceDocument(invoiceOf([flex(1)]), { ...company, upiId: 'lotusprints@okhdfcbank' }));
    const one = short.find('lotusprints@okhdfcbank')[0];
    expect(one.h).toBeLessThan(one.size * 1.6);
  });

  test('does not stretch a short invoice to fill the page', () => {
    const lowest = Math.max(...out.texts.map((t) => t.y + t.h));
    expect(lowest).toBeLessThan(A4.height * 0.85);
  });
});

describe('a long invoice', () => {
  const items = Array.from({ length: 40 }, (_, i) => (i % 2 ? cards(i + 1) : flex(i + 1)));
  const d = PDFService.invoiceDocument(invoiceOf(items), company);
  const out = render(d);
  const last = out.pages.length - 1;

  test('runs over several A4 pages, numbered "Page n of N"', () => {
    expect(out.pages.length).toBeGreaterThanOrEqual(3);
    for (const page of out.pages) expect(page).toEqual({ width: A4.width, height: A4.height });
    out.pages.forEach((_, p) => {
      const footer = out.onPage(p).filter(isPageFooter).map((t) => t.str);
      expect(footer).toEqual(['Invoice INV-2026-11-0041', `Page ${p + 1} of ${out.pages.length}`]);
    });
  });

  test('repeats the table heading on every page and never splits an item row', () => {
    items.forEach((item, i) => {
      const name = out.find(item.itemName)[0];
      const no = out.texts.find((t) => t.str === String(i + 1) && t.page === name.page && Math.abs(t.y - name.y) < 0.01);
      expect(no).toBeDefined();
      const heading = out.find('Item & Description').find((t) => t.page === name.page);
      expect(heading.y).toBeLessThan(name.y);
      // The line's sub-text and amount are drawn on the same page as its name.
      const sub = out.texts.filter((t) => t.page === name.page && t.str === item.description + '\nHSN: 4911 · GST ' + item.gstRate + '%');
      expect(sub.length).toBeGreaterThan(0);
    });
    for (let p = 1; p < out.pages.length; p += 1) {
      expect(out.onPage(p).some((t) => t.str === 'Invoice INV-2026-11-0041 (continued)')).toBe(true);
    }
  });

  test('fills each page before breaking, instead of leaving the bottom empty', () => {
    for (let p = 0; p < last; p += 1) {
      const lowest = Math.max(...out.onPage(p).filter((t) => !isPageFooter(t)).map((t) => t.y + t.h));
      // Less than one described item row (≈ 70 pt) is left unused.
      expect(BODY_BOTTOM - lowest).toBeLessThan(80);
    }
  });

  test('keeps the totals, bank details, QR and signature together on the last page', () => {
    for (const part of ['Total', 'AMOUNT IN WORDS', 'BANK DETAILS', 'SCAN TO PAY', 'TERMS & CONDITIONS', 'Authorised Signatory']) {
      expect(out.find(part).map((t) => t.page)).toEqual([last]);
    }
    expect(out.images.filter((i) => i.w >= 90).map((i) => i.page)).toEqual([last]);
    for (const t of out.texts.filter((x) => !isPageFooter(x))) expect(t.y + t.h).toBeLessThanOrEqual(BODY_BOTTOM + 0.5);
  });
});

describe('the columns follow the lines', () => {
  test('an invoice with no sized items has no Size or Area columns, and a wider description', () => {
    const plain = render(PDFService.invoiceDocument(invoiceOf([cards(1)]), company));
    expect(plain.find('Size (L × W)')).toHaveLength(0);
    expect(plain.find('Area')).toHaveLength(0);
    const sized = render(PDFService.invoiceDocument(invoiceOf([cards(1), flex(2)]), company));
    expect(sized.find('Size (L × W)')).toHaveLength(1);
    expect(plain.find('Visiting cards 1')[0].w).toBeGreaterThan(sized.find('Visiting cards 1')[0].w + 80);
  });

  test('without bank details or a QR, those sections are left out rather than printed empty', () => {
    const bare = { ...company, logo: '', paymentQRCode: '', upiId: '', bankName: '', accountName: '', accountNumber: '', ifscCode: '', branchName: '' };
    const out = render(PDFService.invoiceDocument(invoiceOf([cards(1)]), bare));
    expect(out.images).toHaveLength(0);
    expect(out.find('BANK DETAILS')).toHaveLength(0);
    expect(out.find('SCAN TO PAY')).toHaveLength(0);
    expect(out.find('Authorised Signatory')).toHaveLength(1);
  });
});

test('a part-paid invoice shows what is paid and the balance due; a paid one is marked', () => {
  const inv = invoiceOf([cards(1)], { amountPaid: 500 });
  const part = render(PDFService.invoiceDocument(inv, company));
  expect(part.find('Paid')).toHaveLength(1);
  expect(part.find('Balance Due')[0].bold).toBe(true);
  expect(part.find('INR 844.00')).toHaveLength(1);
  const paid = render(PDFService.invoiceDocument({ ...inv, amountPaid: inv.totalAmount }, company));
  expect(paid.find('FULLY PAID')).toHaveLength(1);
});

test('a quotation is drawn by the same layout, with its own number and validity', () => {
  const quotation = {
    quotationNumber: 'QT-2026-0007', createdAt: new Date('2026-11-05'), valid_until: new Date('2026-11-20'),
    customer_id: { name: 'Malabar Events & Weddings', phone: '+91 99460 11223', address: 'Kozhikode - 673014' },
    shipping_address: 'Warehouse Road\nKozhikode - 673001',
    items: [{ item_name: 'Flex banner', unit: 'sqft', length: 6, width: 4, area_per_piece: 24, total_area: 240, quantity: 10, unit_price: 12, tax_rate: 18, tax_amount: 518.4, total_amount: 3398.4 }],
    subtotal: 2880, total_amount: 3398.4
  };
  const out = render(PDFService.quotationDocument(quotation, company));
  expect(out.pages).toHaveLength(1);
  for (const part of ['QUOTATION', 'Quotation No.', 'QT-2026-0007', 'Valid Until', '20/11/2026', 'CUSTOMER', 'BILLING ADDRESS', 'SHIPPING ADDRESS', 'Warehouse Road', 'Size (L × W)', 'INR 3,398.40']) {
    expect(out.find(part).length).toBeGreaterThan(0);
  }
});

test('the PDF file itself is A4, as downloaded', async () => {
  const pdf = await PDFService.generateInvoicePDF(invoiceOf([flex(1)]), company);
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.28 841\.89\]/);
  expect(SIZE.cell).toBeGreaterThanOrEqual(10.5);
});
