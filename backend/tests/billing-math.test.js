/**
 * The arithmetic shared by job tickets, invoices and quotations
 * (src/utils/billing.js): area pricing from dimensions, the design charge,
 * GST per line and the document totals.
 */
const {
  priceLine,
  parseDesignCharge,
  parseGstRate,
  parseDesignChargeGstRate,
  applyGst,
  gstTotals,
  gstByRate,
  priceInvoiceDocument,
  priceQuotationDocument,
  documentTotals,
  toInvoiceLine,
  toQuotationLine,
  quotationLineToInvoiceLine,
  sizeLabel,
  areaLabel
} = require('../src/utils/billing');

describe('priceLine', () => {
  test('6 ft × 4 ft is 24 sq ft a piece; 10 pieces at ₹12/sq ft is 240 sq ft, ₹2,880', () => {
    const p = priceLine({ quantity: 10, unitPrice: 12, unit: 'sqft', length: 6, width: 4 });
    expect(p).toMatchObject({ isArea: true, areaPerPiece: 24, totalArea: 240, amount: 2880 });
  });

  test('a single piece is just its own area', () => {
    expect(priceLine({ quantity: 1, unitPrice: 12, unit: 'sqft', length: 6, width: 4 }).amount).toBe(288);
  });

  test('square metres work the same way', () => {
    expect(priceLine({ quantity: 3, unitPrice: 150, unit: 'sqm', length: 2, width: 1.5 })).toMatchObject({ areaPerPiece: 3, totalArea: 9, amount: 1350 });
  });

  test('areas carry no float noise, and keep four places before pricing', () => {
    expect(priceLine({ quantity: 1, unitPrice: 10, unit: 'sqft', length: 1.1, width: 1.1 })).toMatchObject({ areaPerPiece: 1.21, amount: 12.1 });
    expect(priceLine({ quantity: 4, unitPrice: 10, unit: 'sqft', length: 1.25, width: 0.75 })).toMatchObject({ areaPerPiece: 0.9375, totalArea: 3.75, amount: 37.5 });
  });

  test('a line priced per unit is quantity × rate, rounded to the paisa', () => {
    expect(priceLine({ quantity: 3, unitPrice: 0.1, unit: 'pieces' })).toMatchObject({ isArea: false, amount: 0.3, totalArea: 0 });
  });

  test('dimensions on a per-unit line are ignored', () => {
    expect(priceLine({ quantity: 5, unitPrice: 20, unit: 'pieces', length: 6, width: 4 })).toMatchObject({ isArea: false, amount: 100, length: 0, width: 0 });
  });

  test('an older sq ft line without dimensions keeps quantity as the area', () => {
    expect(priceLine({ quantity: 24, unitPrice: 12, unit: 'sqft' })).toMatchObject({ isArea: false, amount: 288 });
  });
});

describe('parseDesignCharge', () => {
  test('takes a number, a numeric string or a job ticket design charge object', () => {
    expect(parseDesignCharge(500)).toBe(500);
    expect(parseDesignCharge('249.999')).toBe(250);
    expect(parseDesignCharge({ amount: 750, gstRate: 18, totalAmount: 885 })).toBe(750);
  });

  test('nothing given is 0', () => {
    for (const v of [undefined, null, '', {}, { amount: null }]) expect(parseDesignCharge(v)).toBe(0);
  });

  test('a negative or non-numeric amount is rejected', () => {
    expect(parseDesignCharge(-1)).toBeNull();
    expect(parseDesignCharge('abc')).toBeNull();
    expect(parseDesignCharge({ amount: -5 })).toBeNull();
  });
});

describe('documentTotals', () => {
  test('lines + design charge − discount, with the design charge kept separate', () => {
    expect(documentTotals([2880, 250], 500, 30)).toEqual({ subtotal: 3130, designCharge: 500, gross: 3630, discount: 30, total: 3600 });
  });

  test('sums without float residue', () => {
    expect(documentTotals([0.1, 0.2], 0.3).total).toBe(0.6);
  });
});

