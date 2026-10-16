import { isAreaUnit, priceLine, type AreaUnit } from "@/lib/billing";

/** How a line is priced: per unit (pieces, boxes…) or by area from its length and width. */
export type PricingMode = "unit" | AreaUnit;

/**
 * One invoice or quotation line while it is being edited. Numbers are kept as
 * the text typed, so a field can be cleared; lineInput() turns them into the
 * numbers the API takes.
 */
export interface LineDraft {
  key: number;
  itemName: string;
  description: string;
  pricing: PricingMode;
  quantity: string;
  /** The unit counted for per-unit lines; the area unit (sqft/sqm) for area lines. */
  unit: string;
  unitPrice: string;
  length: string;
  width: string;
}

const text = (n: unknown) => (n === undefined || n === null || n === "" || Number(n) === 0 ? "" : String(n));

export const newLineDraft = (key: number, patch: Partial<LineDraft> = {}): LineDraft => ({
  key,
  itemName: "",
  description: "",
  pricing: "unit",
  quantity: "1",
  unit: "pieces",
  unitPrice: "",
  length: "",
  width: "",
  ...patch
});

/** A saved line (either document) back into the editor. */
export function lineDraftFrom(
  key: number,
  line: { itemName?: string; description?: string; quantity?: number; unit?: string; unitPrice?: number; length?: number; width?: number; itemType?: string }
): LineDraft {
  // Older area lines from job tickets can say "pieces"; they were priced per sq ft.
  const unit = line.itemType === "Square Feet" && !isAreaUnit(line.unit) ? "sqft" : line.unit || "pieces";
  const hasSize = (line.length || 0) > 0 && (line.width || 0) > 0;
  return {
    key,
    itemName: line.itemName || "",
    description: line.description || "",
    pricing: isAreaUnit(unit) && hasSize ? unit : "unit",
    quantity: line.quantity === undefined ? "1" : String(line.quantity),
    unit,
    unitPrice: line.unitPrice === undefined ? "" : String(line.unitPrice),
    length: text(line.length),
    width: text(line.width)
  };
}

/** The pricing fields as the API takes them. Dimensions are only sent for area lines. */
export function lineInput(l: LineDraft) {
  const area = l.pricing !== "unit";
  return {
    quantity: Number(l.quantity) || 0,
    unit: area ? l.pricing : l.unit,
    unitPrice: Number(l.unitPrice) || 0,
    length: area ? Number(l.length) || 0 : 0,
    width: area ? Number(l.width) || 0 : 0
  };
}

export const lineAmount = (l: LineDraft) => priceLine(lineInput(l)).amount;

/** What is wrong with a line, or "" when it can be saved. */
export function lineProblem(l: LineDraft, n: number): string {
  if (!l.itemName.trim()) return `Line ${n}: enter the item name.`;
  if (!(Number(l.quantity) > 0)) return `Line ${n}: the quantity must be more than 0.`;
  if (l.unitPrice === "" || !(Number(l.unitPrice) >= 0)) return `Line ${n}: enter the rate.`;
  if (l.pricing !== "unit" && !(Number(l.length) > 0 && Number(l.width) > 0)) return `Line ${n}: enter the length and width.`;
  return "";
}

/** Changing how a line is priced keeps the rate and quantity and sets the unit to match. */
export function withPricing(l: LineDraft, pricing: PricingMode): LineDraft {
  if (pricing === "unit") return { ...l, pricing, unit: isAreaUnit(l.unit) ? "pieces" : l.unit };
  return { ...l, pricing, unit: pricing };
}
