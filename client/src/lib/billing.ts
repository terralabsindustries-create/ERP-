/**
 * Line and document arithmetic for invoices and quotations. Mirrors
 * backend/src/utils/billing.js, so the totals a form shows are the totals the
 * server stores — the server always recomputes them.
 *
 * No GST is charged. A line is quantity × rate, or, for a line priced by area,
 * length × width × quantity × rate. A document is its lines plus the design
 * charge, less any discount.
 */

export const AREA_UNITS = {
  sqft: { label: "sq ft", dimension: "ft" },
  sqm: { label: "sq m", dimension: "m" }
} as const;
export type AreaUnit = keyof typeof AREA_UNITS;

export const isAreaUnit = (unit?: string): unit is AreaUnit => unit === "sqft" || unit === "sqm";

export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The pricing fields of a line, in either document's terms. */
export interface PricedInput {
  quantity: number | string;
  unitPrice: number | string;
  unit?: string;
  length?: number | string | null;
  width?: number | string | null;
}

export interface PricedLine {
  isArea: boolean;
  areaPerPiece: number;
  totalArea: number;
  amount: number;
}

/** 6 ft × 4 ft = 24 sq ft a piece; × 10 pieces = 240 sq ft; @ ₹12 = ₹2,880. */
export function priceLine({ quantity, unitPrice, unit, length, width }: PricedInput): PricedLine {
  const qty = num(quantity);
  const rate = num(unitPrice);
  const l = num(length);
  const w = num(width);
  if (isAreaUnit(unit) && l > 0 && w > 0) {
    const areaPerPiece = round4(l * w);
    const totalArea = round4(areaPerPiece * qty);
    return { isArea: true, areaPerPiece, totalArea, amount: round2(totalArea * rate) };
  }
  return { isArea: false, areaPerPiece: 0, totalArea: 0, amount: round2(qty * rate) };
}

export interface DocumentTotals {
  subtotal: number;
  designCharge: number;
  discount: number;
  /** Lines + design charge, before the discount. */
  gross: number;
  total: number;
}

export function documentTotals(amounts: number[], designCharge = 0, discount = 0): DocumentTotals {
  const subtotal = round2(amounts.reduce((s, a) => s + num(a), 0));
  const design = round2(Math.max(0, num(designCharge)));
  const gross = round2(subtotal + design);
  const disc = round2(Math.max(0, num(discount)));
  return { subtotal, designCharge: design, discount: disc, gross, total: round2(gross - disc) };
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("en-IN", { maximumFractionDigits: 4 }));

/** "6 ft × 4 ft = 24 sq ft each · 10 pcs = 240 sq ft", or "" for a line without dimensions. */
export function describeArea(line: PricedInput): string {
  const p = priceLine(line);
  if (!p.isArea || !isAreaUnit(line.unit)) return "";
  const { label, dimension } = AREA_UNITS[line.unit];
  const each = `${fmtNum(num(line.length))} ${dimension} × ${fmtNum(num(line.width))} ${dimension} = ${fmtNum(p.areaPerPiece)} ${label} each`;
  return `${each} · ${fmtNum(num(line.quantity))} pcs = ${fmtNum(p.totalArea)} ${label}`;
}

/** "6 × 4 ft". */
export function sizeLabel(line: { unit?: string; length?: number | null; width?: number | null }): string {
  if (!isAreaUnit(line.unit) || !(num(line.length) > 0 && num(line.width) > 0)) return "";
  return `${fmtNum(num(line.length))} × ${fmtNum(num(line.width))} ${AREA_UNITS[line.unit].dimension}`;
}

export const areaText = (area: number, unit?: string) => `${fmtNum(num(area))} ${isAreaUnit(unit) ? AREA_UNITS[unit].label : unit || ""}`.trim();
