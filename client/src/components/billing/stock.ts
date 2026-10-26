import { isAreaUnit } from "@/lib/billing";

/** A stock item as the inventory list returns it. */
export interface StockItem {
  _id?: string;
  id?: string;
  name: string;
  quantity?: number;
  unit?: string;
  unitCost?: number;
  description?: string;
  hsnCode?: string;
  status?: string;
}

/**
 * The stock item a line is for. An invoice takes stock by the item's exact
 * name (backend services/InventoryService.js), so this matches the same way.
 */
export const stockItemNamed = <T extends StockItem>(items: T[], name: string): T | undefined => {
  const n = name.trim();
  return n ? items.find((i) => i.name === n && (i.status || "active") === "active") : undefined;
};

const UNIT_LABEL: Record<string, string> = { pieces: "pcs", sqft: "sq ft", sqm: "sq m", grams: "g", liters: "L", meters: "m" };
export const unitText = (unit?: string) => (unit ? UNIT_LABEL[unit] || unit : "");
export const qtyText = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

/**
 * How much of the stock item a line uses, in the stock's own unit: a line
 * priced by area of stock counted in that area unit uses length × width ×
 * pieces; any other line uses its quantity. Mirrors stockNeeded on the server.
 */
export function stockNeeded(line: { quantity: number; unit?: string; length?: number; width?: number }, stockUnit?: string): number {
  const q = Number(line.quantity) || 0;
  const l = Number(line.length) || 0;
  const w = Number(line.width) || 0;
  if (isAreaUnit(line.unit) && line.unit === stockUnit && l > 0 && w > 0) return Math.round(l * w * q * 10000) / 10000;
  return q;
}