describe('GST', () => {
  test('rates are 0 to 100, blank is 0, anything else is refused', () => {
    expect(parseGstRate(18)).toBe(18);
    expect(parseGstRate('0.25')).toBe(0.25);
    for (const v of [undefined, null, '']) expect(parseGstRate(v)).toBe(0);
    for (const v of [-1, 101, 'abc']) expect(parseGstRate(v)).toBeNull();
  });

  test("the design charge rate comes from the job ticket's design charge unless one is given", () => {
    expect(parseDesignChargeGstRate({ amount: 750, gstRate: 18 })).toBe(18);
    expect(parseDesignChargeGstRate({ amount: 750, gstRate: 18 }, 5)).toBe(5);
    expect(parseDesignChargeGstRate(750)).toBe(0);
  });

  test('without a discount each part is taxed at its own rate on its full value', () => {
    const t = gstTotals([{ amount: 2880, gstRate: 18 }, { amount: 250, gstRate: 12 }], { amount: 750, gstRate: 18 });
    // The job ticket: 2,880 + 18% = 3,398.40; 250 + 12% = 280; design 750 + 18% = 885.
    expect(t).toMatchObject({ subtotal: 3130, designCharge: 750, taxableAmount: 3880, gst: 683.4, cgst: 341.7, sgst: 341.7, igst: 0, total: 4563.4 });
    expect(t.lines.map((l) => l.gstAmount)).toEqual([518.4, 30]);
    expect(t.design.gstAmount).toBe(135);
  });

  test('a discount comes off before tax, shared by value, and the shares add up exactly', () => {
    const t = gstTotals([{ amount: 2880, gstRate: 18 }, { amount: 250, gstRate: 12 }], { amount: 500, gstRate: 0 }, 30);
    const shares = [...t.lines, t.design].map((p) => p.discountShare);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 10);
    expect(t.lines.map((l) => l.taxableValue)).toEqual([2856.2, 247.93]);
    expect(t.design.taxableValue).toBe(495.87);
    expect(t).toMatchObject({ taxableAmount: 3600, gst: 543.87, total: 4143.87 });
  });

  test('interstate supply is all IGST; intrastate halves always add back to the tax', () => {
    const inter = gstTotals([{ amount: 100.05, gstRate: 18 }], {}, 0, true);
    expect(inter).toMatchObject({ igst: 18.01, cgst: 0, sgst: 0, gst: 18.01, total: 118.06 });
    const intra = gstTotals([{ amount: 100.05, gstRate: 18 }]);
    expect(intra.cgst + intra.sgst).toBeCloseTo(18.01, 10);
    expect([intra.cgst, intra.sgst]).toEqual([9.01, 9]);
  });

  test('CGST and SGST stay within a paisa of each other across many odd-paisa lines', () => {
    // Each line's tax is an odd number of paise (₹0.09 on ₹0.50 at 18%).
    const t = gstTotals(Array.from({ length: 7 }, () => ({ amount: 0.5, gstRate: 18 })));
    expect(t.gst).toBe(0.63);
    expect(Math.round(Math.abs(t.cgst - t.sgst) * 100)).toBeLessThanOrEqual(1);
    expect(t.cgst + t.sgst).toBeCloseTo(0.63, 10);
    for (const line of t.lines) expect(line.cgstAmount + line.sgstAmount).toBeCloseTo(line.gstAmount, 10);
  });

  test('no GST at 0%, and different rates on one document', () => {
    expect(gstTotals([{ amount: 1000, gstRate: 0 }], { amount: 200, gstRate: 0 })).toMatchObject({ gst: 0, total: 1200 });
    for (const [rate, gst] of [[5, 50], [12, 120], [18, 180], [28, 280], [40, 400]]) {
      expect(gstTotals([{ amount: 1000, gstRate: rate }])).toMatchObject({ gst, total: 1000 + gst });
    }
  });

  test('the tax summary groups parts by rate', () => {
    const parts = applyGst([{ amount: 1000, gstRate: 18 }, { amount: 500, gstRate: 12 }, { amount: 300, gstRate: 18 }, { amount: 50, gstRate: 0 }]);
    expect(gstByRate(parts)).toEqual([
      { rate: 12, taxableValue: 500, cgst: 30, sgst: 30, igst: 0, gst: 60 },
      { rate: 18, taxableValue: 1300, cgst: 117, sgst: 117, igst: 0, gst: 234 }
    ]);
  });

  test('an invoice is priced from the line prices before tax, so GST is added once', () => {
    // A job ticket line: 100 cards at ₹2.50 + 18% shows ₹295 on the ticket.
    const { lines, totals, design } = priceInvoiceDocument({
      items: [{ itemName: 'Cards', quantity: 100, unitPrice: 2.5, gstRate: 18, itemTotal: 295, totalAmount: 295 }],
      designCharge: { amount: 750, gstRate: 18, totalAmount: 885 }
    });
    expect(lines[0]).toMatchObject({ totalAmount: 250, taxableValue: 250, gstRate: 18, gstAmount: 45, cgstAmount: 22.5, sgstAmount: 22.5, itemTotal: 295 });
    expect(design).toMatchObject({ designCharge: 750, designChargeGstRate: 18, designChargeGstAmount: 135 });
    expect(totals.total).toBe(1180);
  });

  test('an older No GST bill stays untaxed when re-priced', () => {
    const { totals } = priceInvoiceDocument({ items: [{ itemName: 'Cards', quantity: 1, unitPrice: 100, gstRate: 18 }], designCharge: { amount: 50, gstRate: 18 }, noGst: true });
    expect(totals).toMatchObject({ gst: 0, total: 150 });
  });

  test('a quotation line keeps its tax inside its total, as quotations always have', () => {
    const { lines, totals } = priceQuotationDocument({ items: [{ item_name: 'Brochure', quantity: 100, unit_price: 10, tax_rate: 18 }], designCharge: 200, designChargeGstRate: 18 });
    expect(lines[0]).toMatchObject({ tax_rate: 18, tax_amount: 180, total_amount: 1180 });
    expect(totals).toMatchObject({ subtotal: 1000, designCharge: 200, gst: 216, total: 1416 });
  });
});

