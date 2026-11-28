/**
 * Print estimator arithmetic. Expected figures were worked out by hand, not
 * copied from the code: imposition, sheets, wastage, paper by weight, plates,
 * press, finishing, margin and GST. Run from client/: `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { impose, estimate } from "../src/lib/printEstimate.ts";
import { FACTORY, initialEstimatorState, loadDefaults, productIdFor, sheetIdFor, STORAGE_KEY } from "../src/lib/estimatorPresets.ts";

const near = (actual, expected, eps = 0.011) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);

test("imposition tries both orientations and keeps the one that fits more", () => {
  // 93×55 pieces (89×51 + 2 mm bleed) on 441×568 usable: straight 4×10 = 40, turned 8×6 = 48.
  const i = impose(FACTORY);
  assert.deepEqual([i.ups, i.across, i.down, i.rotated], [48, 8, 6, true]);
  assert.deepEqual([i.pieceWidth, i.pieceHeight], [55, 93]);
  near(i.utilisation, (48 * 89 * 51) / (457 * 584), 1e-9);
});

test("gutter reduces how many pieces fit; a piece larger than the sheet fits none", () => {
  // 5 mm gutter: straight 4×9 = 36, turned 7×5 = 35 → 36, not rotated.
  const g = impose({ ...FACTORY, gutter: 5 });
  assert.deepEqual([g.ups, g.rotated], [36, false]);
  assert.equal(impose({ ...FACTORY, width: 600 }).ups, 0);
});

test("offset job: sheets, wastage, paper by kg, plates, press, lamination, packing, margin and GST", () => {
  const r = estimate(FACTORY); // 1,000 visiting cards, 4/0 colour, laminated one side
  assert.equal(r.netSheets, 21); // ceil(1000 / 48)
  assert.equal(r.wasteSheets, 52); // ceil(21 × 5%) = 2, plus 50 make-ready
  assert.equal(r.totalSheets, 73);
  const byKey = Object.fromEntries(r.lines.map((l) => [l.key, l.amount]));
  near(byKey.paper, 555.26); // 0.457 × 0.584 × 0.300 kg × 73 sheets × ₹95
  assert.equal(byKey.plates, 1800); // 4 × ₹450
  assert.equal(byKey.press, 720); // 1k impressions × 4 colours × ₹180
  assert.equal(byKey.lamination, 63); // 21 sheets × 1 side × ₹3
  assert.equal(byKey.cutting, 150);
  near(r.cost, 3288.26);
  near(r.profit, 822.07); // 25 %
  near(r.taxable, 4110.33);
  near(r.gst, 739.86); // 18 %
  near(r.total, 4850.19);
  near(r.perPieceWithGst, 4.85019, 1e-4);
  assert.equal(r.plates, 4);
  assert.equal(r.impressions, 73 * 4);
});

test("pricing the paper per sheet instead of by weight", () => {
  const r = estimate({ ...FACTORY, paperPricing: "sheet", paperRatePerSheet: 6 });
  assert.equal(r.lines.find((l) => l.key === "paper").amount, 73 * 6);
});

test("digital printing bills clicks per printed side and has no plates", () => {
  const r = estimate({ ...FACTORY, process: "digital", digitalColor: true, digitalSides: 2, clickRateColor: 8 });
  assert.equal(r.plates, 0);
  assert.equal(r.impressions, 73 * 2);
  assert.equal(r.lines.find((l) => l.key === "press").amount, 73 * 2 * 8);
  assert.equal(r.lines.find((l) => l.key === "plates"), undefined);
});

test("finishing options add their own lines only when enabled", () => {
  const base = estimate({ ...FACTORY, lamination: { ...FACTORY.lamination, enabled: false }, cuttingPacking: { enabled: false, fixed: 0 } });
  assert.equal(base.lines.find((l) => l.key === "lamination"), undefined);
  const full = estimate({
    ...FACTORY,
    dieCut: { enabled: true, dieCost: 1500, ratePer1000Sheets: 400 },
    binding: { enabled: true, ratePerPiece: 6 },
    creaseFold: { enabled: true, ratePer1000Pieces: 250 },
    designCharge: 500
  });
  const by = Object.fromEntries(full.lines.map((l) => [l.key, l.amount]));
  assert.equal(by.die, 1500 + 400); // one thousand sheets
  assert.equal(by.binding, 6000);
  assert.equal(by.fold, 250);
  assert.equal(by.design, 500);
});

test("bad input gives a message and a zero estimate, never NaN", () => {
  for (const [input, message] of [[{ ...FACTORY, quantity: 0 }, /quantity/i], [{ ...FACTORY, width: 900 }, /larger than the printable area/]]) {
    const r = estimate(input);
    assert.match(r.error, message);
    assert.equal(r.total, 0);
    assert.ok(Number.isFinite(r.perPiece));
  }
});

test("a fractional quantity is rounded up and the margin and GST can be zero", () => {
  const r = estimate({ ...FACTORY, quantity: 99.2, marginPercent: 0, gstPercent: 0 });
  assert.equal(r.profit, 0);
  assert.equal(r.gst, 0);
  assert.equal(r.total, r.cost);
  assert.equal(r.netSheets, Math.ceil(100 / 48));
});

test("Reset returns to the shop's saved defaults, or the factory ones, with pickers matching", () => {
  const empty = { getItem: () => null };
  const factory = initialEstimatorState(empty);
  assert.deepEqual(factory.input, FACTORY);
  assert.equal(factory.productId, "visiting-card");
  assert.equal(factory.jobName, "Visiting cards");

  const saved = { getItem: (k) => (k === STORAGE_KEY ? JSON.stringify({ quantity: 250, plateRate: 500, width: 210, height: 297 }) : null) };
  const mine = initialEstimatorState(saved);
  assert.equal(mine.input.quantity, 250);
  assert.equal(mine.input.plateRate, 500);
  assert.equal(mine.input.colorsFront, FACTORY.colorsFront); // anything not saved falls back to factory
  assert.equal(mine.productId, productIdFor(210, 297));
  assert.equal(mine.sheetId, sheetIdFor(mine.input.sheetWidth, mine.input.sheetHeight));
  // a corrupt saved value never breaks the page
  assert.deepEqual(loadDefaults({ getItem: () => "{not json" }), FACTORY);
  assert.deepEqual(loadDefaults({ getItem: () => { throw new Error("blocked"); } }), FACTORY);
});
