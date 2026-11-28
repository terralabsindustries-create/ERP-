/*
  The Print Estimator's presets and its starting state, in one place so the
  first load and Reset always agree (Reset used to leave the Product picker on
  "Custom size" while restoring a visiting card's size).
*/
import type { EstimateInput } from "./printEstimate.ts";

/* ------------------------------------------------------------------ presets */

export const PRODUCTS = [
  { id: "visiting-card", label: "Visiting card", width: 89, height: 51 },
  { id: "flyer-a5", label: "Flyer / leaflet A5", width: 148, height: 210 },
  { id: "flyer-a4", label: "Flyer / letterhead A4", width: 210, height: 297 },
  { id: "poster-a3", label: "Poster A3", width: 297, height: 420 },
  { id: "brochure", label: "Tri-fold brochure (A4 open)", width: 297, height: 210 },
  { id: "invitation", label: "Invitation card 7×10\"", width: 178, height: 254 },
  { id: "bill-book", label: "Bill book page A5", width: 148, height: 210 },
  { id: "label", label: "Sticker / label 100×50", width: 100, height: 50 },
  { id: "custom", label: "Custom size", width: 0, height: 0 },
];

export const SHEETS = [
  { id: "demy", label: "Demy 18×23\"", width: 457, height: 584 },
  { id: "double-demy", label: "Double Demy 23×36\"", width: 584, height: 914 },
  { id: "crown", label: "Crown 15×20\"", width: 381, height: 508 },
  { id: "double-crown", label: "Double Crown 20×30\"", width: 508, height: 762 },
  { id: "royal", label: "Royal 20×25\"", width: 508, height: 635 },
  { id: "sra3", label: "SRA3 320×450 mm", width: 320, height: 450 },
  { id: "12x18", label: "12×18\"", width: 305, height: 457 },
  { id: "13x19", label: "13×19\"", width: 330, height: 483 },
  { id: "a3", label: "A3 297×420 mm", width: 297, height: 420 },
  { id: "custom", label: "Custom sheet", width: 0, height: 0 },
];

export const FACTORY: EstimateInput = {
  quantity: 1000,
  width: 89,
  height: 51,
  bleed: 2,
  gutter: 0,
  sheetWidth: 457,
  sheetHeight: 584,
  margin: 8,
  gsm: 300,
  paperPricing: "kg",
  paperRatePerKg: 95,
  paperRatePerSheet: 6,
  wastagePercent: 5,
  makeReadySheets: 50,
  process: "offset",
  colorsFront: 4,
  colorsBack: 0,
  plateRate: 450,
  pressRatePer1000: 180,
  clickRateColor: 8,
  clickRateMono: 2,
  digitalColor: true,
  digitalSides: 1,
  lamination: { enabled: true, sides: 1, ratePerSheetSide: 3 },
  spotUv: { enabled: false, ratePerSheet: 2.5 },
  dieCut: { enabled: false, dieCost: 1500, ratePer1000Sheets: 400 },
  creaseFold: { enabled: false, ratePer1000Pieces: 250 },
  binding: { enabled: false, ratePerPiece: 6 },
  numbering: { enabled: false, ratePer1000Pieces: 150 },
  cuttingPacking: { enabled: true, fixed: 150 },
  designCharge: 0,
  otherCharge: 0,
  marginPercent: 25,
  gstPercent: 18,
};

export const STORAGE_KEY = "terralabs.estimator.defaults";

export const loadDefaults = (storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): EstimateInput => {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return saved ? { ...FACTORY, ...JSON.parse(saved) } : FACTORY;
  } catch {
    return FACTORY;
  }
};

/** The product preset of this finished size, or "custom". */
export const productIdFor = (width: number, height: number) =>
  PRODUCTS.find((p) => p.id !== "custom" && p.width === width && p.height === height)?.id || "custom";

/** The sheet preset of this size, or "custom". */
export const sheetIdFor = (width: number, height: number) =>
  SHEETS.find((s) => s.id !== "custom" && s.width === width && s.height === height)?.id || "custom";

export interface EstimatorState {
  input: EstimateInput;
  jobName: string;
  paperName: string;
  productId: string;
  sheetId: string;
  sizeUnit: "mm" | "in";
}

/**
 * Everything the estimator starts from: the shop's saved rates (or the
 * factory ones), with the product and sheet pickers matching those sizes.
 * Results and validation messages are derived from `input`, so they reset too.
 */
export function initialEstimatorState(storage?: Pick<Storage, "getItem">): EstimatorState {
  const input = loadDefaults(storage);
  const productId = productIdFor(input.width, input.height);
  const product = PRODUCTS.find((p) => p.id === productId);
  return {
    input,
    jobName: productId === "custom" ? "Print job" : product!.id === "visiting-card" ? "Visiting cards" : product!.label,
    paperName: "Art card",
    productId,
    sheetId: sheetIdFor(input.sheetWidth, input.sheetHeight),
    sizeUnit: "mm",
  };
}