describe('stored lines', () => {
  test('an invoice line records the dimensions, area, amount and GST rate; its tax is worked out with the document', () => {
    const line = toInvoiceLine({ itemName: ' Flex banner ', quantity: 10, unit: 'sqft', unitPrice: 12, length: 6, width: 4, gstRate: 18, totalAmount: 1, itemTotal: 1 });
    expect(line).toMatchObject({
      itemName: 'Flex banner',
      itemType: 'Square Feet',
      unit: 'sqft',
      length: 6,
      width: 4,
      areaPerPiece: 24,
      totalSquareFeet: 240,
      itemQuantity: 240,
      quantity: 10,
      totalAmount: 2880,
      itemTotal: 2880,
      gstRate: 18,
      gstAmount: 0
    });
  });

  test("a job ticket's area line that still says pieces is priced per sq ft", () => {
    expect(toInvoiceLine({ itemName: 'Vinyl', itemType: 'Square Feet', unit: 'pieces', quantity: 2, unitPrice: 10, length: 3, width: 2 })).toMatchObject({ unit: 'sqft', totalSquareFeet: 12, totalAmount: 120 });
  });

  test('a quotation line prices the same way, in its own field names', () => {
    expect(toQuotationLine({ item_name: 'Flex banner', quantity: 10, unit: 'sqft', unit_price: 12, length: 6, width: 4, tax_rate: 18 })).toMatchObject({
      area_per_piece: 24,
      total_area: 240,
      total_amount: 2880,
      tax_rate: 18,
      tax_amount: 0
    });
  });

  test('a quotation line becomes the identical invoice line', () => {
    const q = toQuotationLine({ item_name: 'Flex banner', description: 'Star flex', quantity: 10, unit: 'sqft', unit_price: 12, length: 6, width: 4 });
    expect(quotationLineToInvoiceLine(q)).toMatchObject({ itemName: 'Flex banner', description: 'Star flex', length: 6, width: 4, areaPerPiece: 24, totalSquareFeet: 240, totalAmount: 2880 });
  });
});

