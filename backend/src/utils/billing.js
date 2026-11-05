/**
 * Line and document arithmetic shared by invoices and quotations, so a job
 * ticket, a quotation and the invoice raised from either always price the same
 * order the same way. The client mirrors this in client/src/lib/billing.ts.
 *
 * A line's amount is its price before tax. Each line, and the design charge,
 * carries its own GST rate:
 *   taxable amount = lines + design charge − discount
 *   GST            = each part's rate on its share of the taxable amount
 *   total          = taxable amount + GST
 * Within the state the GST is split into CGST + SGST; between states it is
 * IGST. See gstTotals().
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

/** Lines + design charge − discount, before tax. `amounts` are the priced line amounts. */
function documentTotals(amounts, designCharge = 0, discount = 0) {
  const subtotal = round2(amounts.reduce((s, a) => s + num(a), 0));
  const design = round2(Math.max(0, num(designCharge)));
  const gross = round2(subtotal + design);
  const disc = round2(Math.max(0, num(discount)));
  return { subtotal, designCharge: design, gross, discount: disc, total: round2(gross - disc) };
}

/**
 * A GST rate as the API accepts it: a number from 0 to 100 (0.25 and 1.5 are
 * real rates). Missing or blank is 0. Returns null when the value is not a
 * usable rate, so callers can reject it.
 */
function parseGstRate(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return round4(n);
}

/**
 * The design charge's GST rate: an explicit designChargeGstRate, else the rate
 * on a job ticket's { amount, gstRate } design charge, else 0.
 */
function parseDesignChargeGstRate(designCharge, explicitRate) {
  if (explicitRate !== undefined && explicitRate !== null && explicitRate !== '') return parseGstRate(explicitRate);
  if (designCharge && typeof designCharge === 'object') return parseGstRate(designCharge.gstRate);
  return 0;
}

/**
 * Within a state the tax is split into CGST + SGST; the halves always add back
 * to the exact tax (halving an odd number of paise and rounding both would
 * lose one). Between states it is all IGST.
 */
function splitGst(gstAmount, isInterState) {
  if (isInterState) return { cgstAmount: 0, sgstAmount: 0, igstAmount: gstAmount };
  const half = round2(gstAmount / 2);
  return { cgstAmount: half, sgstAmount: round2(gstAmount - half), igstAmount: 0 };
}

/**
 * splitGst for each of a document's taxes in turn. An odd paisa goes to
 * whichever of CGST and SGST is behind so far, so the document's CGST and
 * SGST never drift more than a paisa apart (always halving up would put
 * CGST ahead by a paisa on every odd line).
 */
function splitGstAll(gstAmounts, isInterState) {
  let lean = 0; // paise CGST is ahead of SGST so far
  return gstAmounts.map((gstAmount) => {
    if (isInterState) return { cgstAmount: 0, sgstAmount: 0, igstAmount: gstAmount };
    const paise = Math.round(num(gstAmount) * 100);
    const low = Math.floor(paise / 2);
    const cgst = lean > 0 ? low : paise - low;
    lean += cgst - (paise - cgst);
    return { cgstAmount: cgst / 100, sgstAmount: (paise - cgst) / 100, igstAmount: 0 };
  });
}

/**
 * Tax each part of a document — its lines and its design charge, each
 * { amount, gstRate }. A document-level discount comes off before tax: it is
 * shared across the parts by value, the largest part taking the paisa that
 * rounding leaves over so the shares add up to the discount exactly, and each
 * part is taxed at its own rate on what is left of it.
 */
