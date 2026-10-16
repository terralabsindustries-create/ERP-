/**
 * The arithmetic shared by invoices and quotations (src/utils/billing.js):
 * area pricing from dimensions, the design charge and the document totals.
 * No GST is ever added.
 */
const {
  priceLine,
  parseDesignCharge,
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

describe('stored lines', () => {
  test('an invoice line records the dimensions, area and amount, and never any GST', () => {
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
      gstRate: 0,
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
      tax_rate: 0,
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

  test('labels sizes the same', () => {
    expect(client.sizeLabel({ unit: 'sqft', length: 6, width: 4 })).toBe(sizeLabel({ unit: 'sqft', length: 6, width: 4 }));
    expect(client.describeArea(lines[0])).toBe('6 ft × 4 ft = 24 sq ft each · 10 pcs = 240 sq ft');
  });
});
