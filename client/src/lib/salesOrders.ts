/**
 * Types and small helpers for sales orders and the product rate master. Prices
 * are NEVER worked out here: the server prices every order (POST
 * /product-rates/price while typing, and again when saving). The only
 * arithmetic here is the GST inclusive <-> exclusive display helper used while
 * entering a slab, which mirrors backend/src/utils/productPricing.js.
 */
export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const inclusiveFromExclusive = (excl: number, gst: number) => round2(excl * (1 + gst / 100));
export const exclusiveFromInclusive = (incl: number, gst: number) => round2(incl / (1 + gst / 100));

export const PARTY_TYPES = ["Walk-in", "Agency", "Individual", "Business", "Corporate"] as const;
export const SALES_TYPES = ["Retail", "Wholesale", "Project"] as const;
export const UNITS = ["pieces", "copies", "sheets", "sets", "sqft", "sqm", "kg", "meters"] as const;
export const isAreaUnit = (u?: string) => u === "sqft" || u === "sqm";

export interface Slab {
  from: number | string;
  to: number | string | null;
  exclusiveRate: number | string;
  inclusiveRate: number | string;
  rateBasis?: "exclusive" | "inclusive";
  isMinimum?: boolean;
}
export interface RateRule {
  customerId?: string;
  customerName?: string;
  partyType?: string;
  salesType?: string;
  minimumQuantity?: number | string;
  minimumAmount?: number | string;
  slabs: Slab[];
}
export interface ProductRateSummary {
  _id: string;
  materialType: string;
  productName: string;
  productCode?: string;
  unit: string;
  gstRate: number;
  taxExempt?: boolean;
  isActive: boolean;
  hsnCode?: string;
}
export interface ProductRateFull extends ProductRateSummary {
  cessRate?: number;
  rules: RateRule[];
}

export interface OrderLineForm {
  key: number;
  product: ProductRateSummary | null;
  /** What is typed in the product search box while no product is chosen. */
  query: string;
  copies: string;
  length: string;
  width: string;
  dimUnit: "ft" | "in" | "m" | "cm";
  discountType: "percent" | "amount";
  discountValue: string;
  overrideRate: string;
  overrideReason: string;
  wastage: string;
  workType: string;
  basicDetails: string;
  additionalDetails: string;
  stages: { design: boolean; printing: boolean; finishing: boolean };
}
export interface ChargeForm {
  key: number;
  name: string;
  amount: string;
  gstRate: string;
  taxable: boolean;
}

export interface PricedLine {
  priced: boolean;
  quantity: number;
  unit: string;
  basis: number;
  billableBasis: number;
  rate: number;
  rateBasis: string;
  gstRate: number;
  discount: number;
  taxable: number;
  gst: number;
  cess: number;
  total: number;
  warnings: { code: string; message: string }[];
  adjustments: { type: string; message: string }[];
  snapshotSummary?: { rule: { customerId: string | null; partyType: string | null; salesType: string | null }; slab: { from: number; to: number | null } };
}
export interface OrderTotals {
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  nonTaxableAmount: number;
  discount: number;
  roundOff: number;
  total: number;
  amountDue: number;
  advance: number;
  excess: number;
  balance: number;
  isInterState: boolean;
}

/** The request body for the price preview and for saving, from the form. */
export function orderPayload(f: {
  customerId: string; salesType: string; lines: OrderLineForm[]; charges: ChargeForm[]; advance?: number; isInterState?: boolean;
}) {
  return {
    customerId: f.customerId || undefined,
    salesType: f.salesType || undefined,
    isInterState: f.isInterState,
    advance: f.advance,
    lines: f.lines.filter((l) => l.product).map((l) => ({
      productId: l.product!._id,
      copies: Number(l.copies) || 0,
      length: Number(l.length) || undefined,
      width: Number(l.width) || undefined,
      dimUnit: l.dimUnit,
      discountType: l.discountType,
      discountValue: Number(l.discountValue) || 0,
      rateOverride: l.overrideRate !== "" ? { rate: Number(l.overrideRate), reason: l.overrideReason } : undefined,
      wastage: Number(l.wastage) || 0,
      workType: l.workType,
      basicDetails: l.basicDetails,
      additionalDetails: l.additionalDetails,
      stages: l.stages,
    })),
    otherCharges: f.charges.filter((c) => c.name || c.amount).map((c) => ({ name: c.name, amount: Number(c.amount) || 0, gstRate: Number(c.gstRate) || 0, taxable: c.taxable })),
  };
}

/** A sales order as the API returns it (the fields the screens read). */
export interface SalesOrderRecord {
  _id: string;
  orderNumber: string;
  orderDate?: string;
  dueDate?: string;
  projectName?: string;
  salesType?: string;
  copyOption?: string;
  notes?: string;
  status?: string;
  customerName?: string;
  customerId: string | { _id: string; name?: string };
  customerSnapshot?: { mobile?: string; address?: string };
  approval?: { status: string };
  production?: Record<string, { required: boolean; status: string; assigneeName?: string }>;
  orderLines?: SavedLine[];
  otherCharges?: { name?: string; amount?: number; gstRate?: number; taxable?: boolean }[];
}
export interface SavedLine {
  productId: string; productName: string; productCode?: string; materialType: string; unit: string;
  copies?: number; length?: number; width?: number; dimUnit?: "ft" | "in" | "m" | "cm";
  discountType?: "percent" | "amount"; discountValue?: number; wastage?: number; workType?: string;
  basicDetails?: string; additionalDetails?: string; stages?: { design: boolean; printing: boolean; finishing: boolean };
  pricing?: { gstRate?: number };
  pricingSnapshot?: { override?: { rate: number; reason?: string } };
}
export interface QuotationLine { itemName: string; productId?: string; materialType?: string; copies?: number; unit?: string; length?: number; width?: number; basicDetails?: string }
