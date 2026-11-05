/**
 * Line and document arithmetic for job tickets, invoices and quotations.
 * Mirrors backend/src/utils/billing.js, so the totals a form shows are the
 * totals the server stores — the server always recomputes them.
 *
 * A line is quantity × rate, or, for a line priced by area, length × width ×
 * quantity × rate — its amount before tax. Each line and the design charge
 * carry their own GST rate:
 *   taxable amount = lines + design charge − discount
 *   GST            = each part's rate on its share of the taxable amount
 *   total          = taxable amount + GST
 * GST is CGST + SGST within the state and IGST between states.
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
  /** Before tax: gross − discount. */
  total: number;
}

export function documentTotals(amounts: number[], designCharge = 0, discount = 0): DocumentTotals {
  const subtotal = round2(amounts.reduce((s, a) => s + num(a), 0));
  const design = round2(Math.max(0, num(designCharge)));
  const gross = round2(subtotal + design);
  const disc = round2(Math.max(0, num(discount)));
  return { subtotal, designCharge: design, discount: disc, gross, total: round2(gross - disc) };
}

/** A GST rate as typed: 0–100, blank is 0; null when it is not a usable rate. */
export function parseGstRate(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return round4(n);
}

/** CGST + SGST halves that always add back to the tax, or all IGST between states. */
export function splitGst(gstAmount: number, isInterState: boolean) {
  if (isInterState) return { cgstAmount: 0, sgstAmount: 0, igstAmount: gstAmount };
  const half = round2(gstAmount / 2);
  return { cgstAmount: half, sgstAmount: round2(gstAmount - half), igstAmount: 0 };
}

/** splitGst for each tax in turn, an odd paisa going to whichever side is behind. */
export function splitGstAll(gstAmounts: number[], isInterState: boolean) {
  let lean = 0;
  return gstAmounts.map((gstAmount) => {
    if (isInterState) return { cgstAmount: 0, sgstAmount: 0, igstAmount: gstAmount };
    const paise = Math.round(num(gstAmount) * 100);
    const low = Math.floor(paise / 2);
    const cgst = lean > 0 ? low : paise - low;
    lean += cgst - (paise - cgst);
    return { cgstAmount: cgst / 100, sgstAmount: (paise - cgst) / 100, igstAmount: 0 };
  });
}

export interface TaxInput {
  amount: number;
  gstRate: number | string;
}

export interface TaxedPart {
  amount: number;
  gstRate: number;
  discountShare: number;
  taxableValue: number;
  gstAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
}

/**
 * Tax each part — the lines and the design charge. The discount comes off
 * before tax, shared by value; the largest part takes the paisa rounding
 * leaves over, so the shares add up to the discount exactly.
 */
export function applyGst(parts: TaxInput[], discount = 0, isInterState = false): TaxedPart[] {
  const amounts = parts.map((p) => round2(num(p.amount)));
  const gross = round2(amounts.reduce((s, a) => s + a, 0));
  const disc = round2(Math.min(Math.max(0, num(discount)), gross));

  let largest = -1;
  amounts.forEach((a, i) => {
    if (largest < 0 || a > amounts[largest]) largest = i;
  });
  const shares = amounts.map((a, i) => (gross > 0 && i !== largest ? round2((disc * a) / gross) : 0));
  if (largest >= 0) shares[largest] = round2(disc - shares.reduce((s, x) => s + x, 0));

  const taxed = parts.map((p, i) => {
    const gstRate = num(p.gstRate);
    const taxableValue = round2(amounts[i] - shares[i]);
    const gstAmount = round2((taxableValue * gstRate) / 100);
    return { amount: amounts[i], gstRate, discountShare: shares[i], taxableValue, gstAmount };
  });
  const splits = splitGstAll(taxed.map((t) => t.gstAmount), isInterState);
  return taxed.map((t, i) => ({ ...t, ...splits[i] }));
}

export interface GstTotals extends DocumentTotals {
  /** Lines + design charge − discount: what GST is charged on. */
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
  /** taxableAmount + GST. */
  total: number;
  lines: TaxedPart[];
  design: TaxedPart;
}

/** A document's totals with GST. Line amounts are before tax. */
export function gstTotals(lines: TaxInput[], design: Partial<TaxInput> = {}, discount = 0, isInterState = false): GstTotals {
  const base = documentTotals(lines.map((l) => num(l.amount)), num(design.amount), discount);
  const parts = applyGst([...lines, { amount: base.designCharge, gstRate: design.gstRate ?? 0 }], base.discount, isInterState);
  const sum = (field: "cgstAmount" | "sgstAmount" | "igstAmount" | "gstAmount") => round2(parts.reduce((s, p) => s + p[field], 0));
  const gst = sum("gstAmount");
  return {
    ...base,
    taxableAmount: base.total,
    cgst: sum("cgstAmount"),
    sgst: sum("sgstAmount"),
    igst: sum("igstAmount"),
    gst,
    total: round2(base.total + gst),
    lines: parts.slice(0, -1),
    design: parts[parts.length - 1]
  };
}

export interface GstRateRow {
  rate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
}

/** Taxed parts grouped by rate, lowest first; rates with no tax are left out. */
export function gstByRate(parts: Array<Partial<TaxedPart>>): GstRateRow[] {
  const byRate = new Map<number, GstRateRow>();
  for (const p of parts) {
    const rate = num(p.gstRate);
    if (!(rate > 0) || !(num(p.gstAmount) > 0 || num(p.cgstAmount) + num(p.sgstAmount) + num(p.igstAmount) > 0)) continue;
    const row = byRate.get(rate) || { rate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, gst: 0 };
    row.taxableValue = round2(row.taxableValue + num(p.taxableValue));
    row.cgst = round2(row.cgst + num(p.cgstAmount));
    row.sgst = round2(row.sgst + num(p.sgstAmount));
    row.igst = round2(row.igst + num(p.igstAmount));
    row.gst = round2(row.cgst + row.sgst + row.igst);
    byRate.set(rate, row);
  }
  return [...byRate.values()].sort((a, b) => a.rate - b.rate);
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
