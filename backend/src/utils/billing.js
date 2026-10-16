/**
 * Line and document arithmetic shared by invoices and quotations, so a
 * quotation and the invoice raised from it always price the same order the
 * same way. The client mirrors this in client/src/lib/billing.ts.
 *
 * No GST is charged. A line's amount is its price; a document's total is its
 * lines plus the design charge, less any discount. Older records still carry
 * the GST they were issued with — the Invoice model keeps rolling that up, see
 * its pre-save hook — but nothing here adds tax to a new line.
 */

/** Units priced by area, and the unit their length and width are measured in. */
const AREA_UNITS = {
  sqft: { label: 'sq ft', dimension: 'ft' },
  sqm: { label: 'sq m', dimension: 'm' }
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Areas keep four places: 1.1 ft × 1.1 ft is 1.21 sq ft, not 1.2100000000000002,
// and 1.25 ft × 0.75 ft stays 0.9375 rather than being rounded before pricing.
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isAreaUnit = (unit) => Object.prototype.hasOwnProperty.call(AREA_UNITS, unit);

/**
 * Price one line.
 *
 * Area pricing applies when the unit is sq ft or sq m and the line has both a
 * length and a width: each piece is length × width, the line covers that area
 * times the quantity, and the amount is that area times the rate.
 *   6 ft × 4 ft = 24 sq ft per piece; 10 pieces = 240 sq ft; @ ₹12 = ₹2,880.
 *
 * Anything else is quantity × rate. That includes an older sq ft line with no
 * dimensions, whose quantity was the area itself ("24 sq ft").
 */
function priceLine({ quantity, unitPrice, unit, length, width } = {}) {
  const qty = num(quantity);
  const rate = num(unitPrice);
  const l = num(length);
  const w = num(width);

  if (isAreaUnit(unit) && l > 0 && w > 0) {
    const areaPerPiece = round4(l * w);
    const totalArea = round4(areaPerPiece * qty);
    return { isArea: true, quantity: qty, unitPrice: rate, length: l, width: w, areaPerPiece, totalArea, amount: round2(totalArea * rate) };
  }
  return { isArea: false, quantity: qty, unitPrice: rate, length: 0, width: 0, areaPerPiece: 0, totalArea: 0, amount: round2(qty * rate) };
}

/**
 * A design charge as the API accepts it: a number, or the { amount } object a
 * job ticket carries (its GST fields are ignored). Returns null when the value
 * is not a usable non-negative amount, so callers can reject it.
 */
function parseDesignCharge(value) {
  if (value === undefined || value === null || value === '') return 0;
  const raw = typeof value === 'object' ? value.amount : value;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return round2(n);
}

/** Lines + design charge − discount. `amounts` are the priced line amounts. */
function documentTotals(amounts, designCharge = 0, discount = 0) {
  const subtotal = round2(amounts.reduce((s, a) => s + num(a), 0));
  const design = round2(Math.max(0, num(designCharge)));
  const gross = round2(subtotal + design);
  const disc = round2(Math.max(0, num(discount)));
  return { subtotal, designCharge: design, gross, discount: disc, total: round2(gross - disc) };
}

/**
 * An invoice line as stored, priced from what the client sent. Only the
 * quantity, unit, rate and dimensions are taken; every amount is recomputed.
 * A job ticket marks area lines with itemType 'Square Feet' and its unit may
 * still say pieces, so such a line is treated as sq ft.
 */
function toInvoiceLine(item = {}) {
  const unit = item.itemType === 'Square Feet' && !isAreaUnit(item.unit) ? 'sqft' : item.unit || 'pieces';
  const p = priceLine({ quantity: item.quantity, unitPrice: item.unitPrice, unit, length: item.length, width: item.width });
  return {
    itemName: String(item.itemName || '').trim(),
    description: item.description ? String(item.description).trim() : '',
    quantity: p.quantity,
    unit,
    unitPrice: p.unitPrice,
    itemType: p.isArea ? 'Square Feet' : 'Numbers',
    length: p.length,
    width: p.width,
    areaPerPiece: p.areaPerPiece,
    totalSquareFeet: p.totalArea,
    itemQuantity: p.isArea ? p.totalArea : p.quantity,
    totalAmount: p.amount,
    itemTotal: p.amount,
    gstRate: 0,
    gstAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0
  };
}

/** A quotation line as stored — the same pricing as toInvoiceLine, in the quotation's field names. */
function toQuotationLine(item = {}) {
  const unit = item.unit || 'pieces';
  const p = priceLine({ quantity: item.quantity, unitPrice: item.unit_price, unit, length: item.length, width: item.width });
  return {
    item_name: String(item.item_name || '').trim(),
    description: item.description ? String(item.description).trim() : '',
    quantity: p.quantity,
    unit,
    unit_price: p.unitPrice,
    length: p.length,
    width: p.width,
    area_per_piece: p.areaPerPiece,
    total_area: p.totalArea,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: p.amount
  };
}

/** The invoice line a quotation line becomes on conversion. */
const quotationLineToInvoiceLine = (q) =>
  toInvoiceLine({ itemName: q.item_name, description: q.description, quantity: q.quantity, unit: q.unit, unitPrice: q.unit_price, length: q.length, width: q.width });

/** "6 × 4 ft", or '' for a line without dimensions. */
function sizeLabel(line) {
  const meta = AREA_UNITS[line.unit];
  if (!meta || !(num(line.length) > 0 && num(line.width) > 0)) return '';
  return `${fmtQty(line.length)} × ${fmtQty(line.width)} ${meta.dimension}`;
}

function fmtQty(n, maxDigits = 4) {
  const v = num(n);
  return Number.isInteger(v) ? String(v) : v.toLocaleString('en-IN', { maximumFractionDigits: maxDigits });
}

/** "240 sq ft". */
function areaLabel(area, unit) {
  const meta = AREA_UNITS[unit];
  return `${fmtQty(area)} ${meta ? meta.label : unit || ''}`.trim();
}

module.exports = {
  AREA_UNITS,
  isAreaUnit,
  round2,
  round4,
  priceLine,
  parseDesignCharge,
  documentTotals,
  toInvoiceLine,
  toQuotationLine,
  quotationLineToInvoiceLine,
  sizeLabel,
  areaLabel,
  fmtQty
};
