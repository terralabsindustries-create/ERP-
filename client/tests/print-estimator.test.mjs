/**
 * Print Estimator regression and Reset. The factory inputs are the manual
 * audit's verified scenario: a 89×51 mm visiting card, 1,000 pcs, 300 GSM on
 * Demy — 48 per sheet and ₹4,850.19 with 25% margin and 18% GST.
 * Run from client/: node --test tests/print-estimator.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimate, impose } from "../src/lib/printEstimate.ts";
import { FACTORY, initialEstimatorState, productIdFor, sheetIdFor, STORAGE_KEY } from "../src/lib/estimatorPresets.ts";

test("the verified visiting-card scenario: 48 up and ₹4,850.19", () => {
  const r = estimate(FACTORY);
  assert.equal(impose(FACTORY).ups, 48);
  assert.equal(r.imposition.ups, 48);
  assert.equal(r.cost, 3288.26);
  assert.equal(r.taxable, 4110.33);
  assert.equal(r.gst, 739.86);
  assert.equal(r.total, 4850.19);
});

test("price breaks stay as verified", () => {
  assert.equal(estimate({ ...FACTORY, quantity: 500 }).total, 4682.52);
  assert.equal(estimate({ ...FACTORY, quantity: 2000 }).total, 5189.94);
});

test("a negative or missing quantity is refused", () => {
  assert.match(estimate({ ...FACTORY, quantity: -5 }).error, /quantity/i);
  assert.match(estimate({ ...FACTORY, quantity: 0 }).error, /quantity/i);
});

test("a job larger than the sheet is refused", () => {
  assert.match(estimate({ ...FACTORY, width: 900, height: 900 }).error, /larger than the printable area/);
});

test("the starting state matches its pickers: visiting card on Demy", () => {
  const s = initialEstimatorState({ getItem: () => null });
  assert.equal(s.productId, "visiting-card");
  assert.equal(s.sheetId, "demy");
  assert.equal(s.jobName, "Visiting cards");
  assert.equal(s.sizeUnit, "mm");
  assert.deepEqual(s.input, FACTORY);
});

test("Reset after edits restores product, sizes and every input — not 'Custom size'", () => {
  const storage = { getItem: () => null };
  const edited = { ...initialEstimatorState(storage), productId: "custom", input: { ...FACTORY, width: 120, quantity: 7 } };
  const reset = initialEstimatorState(storage);
  assert.notDeepEqual(edited.input, reset.input);
  assert.equal(reset.productId, "visiting-card");
  assert.equal(productIdFor(reset.input.width, reset.input.height), reset.productId);
  assert.deepEqual(reset.input, FACTORY);
});

test("saved shop rates with an A4 size start on the A4 preset; unknown sizes on Custom", () => {
  const a4 = initialEstimatorState({ getItem: (k) => (k === STORAGE_KEY ? JSON.stringify({ width: 210, height: 297 }) : null) });
  assert.equal(a4.productId, "flyer-a4");
  assert.equal(productIdFor(123, 45), "custom");
  assert.equal(sheetIdFor(320, 450), "sra3");
});
