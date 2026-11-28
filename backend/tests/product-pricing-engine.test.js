/** The product rate engine: resolution priority, slabs, GST inclusive/exclusive, minimums, discounts, order totals. */
const P = require('../src/utils/productPricing');

const slabs = (...s) => s.map(([from, to, exclusiveRate]) => ({ from, to, exclusiveRate }));
const product = (extra = {}) => ({
  _id: 'p1', productName: 'Flex 280gsm', productCode: 'FLX', materialType: 'Flex', unit: 'pieces', gstRate: 18,
  rules: [{ slabs: slabs([1, 100, 15], [101, 500, 12], [501, null, 10]) }], ...extra
});
const line = (extra = {}) => ({ copies: 50, ...extra });

describe('GST inclusive / exclusive', () => {
  test('the demo figures reconcile: ₹10.17 exclusive ↔ ₹12 inclusive at 18%', () => {
    expect(P.inclusiveFromExclusive(10.17, 18)).toBe(12);
    expect(P.exclusiveFromInclusive(12, 18)).toBe(10.17);
  });
  test('completeSlab fills the missing side and rejects a mismatch', () => {
    expect(P.completeSlab({ exclusiveRate: 10.17 }, 18).slab).toMatchObject({ inclusiveRate: 12, rateBasis: 'exclusive' });
    expect(P.completeSlab({ inclusiveRate: 12 }, 18).slab).toMatchObject({ exclusiveRate: 10.17, rateBasis: 'inclusive' });
    expect(P.completeSlab({ exclusiveRate: 10.17, inclusiveRate: 12 }, 18).error).toBeUndefined();
    expect(P.completeSlab({ exclusiveRate: 10, inclusiveRate: 12 }, 18).error).toMatch(/do not match/);
    expect(P.completeSlab({ exclusiveRate: -1 }, 18).error).toMatch(/negative/);
    expect(P.completeSlab({}, 18).error).toBeTruthy();
  });
  test('an inclusive rate bills the entered inclusive total, GST not added twice', () => {
    const p = product({ rules: [{ slabs: [{ from: 1, to: null, inclusiveRate: 12 }].map((s) => P.completeSlab(s, 18).slab) }] });
    const r = P.priceLine({ product: p, line: line({ copies: 100 }) });
    expect(r.taxable + r.gst).toBe(1200); // exactly 100 × ₹12
    expect(r).toMatchObject({ taxable: 1016.95, gst: 183.05, total: 1200 });
  });
  test('a tax-exempt product carries no GST', () => {
    const r = P.priceLine({ product: product({ taxExempt: true }), line: line({ copies: 10 }) });
    expect(r).toMatchObject({ gstRate: 0, gst: 0, taxable: 150, total: 150 });
  });
});

describe('slab validation', () => {
  const v = (s) => P.validateSlabs(s, { gstRate: 18, unit: 'pieces' });
  test('accepts the demo ladder with an open last slab', () => {
    expect(v(slabs([1, 100, 15], [101, 500, 12], [501, null, 10])).errors).toEqual([]);
  });
  test('rejects overlap, duplicate start, bad ranges, negative rates, open slab not last, none', () => {
    expect(v(slabs([1, 100, 15], [100, 500, 12])).errors.join()).toMatch(/overlap/);
    expect(v(slabs([1, 100, 15], [1, 200, 12])).errors.join()).toMatch(/start at 1|overlap/);
    expect(v(slabs([10, 5, 15])).errors.join()).toMatch(/at least/);
    expect(v(slabs([1, 10, -2])).errors.join()).toMatch(/negative/);
    expect(v(slabs([1, null, 15], [50, 100, 12])).errors.join()).toMatch(/last slab/);
    expect(v([]).errors.length).toBe(1);
  });
  test('duplicate rules (same customer/party/sales) are refused', () => {
    const r = P.validateRules([{ partyType: 'Agency', slabs: slabs([1, null, 5]) }, { partyType: 'Agency', slabs: slabs([1, null, 6]) }], { gstRate: 18, unit: 'pieces' });
    expect(r.errors.join()).toMatch(/duplicates rule 1/);
  });
});