function applyGst(parts, discount = 0, isInterState = false) {
  const amounts = parts.map((p) => round2(num(p.amount)));
  const gross = round2(amounts.reduce((s, a) => s + a, 0));
  const disc = round2(Math.min(Math.max(0, num(discount)), gross));

  let largest = -1;
  amounts.forEach((a, i) => { if (largest < 0 || a > amounts[largest]) largest = i; });
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

/**
 * Everything a document totals to, with GST.
 *   lines   [{ amount, gstRate }] — amounts before tax
 *   design  { amount, gstRate }   — the design charge
 * Returns documentTotals' figures plus taxableAmount, cgst, sgst, igst, gst,
 * the taxed parts (lines, design) and total = taxable amount + GST.
 */
function gstTotals(lines, design = {}, discount = 0, isInterState = false) {
  const base = documentTotals(lines.map((l) => l.amount), design.amount, discount);
  const parts = applyGst([...lines, { amount: base.designCharge, gstRate: design.gstRate }], base.discount, isInterState);
  const sum = (field) => round2(parts.reduce((s, p) => s + p[field], 0));
  const gst = sum('gstAmount');
  return {
    ...base,
    taxableAmount: base.total,
    cgst: sum('cgstAmount'),
    sgst: sum('sgstAmount'),
    igst: sum('igstAmount'),
    gst,
    total: round2(base.total + gst),
    lines: parts.slice(0, -1),
    design: parts[parts.length - 1]
  };
}

/**
 * Taxed parts grouped by rate, for the tax summary on a document:
 * [{ rate, taxableValue, cgst, sgst, igst, gst }], lowest rate first, rates
 * with no tax left out. Parts are { gstRate, taxableValue, cgstAmount, … }.
 */
function gstByRate(parts) {
  const byRate = new Map();
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

/** An HSN code as stored on a line: trimmed and upper-cased, '' when there is none. */
const hsnOf = (value) => (value ? String(value).trim().toUpperCase() : '');

/**
 * An invoice line as stored, priced from what the client sent. Only the
 * quantity, unit, rate, dimensions and GST rate are taken; every amount is
 * recomputed, and the tax is filled in by priceInvoiceDocument. A job ticket marks area lines with itemType 'Square Feet' and its unit may
 * still say pieces, so such a line is treated as sq ft.
 */
function toInvoiceLine(item = {}) {
  const unit = item.itemType === 'Square Feet' && !isAreaUnit(item.unit) ? 'sqft' : item.unit || 'pieces';
  const p = priceLine({ quantity: item.quantity, unitPrice: item.unitPrice, unit, length: item.length, width: item.width });
  const gstRate = parseGstRate(item.gstRate) || 0;
  return {
    itemName: String(item.itemName || '').trim(),
    description: item.description ? String(item.description).trim() : '',
    hsnCode: hsnOf(item.hsnCode),
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
    // Filled in by priceInvoiceDocument once the discount has been shared out.
    taxableValue: p.amount,
    itemTotal: p.amount,
    gstRate,
    gstAmount: 0,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0
  };
}

/**
 * A quotation line as stored — the same pricing as toInvoiceLine, in the
 * quotation's field names. tax_amount is filled in by priceQuotationDocument;
 * total_amount then includes it, as on quotations written with GST before.
 */
function toQuotationLine(item = {}) {
  const unit = item.unit || 'pieces';
  const p = priceLine({ quantity: item.quantity, unitPrice: item.unit_price, unit, length: item.length, width: item.width });
  return {
    item_name: String(item.item_name || '').trim(),
    description: item.description ? String(item.description).trim() : '',
    hsn_code: hsnOf(item.hsn_code),
    quantity: p.quantity,
    unit,
    unit_price: p.unitPrice,
    length: p.length,
    width: p.width,
    area_per_piece: p.areaPerPiece,
    total_area: p.totalArea,
    tax_rate: parseGstRate(item.tax_rate) || 0,
    tax_amount: 0,
    total_amount: p.amount
  };
}

/** The invoice line a quotation line becomes on conversion, at the quoted GST rate. */
const quotationLineToInvoiceLine = (q) =>
  toInvoiceLine({ itemName: q.item_name, description: q.description, hsnCode: q.hsn_code, quantity: q.quantity, unit: q.unit, unitPrice: q.unit_price, length: q.length, width: q.width, gstRate: q.tax_rate });

const taxFields = (part) => ({
  taxableValue: part.taxableValue,
  gstAmount: part.gstAmount,
  cgstAmount: part.cgstAmount,
  sgstAmount: part.sgstAmount,
  igstAmount: part.igstAmount
});

/**
 * An invoice priced from what the client sent: the stored lines with their
 * tax, the design charge's tax, and the totals. Returns { error } when the
 * discount is more than the invoice before tax.
 *   items                    lines as the client sends them (toInvoiceLine)
 *   designCharge             a number or a job ticket's { amount, gstRate }
 *   designChargeGstRate      overrides the rate on a design charge object
 */
function priceInvoiceDocument({ items = [], designCharge, designChargeGstRate, discount, isInterState = false, noGst = false }) {
  const lines = items.map(toInvoiceLine);
  // An older "No GST" bill stays untaxed when it is edited.
  if (noGst) lines.forEach((l) => { l.gstRate = 0; });
  const design = {
    amount: parseDesignCharge(designCharge) || 0,
    gstRate: noGst ? 0 : parseDesignChargeGstRate(designCharge, designChargeGstRate) || 0
  };
  const totals = gstTotals(lines.map((l) => ({ amount: l.totalAmount, gstRate: l.gstRate })), design, discount, isInterState);
  if (totals.discount > totals.gross) {
    return { error: `Discount (${totals.discount}) cannot be more than the invoice value (${totals.gross}).` };
  }
  lines.forEach((line, i) => {
    Object.assign(line, taxFields(totals.lines[i]));
    line.itemTotal = round2(totals.lines[i].taxableValue + totals.lines[i].gstAmount);
  });
  const d = totals.design;
  return {
    lines,
    totals,
    design: {
      designCharge: totals.designCharge,
      designChargeGstRate: d.gstRate,
      designChargeTaxableValue: d.taxableValue,
      designChargeGstAmount: d.gstAmount,
      designChargeCgstAmount: d.cgstAmount,
      designChargeSgstAmount: d.sgstAmount,
      designChargeIgstAmount: d.igstAmount
    }
  };
}

/**
 * A quotation priced the same way as an invoice, so the invoice raised from
 * it comes to the same total. Returns { error } when the discount is more
 * than the quotation before tax.
 */
function priceQuotationDocument({ items = [], designCharge, designChargeGstRate, discount = 0, isInterState = false }) {
  const lines = items.map(toQuotationLine);
  const design = {
    amount: parseDesignCharge(designCharge) || 0,
    gstRate: parseDesignChargeGstRate(designCharge, designChargeGstRate) || 0
  };
  const totals = gstTotals(lines.map((l) => ({ amount: l.total_amount, gstRate: l.tax_rate })), design, discount, isInterState);
  if (totals.discount > totals.gross) {
    return { error: `Discount (${totals.discount}) cannot be more than the quotation value (${totals.gross}).` };
  }
  lines.forEach((line, i) => {
    line.tax_amount = totals.lines[i].gstAmount;
    line.total_amount = round2(totals.lines[i].amount + totals.lines[i].gstAmount);
  });
  return { lines, totals };
}

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

/** HSN codes are 4 to 8 digits (the same rule as stock items). */
const HSN_PATTERN = /^\d{4,8}$/;

module.exports = {
  AREA_UNITS,
  HSN_PATTERN,
  isAreaUnit,
  round2,
  round4,
  priceLine,
  parseDesignCharge,
  parseGstRate,
  parseDesignChargeGstRate,
  documentTotals,
  splitGst,
  splitGstAll,
  applyGst,
  gstTotals,
  gstByRate,
  toInvoiceLine,
  toQuotationLine,
  quotationLineToInvoiceLine,
  priceInvoiceDocument,
  priceQuotationDocument,
  sizeLabel,
  areaLabel,
  fmtQty
};
