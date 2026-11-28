/** Client slab logic agrees with the backend on the same cases (backend/tests/pricing-unit.test.js). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSlabs, slabFor, slabRanges, rangeLabel, lineAmounts } from "../src/lib/pricing.ts";

const slabs = [[1, 25], [11, 23], [50, 22], [100, 20], [500, 18], [1000, 15], [2500, 13]].map(([minQty, rate]) => ({ minQty, rate }));

test("every boundary quantity takes the same rate as the server", () => {
  const expected = { 1: 25, 5: 25, 10: 25, 11: 23, 25: 23, 49: 23, 50: 22, 75: 22, 99: 22, 100: 20, 150: 20, 499: 20, 500: 18, 750: 18, 999: 18, 1000: 15, 1500: 15, 2499: 15, 2500: 13, 3000: 13 };
  for (const [q, r] of Object.entries(expected)) assert.equal(slabFor(slabs, Number(q)).rate, r, `qty ${q}`);
  assert.equal(slabFor(slabs, 0.5), null);
});

test("typed rows are validated like the server: blanks, zero, negatives and duplicates", () => {
  assert.equal(validateSlabs([{ minQty: "", rate: 5 }]).errors.length, 1);
  assert.equal(validateSlabs([{ minQty: 0, rate: 5 }]).errors.length, 1);
  assert.equal(validateSlabs([{ minQty: 5, rate: -1 }]).errors.length, 1);
  assert.match(validateSlabs([{ minQty: 5, rate: 1 }, { minQty: "5", rate: 2 }]).errors[0], /more than once/);
  assert.deepEqual(validateSlabs([{ minQty: "100", rate: "20" }, { minQty: 1, rate: 25 }]).slabs.map((s) => s.minQty), [1, 100]);
});

test("ranges read naturally", () => {
  const r = slabRanges(slabs);
  assert.deepEqual([rangeLabel(r[0]), rangeLabel(r[1]), rangeLabel(r[6])], ["1 – 10", "11 – 49", "2,500 and above"]);
});

test("GST-inclusive and -exclusive amounts match the backend arithmetic", () => {
  assert.deepEqual(lineAmounts(10, 100, 18, false), { taxable: 1000, gst: 180, total: 1180 });
  assert.deepEqual(lineAmounts(10, 118, 18, true), { taxable: 1000, gst: 180, total: 1180 });
});