describe('resolution priority', () => {
  const rules = [
    { slabs: slabs([1, null, 10]) },
    { salesType: 'Wholesale', slabs: slabs([1, null, 9]) },
    { partyType: 'Agency', slabs: slabs([1, null, 8]) },
    { partyType: 'Agency', salesType: 'Wholesale', slabs: slabs([1, null, 7.5]) },
    { customerId: 'c1', slabs: slabs([1, null, 6]) }
  ];
  const rate = (ctx) => P.resolveRule(rules, ctx).slabs[0].exclusiveRate;
  test('customer > party+sales > party > sales > default', () => {
    expect(rate({ customerId: 'c1', partyType: 'Agency', salesType: 'Wholesale' })).toBe(6);
    expect(rate({ customerId: 'c2', partyType: 'Agency', salesType: 'Wholesale' })).toBe(7.5);
    expect(rate({ customerId: 'c2', partyType: 'Agency', salesType: 'Retail' })).toBe(8);
    expect(rate({ customerId: 'c2', partyType: 'Walk-in', salesType: 'wholesale' })).toBe(9);
    expect(rate({ customerId: 'c2', partyType: 'Walk-in', salesType: 'Retail' })).toBe(10);
  });
  test('no matching rule → a warning, never a silent zero', () => {
    const p = product({ rules: [{ partyType: 'Agency', slabs: slabs([1, null, 8]) }] });
    const r = P.priceLine({ product: p, ctx: { partyType: 'Walk-in' }, line: line() });
    expect(r.priced).toBe(false);
    expect(r.warnings[0].code).toBe('NO_RATE');
  });
});

describe('slab boundaries (quantity)', () => {
  const rate = (copies) => P.priceLine({ product: product(), line: { copies } }).rate;
  test('1, 100 | 101, 500 | 501+', () => {
    expect([1, 100, 101, 500, 501, 10000].map(rate)).toEqual([15, 15, 12, 12, 10, 10]);
  });
  test('a gap between slabs resolves down; above a closed last slab is reported', () => {
    const p = product({ rules: [{ slabs: slabs([1, 100, 15], [200, 300, 12]) }] });
    expect(P.priceLine({ product: p, line: { copies: 150 } }).rate).toBe(15);
    const over = P.priceLine({ product: p, line: { copies: 301 } });
    expect(over.priced).toBe(false);
    expect(over.warnings[0].code).toBe('OUT_OF_RANGE');
  });
  test('amounts: 100 × ₹15 + 18% = 1770; 101 × ₹12 + 18% = 1430.16', () => {
    expect(P.priceLine({ product: product(), line: { copies: 100 } })).toMatchObject({ taxable: 1500, gst: 270, total: 1770 });
    expect(P.priceLine({ product: product(), line: { copies: 101 } })).toMatchObject({ taxable: 1212, gst: 218.16, total: 1430.16 });
  });
});

describe('area pricing', () => {
  const area = product({ unit: 'sqft', rules: [{ slabs: slabs([0, 100, 12], [100.01, null, 10]) }] });
  test('6×4 ft × 10 copies = 240 sq ft → open slab @ ₹10', () => {
    const r = P.priceLine({ product: area, line: { copies: 10, length: 6, width: 4, dimUnit: 'ft' } });
    expect(r.area).toEqual({ perPiece: 24, total: 240 });
    expect(r).toMatchObject({ rate: 10, taxable: 2400, gst: 432, total: 2832 });
  });
  test('inches convert to feet; 12in×12in = 1 sq ft', () => {
    expect(P.priceLine({ product: area, line: { copies: 5, length: 12, width: 12, dimUnit: 'in' } }).area.total).toBe(5);
  });
  test('missing dimensions warn and bill by copies', () => {
    const r = P.priceLine({ product: area, line: { copies: 5 } });
    expect(r.warnings.map((w) => w.code)).toContain('NO_DIMENSIONS');
    expect(r.basis).toBe(5);
  });
});

