/**
 * Quantity-slab pricing, mirroring backend/src/services/pricingService.js so
 * the preview a screen shows equals what the server stores (the server always
 * decides; client/tests/pricing.test.mjs checks both agree on the same cases).
 * The whole line takes the rate of the highest minQty not above the quantity.
 */
export interface Slab { minQty: number; rate: number }

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/** Rows as typed (strings allowed). Returns sorted slabs and one message per problem. */
export function validateSlabs(rows: { minQty: string | number; rate: string | number }[]): { slabs: Slab[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<number>();
  const slabs: Slab[] = [];
  rows.forEach((r, i) => {
    const row = `Row ${i + 1}`;
    const minQty = r.minQty === "" ? NaN : Number(r.minQty);
    const rate = r.rate === "" ? NaN : Number(r.rate);
    if (!Number.isFinite(minQty) || minQty <= 0) return errors.push(`${row}: quantity must be a number above 0`);
    if (!Number.isFinite(rate) || rate < 0) return errors.push(`${row}: rate must be a number, 0 or more`);
    if (seen.has(round4(minQty))) return errors.push(`Quantity ${round4(minQty)} appears more than once`);
    seen.add(round4(minQty));
    slabs.push({ minQty: round4(minQty), rate: round4(rate) });
  });
  slabs.sort((a, b) => a.minQty - b.minQty);
  return { slabs, errors };
}

export function slabFor(slabs: Slab[], quantity: number): Slab | null {
  let hit: Slab | null = null;
  for (const s of slabs) if (s.minQty <= quantity && (!hit || s.minQty > hit.minQty)) hit = s;
  return hit;
}

export const slabRanges = (slabs: Slab[]) => {
  const sorted = [...slabs].sort((a, b) => a.minQty - b.minQty);
  return sorted.map((s, i) => ({ ...s, maxQty: i + 1 < sorted.length ? sorted[i + 1].minQty : null }));
};

/** "1 – 10", "11 – 49", "2,500 and above" */
export const rangeLabel = (r: { minQty: number; maxQty: number | null }) => {
  const f = (n: number) => n.toLocaleString("en-IN");
  if (r.maxQty === null) return `${f(r.minQty)} and above`;
  const upper = Number.isInteger(r.maxQty) ? r.maxQty - 1 : r.maxQty;
  return upper <= r.minQty ? f(r.minQty) : `${f(r.minQty)} – ${f(upper)}`;
};

/** Amounts for a line at an entered rate (same split as the server). */
export function lineAmounts(quantity: number, rate: number, gstRate: number, taxInclusive: boolean) {
  const factor = 1 + gstRate / 100;
  const gross = round2(quantity * rate);
  if (taxInclusive) {
    const taxable = round2(gross / factor);
    return { taxable, gst: round2(gross - taxable), total: gross };
  }
  const gst = round2((gross * gstRate) / 100);
  return { taxable: gross, gst, total: round2(gross + gst) };
}
