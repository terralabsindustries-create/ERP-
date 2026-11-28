/**
 * Typing a line's total (incl. GST) sets the unit price that gives it, priced
 * the same way as lib/billing.ts. Run from client/: `node --test tests/line-total.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unitPriceForTotal } from "../src/lib/lineTotal.ts";
import { priceLine } from "../src/lib/billing.ts";

// What the job dialog shows: priceLine amount + GST, to the paisa.
const shown = (item, price) => {
  const p = priceLine({ ...item, unitPrice: price });
  const amount = p.amount;
  return Math.round((amount + (amount * item.gstRate) / 100) * 100) / 100;
};

test("one piece at 18% GST: ₹177 total is ₹150 each", () => {
  assert.deepEqual(unitPriceForTotal({ total: 177, gstRate: 18, quantity: 1, unit: "pieces" }), { unitPrice: 150, total: 177, exact: true });
});

test("round totals that need more than 2 decimals still land on the paisa", () => {
  for (const [total, quantity, gstRate] of [[200, 1, 18], [1000, 3, 18], [999, 7, 12], [5000, 13, 5], [250, 1, 0]]) {
    const item = { quantity, gstRate, unit: "pieces" };
    const r = unitPriceForTotal({ total, ...item });
    assert.ok(r.exact, `${total} over ${quantity} @ ${gstRate}%`);
    assert.equal(shown(item, r.unitPrice), total);
  }
});

test("prefers a 2-decimal price when one is exact", () => {
  const r = unitPriceForTotal({ total: 590, gstRate: 18, quantity: 2, unit: "sheets" });
  assert.equal(r.unitPrice, 250);
});

test("area items divide by the total area", () => {
  // 6 ft × 4 ft × 2 pcs = 48 sq ft; ₹576 + 18% = ₹679.68 → ₹12 per sq ft
  const item = { quantity: 2, unit: "sqft", length: 6, width: 4, gstRate: 18 };
  const r = unitPriceForTotal({ total: 679.68, ...item });
  assert.equal(r.unitPrice, 12);
  assert.equal(shown(item, r.unitPrice), 679.68);
});

test("no quantity, no size or no total gives nothing to solve", () => {
  assert.equal(unitPriceForTotal({ total: 100, gstRate: 18, quantity: 0, unit: "pieces" }), null);
  assert.equal(unitPriceForTotal({ total: 100, gstRate: 18, quantity: 2, unit: "sqft" }), null);
  assert.equal(unitPriceForTotal({ total: 0, gstRate: 18, quantity: 1, unit: "pieces" }), null);
});

test("an unreachable total reports the closest one", () => {
  // One piece at 18%: ₹0.86 gives ₹1.01 and ₹0.87 gives ₹1.03, so ₹1.02 cannot be hit
  const r = unitPriceForTotal({ total: 1.02, gstRate: 18, quantity: 1, unit: "pieces" });
  assert.equal(r.exact, false);
  assert.ok([1.01, 1.03].includes(r.total));
});