describe('minimum rules (explicit fields only; the slab flag never calculates)', () => {
  test('minimum quantity and minimum amount are applied and reported', () => {
    const p = product({ rules: [{ minimumQuantity: 20, minimumAmount: 500, slabs: slabs([1, null, 10]) }] });
    const r = P.priceLine({ product: p, line: { copies: 5 } });
    expect(r.billableBasis).toBe(20);
    expect(r.taxable).toBe(500); // 20×10=200 → raised to the ₹500 minimum
    expect(r.adjustments.map((a) => a.type)).toEqual(['minimum_quantity', 'minimum_amount']);
  });
  test('the isMinimum slab flag is stored but does not change the amount', () => {
    const flagged = product({ rules: [{ slabs: [{ from: 1, to: null, exclusiveRate: 10, isMinimum: true }] }] });
    const plain = product({ rules: [{ slabs: [{ from: 1, to: null, exclusiveRate: 10, isMinimum: false }] }] });
    expect(P.priceLine({ product: flagged, line: { copies: 3 } }).taxable).toBe(P.priceLine({ product: plain, line: { copies: 3 } }).taxable);
  });
});

describe('discount and rate override', () => {
  test('percent and amount discounts come off before GST; bad values refused', () => {
    expect(P.priceLine({ product: product(), line: { copies: 100, discountType: 'percent', discountValue: 10 } })).toMatchObject({ discount: 150, taxable: 1350, gst: 243, total: 1593 });
    expect(P.priceLine({ product: product(), line: { copies: 100, discountType: 'amount', discountValue: 100 } })).toMatchObject({ taxable: 1400, total: 1652 });
    expect(P.priceLine({ product: product(), line: { copies: 100, discountValue: 120 } }).priced).toBe(false);
  });
  test('an override replaces the slab rate and the snapshot keeps the original', () => {
    const r = P.priceLine({ product: product(), line: { copies: 100, rateOverride: { rate: 14, reason: 'Loyal client' } } });
    expect(r.taxable).toBe(1400);
    expect(r.snapshot.override).toMatchObject({ original: 15, rate: 14, reason: 'Loyal client' });
  });
});

describe('order totals', () => {
  const l1 = P.priceLine({ product: product(), line: { copies: 100 } }); // 1500 + 270
  test('CGST/SGST, other charges, non-taxable, round-off, advance, balance', () => {
    const t = P.priceOrder({
      lines: [l1],
      otherCharges: [{ name: 'Delivery', amount: 100, gstRate: 18 }, { name: 'Packing deposit', amount: 50, taxable: false }],
      advance: 500
    });
    expect(t).toMatchObject({ taxableAmount: 1600, cgst: 144, sgst: 144, igst: 0, nonTaxableAmount: 50 });
    expect(t.subtotalBeforeRoundOff).toBe(1938);
    expect(t.total).toBe(1938);
    expect(t).toMatchObject({ advance: 500, balance: 1438, excess: 0, roundOff: 0 });
  });
  test('inter-state is IGST; round-off to the rupee; excess when advance exceeds the total', () => {
    const l = P.priceLine({ product: product(), line: { copies: 101 } }); // 1430.16
    const t = P.priceOrder({ lines: [l], isInterState: true, advance: 2000 });
    expect(t).toMatchObject({ igst: 218.16, cgst: 0, sgst: 0, total: 1430, roundOff: -0.16, excess: 570, balance: 0 });
  });
  test('unpriced lines contribute nothing', () => {
    const none = P.priceLine({ product: product({ rules: [] }), line: line() });
    expect(P.priceOrder({ lines: [none] }).total).toBe(0);
  });
});