test('labels for documents', () => {
  expect(sizeLabel({ unit: 'sqft', length: 6, width: 4 })).toBe('6 × 4 ft');
  expect(sizeLabel({ unit: 'sqm', length: 1.5, width: 2 })).toBe('1.5 × 2 m');
  expect(sizeLabel({ unit: 'pieces', length: 6, width: 4 })).toBe('');
  expect(areaLabel(240, 'sqft')).toBe('240 sq ft');
  expect(areaLabel(0.9375, 'sqft')).toBe('0.9375 sq ft');
});

/*
 * The client prices lines with its own copy of this arithmetic
 * (client/src/lib/billing.ts) so a form shows the total the server will store.
 * This keeps the two copies in step. Skipped when the client's dependencies
 * are not installed next to the backend.
 */
const fs = require('fs');
const path = require('path');
const clientDir = path.join(__dirname, '../../client');
let ts = null;
try {
  ts = require(path.join(clientDir, 'node_modules/typescript'));
} catch {
  ts = null;
}

(ts ? describe : describe.skip)('client/src/lib/billing.ts matches the server', () => {
  let client;
  beforeAll(() => {
    const source = fs.readFileSync(path.join(clientDir, 'src/lib/billing.ts'), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require);
    client = mod.exports;
  });

  const lines = [
    { quantity: 10, unitPrice: 12, unit: 'sqft', length: 6, width: 4 },
    { quantity: 4, unitPrice: 10, unit: 'sqft', length: 1.25, width: 0.75 },
    { quantity: 3, unitPrice: 150, unit: 'sqm', length: 2, width: 1.5 },
    { quantity: 1, unitPrice: 10, unit: 'sqft', length: 1.1, width: 1.1 },
    { quantity: 7, unitPrice: 33.33, unit: 'pieces' },
    { quantity: 24, unitPrice: 12, unit: 'sqft' },
    { quantity: 5, unitPrice: 20, unit: 'pieces', length: 6, width: 4 }
  ];

  test.each(lines)('prices %o the same', (line) => {
    const server = priceLine(line);
    expect(client.priceLine(line)).toEqual({ isArea: server.isArea, areaPerPiece: server.areaPerPiece, totalArea: server.totalArea, amount: server.amount });
  });

  test('totals the same', () => {
    const s = documentTotals([2880, 233.31, 0.1, 0.2], 500.005, 30);
    const c = client.documentTotals([2880, 233.31, 0.1, 0.2], 500.005, 30);
    expect(c).toEqual(s);
  });

  test.each([
    [[{ amount: 2880, gstRate: 18 }, { amount: 233.31, gstRate: 12 }, { amount: 0.1, gstRate: 5 }], { amount: 500.005, gstRate: 18 }, 30, false],
    [[{ amount: 2880, gstRate: 18 }, { amount: 250, gstRate: 12 }], { amount: 750, gstRate: 18 }, 0, true],
    [[{ amount: 100.05, gstRate: 18 }, { amount: 33.33, gstRate: 0 }], { amount: 0, gstRate: 0 }, 13.37, false],
    [[{ amount: 1000, gstRate: 0.25 }, { amount: 999.99, gstRate: 28 }], { amount: 99.99, gstRate: 40 }, 1099.98, false],
    [Array.from({ length: 5 }, () => ({ amount: 0.5, gstRate: 18 })), { amount: 33.33, gstRate: 18 }, 0.07, false]
  ])('charges the same GST on %j + %j less %d (interstate %s)', (lines, design, discount, inter) => {
    expect(client.gstTotals(lines, design, discount, inter)).toEqual(gstTotals(lines, design, discount, inter));
    const parts = applyGst([...lines, design], discount, inter);
    expect(client.gstByRate(parts)).toEqual(gstByRate(parts));
    expect(client.parseGstRate('12.5')).toBe(parseGstRate('12.5'));
  });

  test('labels sizes the same', () => {
    expect(client.sizeLabel({ unit: 'sqft', length: 6, width: 4 })).toBe(sizeLabel({ unit: 'sqft', length: 6, width: 4 }));
    expect(client.describeArea(lines[0])).toBe('6 ft × 4 ft = 24 sq ft each · 10 pcs = 240 sq ft');
  });
});
