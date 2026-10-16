/**
 * Print job costing: imposition, paper, plates, press and finishing.
 *
 * Pure functions with no UI, so the estimator page can price several
 * quantities at once (price breaks) from the same inputs.
 * All lengths are millimetres and all money is rupees.
 */

export type Process = "offset" | "digital";

export interface EstimateInput {
  quantity: number;
  /** Finished (trimmed) size of one piece */
  width: number;
  height: number;
  bleed: number;
  /** Space between pieces on the sheet */
  gutter: number;

  /** Sheet that goes through the press */
  sheetWidth: number;
  sheetHeight: number;
  /** Non-printable edge: gripper and side lays */
  margin: number;

  gsm: number;
  paperPricing: "kg" | "sheet";
  paperRatePerKg: number;
  paperRatePerSheet: number;
  wastagePercent: number;
  /** Fixed sheets spoiled getting the job up to colour */
  makeReadySheets: number;

  process: Process;
  colorsFront: number;
  colorsBack: number;
  plateRate: number;
  /** Offset: charge per 1,000 impressions, per colour */
  pressRatePer1000: number;
  /** Digital: charge per printed side of a sheet */
  clickRateColor: number;
  clickRateMono: number;
  digitalColor: boolean;
  digitalSides: 1 | 2;

  lamination: { enabled: boolean; sides: 1 | 2; ratePerSheetSide: number };
  spotUv: { enabled: boolean; ratePerSheet: number };
  dieCut: { enabled: boolean; dieCost: number; ratePer1000Sheets: number };
  creaseFold: { enabled: boolean; ratePer1000Pieces: number };
  binding: { enabled: boolean; ratePerPiece: number };
  numbering: { enabled: boolean; ratePer1000Pieces: number };
  cuttingPacking: { enabled: boolean; fixed: number };

  designCharge: number;
  otherCharge: number;
  marginPercent: number;
  gstPercent: number;
}

export interface Imposition {
  ups: number;
  across: number;
  down: number;
  /** True when pieces are turned 90° to fit more on the sheet */
  rotated: boolean;
  pieceWidth: number;
  pieceHeight: number;
  /** Share of the sheet that ends up as product, 0–1 */
  utilisation: number;
}

export interface CostLine {
  key: string;
  label: string;
  detail: string;
  amount: number;
}

export interface EstimateResult {
  imposition: Imposition;
  netSheets: number;
  wasteSheets: number;
  totalSheets: number;
  sheetWeightKg: number;
  paperKg: number;
  plates: number;
  impressions: number;
  lines: CostLine[];
  cost: number;
  profit: number;
  taxable: number;
  gst: number;
  total: number;
  perPiece: number;
  perPieceWithGst: number;
  error?: string;
}

const fit = (avail: number, size: number, gutter: number) =>
  size <= 0 ? 0 : Math.max(0, Math.floor((avail + gutter) / (size + gutter)));

