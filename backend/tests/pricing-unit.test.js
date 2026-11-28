const { validateSlabs, slabFor, slabRanges, resolveRate, quote, lineAmounts, PricingError } = require('../src/services/pricingService');

const SLABS = [[1, 25], [11, 23], [50, 22], [100, 20], [500, 18], [1000, 15], [2500, 13]].map(([minQty, rate]) => ({ minQty, rate }));
const item = { _id: 'i1', name: 'A3 Art', slabs: SLABS, gstRate: 18, taxInclusive: false };
const rateAt = (q, extra = {}) => resolveRate({ item, quantity: q, ...extra }).rate;

test('spec examples: the whole line takes the highest applicable threshold rate', () => {
  expect([5, 25, 75, 150, 750, 1500, 3000].map((q) => rateAt(q))).toEqual([25, 23, 22, 20, 18, 15, 13]);
});

test('boundary quantities', () => {
  const expected = { 1: 25, 10: 25, 11: 23, 49: 23, 50: 22, 99: 22, 100: 20, 499: 20, 500: 18, 999: 18, 1000: 15, 2499: 15, 2500: 13 };
  for (const [q, r] of Object.entries(expected)) expect([q, rateAt(Number(q))]).toEqual([q, r]);
});

test('not progressive: 150 units cost 150 × 20, not a blend of slabs', () => {
  expect(quote({ item, quantity: 150 }).total).toBe(150 * 20 * 1.18);
});

test('slabs are validated, sorted, and duplicates, zero/negative/blank values refused', () => {
  expect(validateSlabs([{ minQty: 100, rate: 20 }, { minQty: 1, rate: 25 }]).slabs.map((s) => s.minQty)).toEqual([1, 100]);
  for (const bad of [[{ minQty: 1, rate: 1 }, { minQty: 1, rate: 2 }], [{ minQty: 0, rate: 1 }], [{ minQty: -5, rate: 1 }], [{ minQty: 5, rate: -1 }], [{ minQty: '', rate: 1 }], [{ minQty: 5, rate: '' }], [{ minQty: 'x', rate: 1 }], 'nope']) {
    expect(validateSlabs(bad).errors.length).toBeGreaterThan(0);
  }
  expect(validateSlabs([{ minQty: 5, rate: 0 }]).errors).toEqual([]); // a free item is allowed
});

test('display ranges show where each rate stops', () => {
  expect(slabRanges(SLABS).slice(0, 2)).toEqual([{ minQty: 1, maxQty: 11, rate: 25 }, { minQty: 11, maxQty: 50, rate: 23 }]);
  expect(slabRanges(SLABS).pop()).toEqual({ minQty: 2500, maxQty: null, rate: 13 });
});

test('below the lowest threshold: default rate if set, else a clear error', () => {
  const high = { ...item, slabs: [{ minQty: 10, rate: 5 }] };
  expect(() => resolveRate({ item: high, quantity: 3 })).toThrow(/minimum quantity of 10/);
  expect(resolveRate({ item: { ...high, defaultRate: 9 }, quantity: 3 })).toMatchObject({ rate: 9, source: 'item_default' });
  expect(() => resolveRate({ item, quantity: 0 })).toThrow(PricingError);
});

describe('priority: override > customer slab > customer fixed > item slab > item default', () => {
  const customerRate = { isActive: true, fixedRate: 21, slabs: [{ minQty: 100, rate: 16 }] };
  test('customer slab beats everything but an override', () => {
    expect(resolveRate({ item, customerRate, quantity: 200 })).toMatchObject({ rate: 16, source: 'customer_slab' });
  });
  test('below the customer slabs the customer fixed rate applies', () => {
    expect(resolveRate({ item, customerRate, quantity: 50 })).toMatchObject({ rate: 21, source: 'customer_fixed' });
  });
  test('no customer rate falls to the item slab, then the default', () => {
    expect(resolveRate({ item, quantity: 50 })).toMatchObject({ source: 'item_slab' });
    expect(resolveRate({ item: { ...item, slabs: [], defaultRate: 30 }, quantity: 50 })).toMatchObject({ rate: 30, source: 'item_default' });
  });
  test('an inactive customer rate is ignored', () => {
    expect(resolveRate({ item, customerRate: { ...customerRate, isActive: false }, quantity: 200 }).source).toBe('item_slab');
  });
  test('a manual override wins, and 0 is a valid override while negative is not', () => {
    expect(resolveRate({ item, customerRate, quantity: 200, override: { rate: 10, reason: 'goodwill' } })).toMatchObject({ rate: 10, source: 'manual_override' });
    expect(resolveRate({ item, quantity: 5, override: { rate: 0, reason: 'sample' } }).rate).toBe(0);
    expect(() => resolveRate({ item, quantity: 5, override: { rate: -1 } })).toThrow(/Override/);
  });
});

describe('GST', () => {
  test('exclusive: GST is added on top', () => {
    expect(lineAmounts({ quantity: 10, rate: 100, gstRate: 18, taxInclusive: false })).toMatchObject({ taxable: 1000, gst: 180, total: 1180, unitPriceExclTax: 100 });
  });
  test('inclusive: taxable and GST are derived from the gross', () => {
    expect(lineAmounts({ quantity: 10, rate: 118, gstRate: 18, taxInclusive: true })).toMatchObject({ taxable: 1000, gst: 180, total: 1180, unitPriceExclTax: 100 });
  });
  test('inclusive totals never drift from the gross by more than a paisa, for every boundary quantity', () => {
    const inc = { ...item, taxInclusive: true, gstRate: 12 };
    for (const q of [1, 10, 11, 49, 50, 99, 100, 499, 500, 999, 1000, 2499, 2500]) {
      const r = quote({ item: inc, quantity: q });
      expect(Math.abs(r.taxable + r.gst - r.total)).toBeLessThan(0.0051);
      expect(r.total).toBe(Math.round(q * r.rate * 100) / 100);
    }
  });
  test('the snapshot records how the price was decided', () => {
    expect(quote({ item, quantity: 60 }).snapshot).toMatchObject({ itemId: 'i1', source: 'item_slab', rate: 22, quantity: 60, slab: { minQty: 50 }, gstRate: 18 });
  });
});
