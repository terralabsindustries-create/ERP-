/**
 * Working back from a line total (including GST) to the unit price that
 * produces it, priced exactly as lib/billing.ts priceLine does:
 *   count item  amount = round2(qty × price)
 *   area item   amount = round2(round4(round4(L × W) × qty) × price)
 *   total       amount + amount × GST%
 * The price is kept to 2 decimals when that hits the total to the paisa,
 * otherwise up to 4 decimals; if no price hits it exactly, the closest is used
 * and `exact` is false so the screen can say so.
 */
export interface LineTotalInput {
  total: number;
  gstRate?: number;
  quantity?: number;
  unit?: string;
  length?: number;
  width?: number;
}

export interface LineTotalResult {
  unitPrice: number;
  /** The total that unit price actually gives, to the paisa. */
  total: number;
  exact: boolean;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const roundTo = (n: number, d: number) => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const isArea = (unit?: string) => unit === "sqft" || unit === "sqm";

/** The quantity the price is multiplied by: pieces, or total area for sq ft / sq m. */
export function pricedBase({ quantity, unit, length, width }: Omit<LineTotalInput, "total" | "gstRate">): number {
  const qty = num(quantity);
  if (isArea(unit)) {
    const l = num(length);
    const w = num(width);
    return l > 0 && w > 0 ? roundTo(roundTo(l * w, 4) * qty, 4) : 0;
  }
  return qty;
}

export function lineTotalFor(base: number, unitPrice: number, gstRate = 0): number {
  const amount = roundTo(base * unitPrice, 2);
  return roundTo(amount + (amount * num(gstRate)) / 100, 2);
}

/** null when the line has no quantity / size yet or the total is not positive. */
export function unitPriceForTotal(input: LineTotalInput): LineTotalResult | null {
  const target = roundTo(num(input.total), 2);
  const base = pricedBase(input);
  const gst = num(input.gstRate);
  if (!(target > 0) || !(base > 0)) return null;
  const ideal = target / (1 + gst / 100) / base;

  let best: LineTotalResult | null = null;
  for (const decimals of [2, 3, 4]) {
    const step = 10 ** -decimals;
    const centre = roundTo(ideal, decimals);
    for (const k of [0, -1, 1, -2, 2]) {
      const price = roundTo(centre + k * step, decimals);
      if (!(price > 0)) continue;
      const total = lineTotalFor(base, price, gst);
      const exact = Math.abs(total - target) < 0.005;
      if (exact) return { unitPrice: price, total, exact };
      if (!best || Math.abs(total - target) < Math.abs(best.total - target)) best = { unitPrice: price, total, exact };
    }
  }
  return best;
}