/** How many finished pieces fit on one sheet, trying both orientations. */
export function impose(input: Pick<EstimateInput, "width" | "height" | "bleed" | "gutter" | "sheetWidth" | "sheetHeight" | "margin">): Imposition {
  const pw = input.width + 2 * input.bleed;
  const ph = input.height + 2 * input.bleed;
  const aw = input.sheetWidth - 2 * input.margin;
  const ah = input.sheetHeight - 2 * input.margin;

  const straight = { across: fit(aw, pw, input.gutter), down: fit(ah, ph, input.gutter) };
  const turned = { across: fit(aw, ph, input.gutter), down: fit(ah, pw, input.gutter) };
  const rotated = turned.across * turned.down > straight.across * straight.down;
  const best = rotated ? turned : straight;
  const ups = best.across * best.down;
  const sheetArea = input.sheetWidth * input.sheetHeight;

  return {
    ups,
    across: best.across,
    down: best.down,
    rotated,
    pieceWidth: rotated ? ph : pw,
    pieceHeight: rotated ? pw : ph,
    utilisation: sheetArea > 0 ? (ups * input.width * input.height) / sheetArea : 0,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function estimate(input: EstimateInput): EstimateResult {
  const imposition = impose(input);
  const empty: EstimateResult = {
    imposition, netSheets: 0, wasteSheets: 0, totalSheets: 0, sheetWeightKg: 0, paperKg: 0, plates: 0,
    impressions: 0, lines: [], cost: 0, profit: 0, taxable: 0, gst: 0, total: 0, perPiece: 0, perPieceWithGst: 0,
  };

  if (!input.quantity || input.quantity <= 0) return { ...empty, error: "Enter a quantity to price." };
  if (imposition.ups === 0) return { ...empty, error: "The job (with bleed) is larger than the printable area of the sheet." };

  const qty = Math.ceil(input.quantity);
  const netSheets = Math.ceil(qty / imposition.ups);
  const wasteSheets = Math.ceil((netSheets * input.wastagePercent) / 100) + Math.max(0, Math.round(input.makeReadySheets));
  const totalSheets = netSheets + wasteSheets;

  const sheetWeightKg = (input.sheetWidth / 1000) * (input.sheetHeight / 1000) * (input.gsm / 1000);
  const paperKg = sheetWeightKg * totalSheets;
  const paperCost = input.paperPricing === "kg" ? paperKg * input.paperRatePerKg : totalSheets * input.paperRatePerSheet;

  const lines: CostLine[] = [];
  lines.push({
    key: "paper",
    label: "Paper",
    detail:
      input.paperPricing === "kg"
        ? `${totalSheets.toLocaleString("en-IN")} sheets · ${paperKg.toFixed(2)} kg @ ₹${input.paperRatePerKg}/kg`
        : `${totalSheets.toLocaleString("en-IN")} sheets @ ₹${input.paperRatePerSheet}/sheet`,
    amount: paperCost,
  });

  let plates = 0;
  let impressions = 0;
  if (input.process === "offset") {
    plates = Math.max(0, input.colorsFront) + Math.max(0, input.colorsBack);
    if (plates > 0) {
      lines.push({ key: "plates", label: "Plates (CTP)", detail: `${plates} plate${plates === 1 ? "" : "s"} @ ₹${input.plateRate}`, amount: plates * input.plateRate });
    }
    // Presses bill in thousands of impressions, with the first thousand as the minimum.
    const thousands = Math.max(1, Math.ceil(totalSheets / 1000));
    const colourRuns = Math.max(0, input.colorsFront) + Math.max(0, input.colorsBack);
    impressions = totalSheets * colourRuns;
    if (colourRuns > 0) {
      lines.push({
        key: "press",
        label: "Printing",
        detail: `${input.colorsFront}/${input.colorsBack} colours · ${thousands}k imp. × ${colourRuns} @ ₹${input.pressRatePer1000}`,
        amount: thousands * colourRuns * input.pressRatePer1000,
      });
    }
  } else {
    const rate = input.digitalColor ? input.clickRateColor : input.clickRateMono;
    impressions = totalSheets * input.digitalSides;
    lines.push({
      key: "press",
      label: "Digital printing",
      detail: `${impressions.toLocaleString("en-IN")} clicks (${input.digitalColor ? "colour" : "B/W"}, ${input.digitalSides === 2 ? "both sides" : "one side"}) @ ₹${rate}`,
      amount: impressions * rate,
    });
  }

  if (input.lamination.enabled) {
    lines.push({
      key: "lamination",
      label: "Lamination",
      detail: `${netSheets.toLocaleString("en-IN")} sheets × ${input.lamination.sides} side${input.lamination.sides === 2 ? "s" : ""} @ ₹${input.lamination.ratePerSheetSide}`,
      amount: netSheets * input.lamination.sides * input.lamination.ratePerSheetSide,
    });
  }
  if (input.spotUv.enabled) {
    lines.push({ key: "uv", label: "Spot UV", detail: `${netSheets.toLocaleString("en-IN")} sheets @ ₹${input.spotUv.ratePerSheet}`, amount: netSheets * input.spotUv.ratePerSheet });
  }
  if (input.dieCut.enabled) {
    const k = Math.max(1, Math.ceil(netSheets / 1000));
    lines.push({
      key: "die",
      label: "Die-cutting",
      detail: `Die ₹${input.dieCut.dieCost} + ${k}k sheets @ ₹${input.dieCut.ratePer1000Sheets}`,
      amount: input.dieCut.dieCost + k * input.dieCut.ratePer1000Sheets,
    });
  }
  if (input.creaseFold.enabled) {
    const k = Math.max(1, Math.ceil(qty / 1000));
    lines.push({ key: "fold", label: "Creasing & folding", detail: `${k}k pieces @ ₹${input.creaseFold.ratePer1000Pieces}`, amount: k * input.creaseFold.ratePer1000Pieces });
  }
  if (input.binding.enabled) {
    lines.push({ key: "binding", label: "Binding", detail: `${qty.toLocaleString("en-IN")} pcs @ ₹${input.binding.ratePerPiece}`, amount: qty * input.binding.ratePerPiece });
  }
  if (input.numbering.enabled) {
    const k = Math.max(1, Math.ceil(qty / 1000));
    lines.push({ key: "numbering", label: "Numbering / perforation", detail: `${k}k pieces @ ₹${input.numbering.ratePer1000Pieces}`, amount: k * input.numbering.ratePer1000Pieces });
  }
  if (input.cuttingPacking.enabled && input.cuttingPacking.fixed > 0) {
    lines.push({ key: "cutting", label: "Cutting & packing", detail: "Fixed", amount: input.cuttingPacking.fixed });
  }
  if (input.designCharge > 0) {
    lines.push({ key: "design", label: "Design & pre-press", detail: "Fixed", amount: input.designCharge });
  }
  if (input.otherCharge > 0) {
    lines.push({ key: "other", label: "Other / outsourced", detail: "Fixed", amount: input.otherCharge });
  }

  for (const line of lines) line.amount = r2(line.amount);
  const cost = r2(lines.reduce((s, l) => s + l.amount, 0));
  const profit = r2((cost * input.marginPercent) / 100);
  const taxable = r2(cost + profit);
  const gst = r2((taxable * input.gstPercent) / 100);
  const total = r2(taxable + gst);

  return {
    imposition,
    netSheets,
    wasteSheets,
    totalSheets,
    sheetWeightKg,
    paperKg,
    plates,
    impressions,
    lines,
    cost,
    profit,
    taxable,
    gst,
    total,
    perPiece: taxable / qty,
    perPieceWithGst: total / qty,
  };
}
