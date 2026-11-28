/**
 * The paper a job ticket is printed on, picked from inventory.
 *
 * Choosing a paper (e.g. "Art Card 300 GSM") and a number of sheets puts one
 * line on the ticket's items: that stock item, the sheets as its quantity and
 * the paper's selling rate per sheet. The ticket's invoice then bills the line
 * and takes the sheets out of stock, the same as any other stock line
 * (backend services/InventoryService.js matches it by name).
 *
 * No imports, so `node --test` can load it directly (tests/paper-stock.test.mjs).
 */

export interface PaperStock {
  name: string;
  unit?: string;
  category?: string;
  status?: string;
  hsnCode?: string;
  gstRate?: number;
}

/** The fields of a job line this module reads and writes. */
export interface PaperLineFields {
  itemName: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
  itemType?: "Numbers" | "Square Feet";
  hsnCode?: string;
  gstRate: number;
  /** This line is the ticket's paper (client only; not saved). */
  fromPaper?: boolean;
}

export const PAPER_CATEGORY = "Paper & Printing Materials";

/**
 * Stock that can be chosen as a job's paper: active items counted, not
 * measured by area, that are filed as paper or kept in sheets or reams.
 */
export function paperStock<T extends PaperStock>(items: T[]): T[] {
  return items.filter(
    (i) =>
      (i.status || "active") === "active" &&
      i.unit !== "sqft" &&
      i.unit !== "sqm" &&
      (i.category === PAPER_CATEGORY || i.unit === "sheets" || i.unit === "reams")
  );
}

/**
 * The ticket's items with its paper line set to `sheets` of `paper`, or taken
 * off when there is no stock paper or no sheets. A rate the user typed on the
 * line is kept while the paper stays the same; a new paper starts at its own
 * selling rate.
 */
export function withPaperLine<L extends PaperLineFields, P extends PaperStock>(
  items: L[],
  paper: P | undefined,
  sheets: number,
  rateOf: (paper: P) => number,
  blank: () => L
): L[] {
  const at = items.findIndex((i) => i.fromPaper);
  if (!paper || !(sheets > 0)) return at < 0 ? items : items.filter((_, i) => i !== at);

  const current = at >= 0 ? items[at] : undefined;
  const samePaper = current?.itemName === paper.name;
  const line: L = {
    ...(samePaper ? current : blank()),
    itemName: paper.name,
    unit: paper.unit || "sheets",
    itemType: "Numbers",
    quantity: sheets,
    unitPrice: samePaper ? current.unitPrice : rateOf(paper),
    hsnCode: samePaper ? current.hsnCode : paper.hsnCode || undefined,
    gstRate: samePaper ? current.gstRate : paper.gstRate ?? 18,
    fromPaper: true
  };
  return at >= 0 ? items.map((item, i) => (i === at ? line : item)) : [...items, line];
}
