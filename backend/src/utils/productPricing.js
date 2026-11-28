/**
 * Product rate engine: the one place where a sales order line gets its price.
 * Pure functions (no database), so the server can price an order at save time
 * and the preview endpoint can show the same numbers. The browser never
 * decides an amount; it asks for one.
 *
 * Rate resolution (most specific rule wins, deterministic):
 *   customer-specific > party-type > sales-type > default
 * A rule may carry several of the three keys; every key it carries must match
 * the order. Score = customer 100 + party 20 + sales 10, highest wins. No two
 * rules of one product may share the same (customer, party, sales) triple, so
 * a tie is impossible.
 *
 * Slabs: the slab used is the last one whose `from` is not above the billable
 * quantity/area (so a gap between two slabs resolves downwards, never to zero).
 * A quantity above the last closed slab has no price and is reported, not
 * silently billed at some other rate.
 *
 * GST: a slab is entered GST-exclusive or GST-inclusive; both are kept. Amounts
 * are always worked out from the side that was entered, so GST is never added
 * twice and a ₹12 inclusive rate at 18% bills 12.00 per unit exactly.
 *
 * Minimums (explicit rule fields, applied in this order and reported in
 * `adjustments`): minimumQuantity (bill at least this much), minimumAmount
 * (taxable amount of a line is at least this). The slab `isMinimum` flag of the
 * reference software is stored and shown but NOT used in any calculation until
 * the business confirms what it means.
 */
const { AREA_UNITS, splitGstAll } = require('./billing');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const UNITS = ['pieces', 'copies', 'sheets', 'sets', 'sqft', 'sqm', 'kg', 'meters'];
const isAreaUnit = (u) => Object.prototype.hasOwnProperty.call(AREA_UNITS, u);

// ---- GST inclusive / exclusive -------------------------------------------

const inclusiveFromExclusive = (excl, gst) => round2(num(excl) * (1 + num(gst) / 100));
const exclusiveFromInclusive = (incl, gst) => round2(num(incl) / (1 + num(gst) / 100));

/**
 * Fills the missing side of a slab from the entered one and checks that two
 * entered sides agree (to a paisa after rounding). Returns { slab, error }.
 */
function completeSlab(slab, gstRate) {
  const hasEx = slab.exclusiveRate !== undefined && slab.exclusiveRate !== null && slab.exclusiveRate !== '';
  const hasIn = slab.inclusiveRate !== undefined && slab.inclusiveRate !== null && slab.inclusiveRate !== '';
  if (!hasEx && !hasIn) return { error: 'Enter an exclusive or an inclusive rate' };
  const ex = hasEx ? Number(slab.exclusiveRate) : null;
  const inc = hasIn ? Number(slab.inclusiveRate) : null;
  if ((hasEx && !Number.isFinite(ex)) || (hasIn && !Number.isFinite(inc))) return { error: 'Rates must be numbers' };
  if ((hasEx && ex < 0) || (hasIn && inc < 0)) return { error: 'A rate cannot be negative' };
  if (hasEx && hasIn) {
    if (Math.abs(inclusiveFromExclusive(ex, gstRate) - inc) > 0.0100001 && Math.abs(exclusiveFromInclusive(inc, gstRate) - ex) > 0.0100001) {
      return { error: `Exclusive ₹${ex} and inclusive ₹${inc} do not match at ${gstRate}% GST` };
    }
    return { slab: { ...slab, exclusiveRate: ex, inclusiveRate: inc, rateBasis: slab.rateBasis === 'inclusive' ? 'inclusive' : 'exclusive' } };
  }
  if (hasEx) return { slab: { ...slab, exclusiveRate: ex, inclusiveRate: inclusiveFromExclusive(ex, gstRate), rateBasis: 'exclusive' } };
  return { slab: { ...slab, exclusiveRate: exclusiveFromInclusive(inc, gstRate), inclusiveRate: inc, rateBasis: 'inclusive' } };
}

// ---- validation ----------------------------------------------------------

/** Normalises and validates one rule's slabs. Returns { slabs, errors }. */
function validateSlabs(rawSlabs, { gstRate, unit }) {
  const errors = [];
  if (!Array.isArray(rawSlabs) || !rawSlabs.length) return { slabs: [], errors: ['Add at least one pricing slab'] };
  const slabs = [];
  rawSlabs.forEach((raw, i) => {
    const label = `Slab ${i + 1}`;
    const from = Number(raw.from);
    const hasTo = raw.to !== undefined && raw.to !== null && raw.to !== '';
    const to = hasTo ? Number(raw.to) : null;
    if (!Number.isFinite(from) || from < 0) errors.push(`${label}: "from" must be 0 or more`);
    if (hasTo && (!Number.isFinite(to) || to < from)) errors.push(`${label}: "to" must be at least "from" (leave it empty for no upper limit)`);
    if (raw.unit && unit && raw.unit !== unit) errors.push(`${label}: unit ${raw.unit} differs from the product unit ${unit}`);
    const done = completeSlab(raw, gstRate);
    if (done.error) errors.push(`${label}: ${done.error}`);
    if (!done.error && Number.isFinite(from)) {
      slabs.push({ from: round4(from), to: hasTo ? round4(to) : null, exclusiveRate: done.slab.exclusiveRate, inclusiveRate: done.slab.inclusiveRate, rateBasis: done.slab.rateBasis, isMinimum: !!raw.isMinimum, unit: unit || raw.unit });
    }
  });
  if (errors.length) return { slabs, errors };
  slabs.sort((a, b) => a.from - b.from);
  for (let i = 0; i < slabs.length; i += 1) {
    if (slabs[i].to === null && i !== slabs.length - 1) errors.push('Only the last slab can have no upper limit');
    if (i > 0) {
      if (slabs[i].from === slabs[i - 1].from) errors.push(`Two slabs start at ${slabs[i].from}`);
      else if (slabs[i - 1].to !== null && slabs[i].from <= slabs[i - 1].to) errors.push(`Slabs overlap: ${slabs[i - 1].from}–${slabs[i - 1].to} and ${slabs[i].from}–${slabs[i].to === null ? 'no limit' : slabs[i].to}`);
    }
  }
  return { slabs, errors };
}

const ruleKey = (r) => `${r.customerId ? String(r.customerId) : ''}|${r.partyType || ''}|${r.salesType || ''}`;

/** Validates a product's whole rule set (duplicates, slabs, minimums). Returns { rules, errors }. */
function validateRules(rawRules, { gstRate, unit }) {
  const errors = [];
  const rules = [];
  const seen = new Map();
  (rawRules || []).forEach((raw, i) => {
    const label = `Rule ${i + 1}`;
    const key = ruleKey(raw);
    if (seen.has(key)) errors.push(`${label}: duplicates rule ${seen.get(key) + 1} (same customer, party type and sales type)`);
    else seen.set(key, i);
    const { slabs, errors: slabErrors } = validateSlabs(raw.slabs, { gstRate, unit });
    slabErrors.forEach((e) => errors.push(`${label}: ${e}`));
    ['minimumQuantity', 'minimumAmount'].forEach((f) => {
      if (raw[f] !== undefined && raw[f] !== null && raw[f] !== '' && !(Number(raw[f]) >= 0)) errors.push(`${label}: ${f} must be 0 or more`);
    });
    rules.push({
      customerId: raw.customerId || undefined,
      partyType: raw.partyType || undefined,
      salesType: raw.salesType ? String(raw.salesType).trim() : undefined,
      slabs,
      minimumQuantity: num(raw.minimumQuantity) || undefined,
      minimumAmount: num(raw.minimumAmount) || undefined
    });
  });
  return { rules, errors };
}

// ---- resolution ----------------------------------------------------------

const ruleScore = (r) => (r.customerId ? 100 : 0) + (r.partyType ? 20 : 0) + (r.salesType ? 10 : 0);

/** The most specific rule whose keys all match the order context, or null. */
function resolveRule(rules, { customerId, partyType, salesType } = {}) {
  let best = null;
  for (const r of rules || []) {
    if (r.customerId && String(r.customerId) !== String(customerId || '')) continue;
    if (r.partyType && r.partyType !== partyType) continue;
    if (r.salesType && String(r.salesType).toLowerCase() !== String(salesType || '').toLowerCase()) continue;
    if (!best || ruleScore(r) > ruleScore(best)) best = r;
  }
  return best;
}

/** The slab for a quantity/area, or null when it is beyond the last closed slab. */
function pickSlab(slabs, qty) {
  const sorted = [...(slabs || [])].sort((a, b) => a.from - b.from);
  let chosen = null;
  for (const s of sorted) if (s.from <= qty) chosen = s;
  if (!chosen) chosen = sorted[0] || null; // below the first slab: the first slab's rate (quantity under its start)
  if (!chosen) return null;
  if (chosen.to !== null && qty > chosen.to && chosen === sorted[sorted.length - 1]) return null;
  return chosen;
}

// ---- line pricing --------------------------------------------------------

const TO_FEET = { ft: 1, in: 1 / 12, m: 3.28084, cm: 0.0328084 };
const TO_METERS = { m: 1, cm: 0.01, ft: 0.3048, in: 0.0254 };

function areaOf({ unit, length, width, dimUnit, copies }) {
  const l = num(length);
  const w = num(width);
  if (!isAreaUnit(unit) || !(l > 0 && w > 0)) return null;
  const table = unit === 'sqft' ? TO_FEET : TO_METERS;
  const f = table[dimUnit] || 1;
  const perPiece = round4(l * f * w * f);
  return { perPiece, total: round4(perPiece * num(copies)) };
}

/**
 * Prices one order line against a product (a plain object with gstRate,
 * taxExempt, cessRate, unit, rules) and the order context.
 *
 * Returns the amounts, the pricing snapshot to store, any warnings and the
 * adjustments (minimums) that were applied, so nothing changes silently.
 */
function priceLine({ product, ctx = {}, line = {}, isInterState = false }) {
  const warnings = [];
  const adjustments = [];
  const copies = num(line.copies);
  const unit = line.unit || product?.unit || 'pieces';
  const result = {
    priced: false, quantity: copies, unit, basis: 0, billableBasis: 0, area: null,
    rate: 0, rateBasis: 'exclusive', exclusiveRate: 0, inclusiveRate: 0, gstRate: 0, cessRate: 0,
    grossTaxable: 0, discount: 0, taxable: 0, gst: 0, cess: 0, total: 0, effectiveRate: 0,
    warnings, adjustments, snapshot: null
  };
  if (!product) { warnings.push({ code: 'NO_PRODUCT', message: 'Choose a product' }); return result; }
  if (!(copies > 0)) { warnings.push({ code: 'NO_QUANTITY', message: 'Enter the number of copies' }); return result; }

  const area = areaOf({ unit, length: line.length, width: line.width, dimUnit: line.dimUnit, copies });
  if (isAreaUnit(unit) && !area) warnings.push({ code: 'NO_DIMENSIONS', message: 'Enter length and width for area pricing; billing by copies until then' });
  const basis = area ? area.total : copies;
  result.area = area;
  result.basis = basis;

  const rule = resolveRule(product.rules, ctx);
  if (!rule) {
    warnings.push({ code: 'NO_RATE', message: `No rate is configured for ${product.productName} for this customer / party type / sales type, and there is no default rate` });
    return result;
  }

  let billable = basis;
  if (rule.minimumQuantity && billable < rule.minimumQuantity) {
    adjustments.push({ type: 'minimum_quantity', message: `Billed at the minimum quantity ${rule.minimumQuantity} (ordered ${basis})`, from: basis, to: rule.minimumQuantity });
    billable = rule.minimumQuantity;
  }
  result.billableBasis = billable;

  const slab = pickSlab(rule.slabs, billable);
  if (!slab) {
    warnings.push({ code: 'OUT_OF_RANGE', message: `${billable} is above the highest configured slab for ${product.productName}; add an open-ended slab` });
    return result;
  }

  const gstRate = product.taxExempt ? 0 : num(product.gstRate);
  const cessRate = product.taxExempt ? 0 : num(product.cessRate);
  result.gstRate = gstRate;
  result.cessRate = cessRate;
  result.rateBasis = slab.rateBasis;
  result.exclusiveRate = slab.exclusiveRate;
  result.inclusiveRate = slab.inclusiveRate;

  // A permitted manual rate replaces the slab rate (same basis as the slab).
  let enteredRate = slab.rateBasis === 'inclusive' ? slab.inclusiveRate : slab.exclusiveRate;
  let overridden = null;
  if (line.rateOverride && line.rateOverride.rate !== undefined && line.rateOverride.rate !== null && line.rateOverride.rate !== '') {
    const o = Number(line.rateOverride.rate);
    if (!Number.isFinite(o) || o < 0) { warnings.push({ code: 'BAD_OVERRIDE', message: 'The overridden rate must be 0 or more' }); return result; }
    overridden = { original: enteredRate, rate: o, basis: slab.rateBasis, reason: String(line.rateOverride.reason || '').trim() };
    enteredRate = o;
  }
  result.rate = enteredRate;

  const inclusive = slab.rateBasis === 'inclusive';
  let grossTaxable;
  let inclusiveExactTotal = null;
  if (inclusive) {
    inclusiveExactTotal = round2(billable * enteredRate);
    grossTaxable = round2(inclusiveExactTotal / (1 + gstRate / 100 + cessRate / 100));
  } else {
    grossTaxable = round2(billable * enteredRate);
  }
  if (rule.minimumAmount && grossTaxable < rule.minimumAmount) {
    adjustments.push({ type: 'minimum_amount', message: `Billed at the minimum amount ₹${rule.minimumAmount} (calculated ₹${grossTaxable})`, from: grossTaxable, to: rule.minimumAmount });
    grossTaxable = round2(rule.minimumAmount);
    inclusiveExactTotal = null;
  }

  // Discount comes off before tax.
  let discount = 0;
  const dType = line.discountType === 'amount' ? 'amount' : 'percent';
  const dValue = num(line.discountValue);
  if (dValue < 0 || (dType === 'percent' && dValue > 100)) {
    warnings.push({ code: 'BAD_DISCOUNT', message: 'A discount must be between 0 and 100%, or a positive amount' });
    return result;
  }
  if (dValue > 0) {
    discount = dType === 'percent' ? round2((grossTaxable * dValue) / 100) : Math.min(round2(dValue), grossTaxable);
    inclusiveExactTotal = null;
  }
  const taxable = round2(grossTaxable - discount);
  const cess = round2((taxable * cessRate) / 100);
  let gst = round2((taxable * gstRate) / 100);
  if (inclusiveExactTotal !== null) gst = round2(inclusiveExactTotal - taxable - cess); // exact: the entered inclusive total, GST never added twice

  result.priced = true;
  result.grossTaxable = grossTaxable;
  result.discount = discount;
  result.taxable = taxable;
  result.gst = gst;
  result.cess = cess;
  result.total = round2(taxable + gst + cess);
  result.effectiveRate = billable > 0 ? round4(taxable / billable) : 0;
  result.snapshot = {
    productId: product._id || product.id,
    productName: product.productName,
    productCode: product.productCode,
    materialType: product.materialType,
    rule: { customerId: rule.customerId || null, partyType: rule.partyType || null, salesType: rule.salesType || null, score: ruleScore(rule) },
    slab: { from: slab.from, to: slab.to, exclusiveRate: slab.exclusiveRate, inclusiveRate: slab.inclusiveRate, rateBasis: slab.rateBasis, isMinimum: !!slab.isMinimum },
    minimums: { quantity: rule.minimumQuantity || null, amount: rule.minimumAmount || null },
    gstRate, cessRate, taxExempt: !!product.taxExempt,
    basis, billableBasis: billable, unit,
    rateUsed: enteredRate, rateBasis: slab.rateBasis,
    override: overridden,
    adjustments,
    calculatedAt: new Date().toISOString()
  };
  void isInterState;
  return result;
}

// ---- order totals --------------------------------------------------------

/**
 * Totals for priced lines plus other charges. Each charge is
 * { name, amount, gstRate, taxable }: a charge with taxable === false goes to
 * the non-taxable amount. GST is split into CGST + SGST or IGST by
 * `isInterState` (billing.splitGstAll keeps the halves consistent).
 */
function priceOrder({ lines, otherCharges = [], isInterState = false, advance = 0 }) {
  const warnings = [];
  const taxParts = [];
  let nonTaxable = 0;
  let discount = 0;
  let cess = 0;
  let linesTaxable = 0;
  lines.forEach((l) => {
    if (l.priced) {
      taxParts.push({ taxable: l.taxable, gst: l.gst });
      linesTaxable += l.taxable;
      discount += l.discount;
      cess += l.cess;
    }
  });
  const charges = (otherCharges || []).map((c, i) => {
    const amount = round2(num(c.amount));
    const gstRate = num(c.gstRate);
    if (amount < 0) warnings.push({ code: 'BAD_CHARGE', message: `Charge ${i + 1} cannot be negative` });
    if (c.taxable === false) {
      nonTaxable += amount;
      return { name: c.name, amount, gstRate: 0, taxable: false, gst: 0 };
    }
    const gst = round2((amount * gstRate) / 100);
    taxParts.push({ taxable: amount, gst });
    linesTaxable += amount;
    return { name: c.name, amount, gstRate, taxable: true, gst };
  });
  const taxableAmount = round2(linesTaxable);
  const splits = splitGstAll(taxParts.map((p) => p.gst), isInterState);
  const cgst = round2(splits.reduce((s, x) => s + x.cgstAmount, 0));
  const sgst = round2(splits.reduce((s, x) => s + x.sgstAmount, 0));
  const igst = round2(splits.reduce((s, x) => s + x.igstAmount, 0));
  const raw = round2(taxableAmount + cgst + sgst + igst + round2(cess) + round2(nonTaxable));
  const total = Math.round(raw);
  const roundOff = round2(total - raw);
  const adv = round2(Math.max(0, num(advance)));
  return {
    taxableAmount, cgst, sgst, igst, cess: round2(cess), nonTaxableAmount: round2(nonTaxable),
    discount: round2(discount), subtotalBeforeRoundOff: raw, roundOff, total,
    amountDue: total, advance: adv, excess: round2(Math.max(0, adv - total)), balance: round2(Math.max(0, total - adv)),
    isInterState: !!isInterState, charges, warnings
  };
}

module.exports = {
  UNITS, round2, round4,
  inclusiveFromExclusive, exclusiveFromInclusive, completeSlab,
  validateSlabs, validateRules, ruleKey, ruleScore,
  resolveRule, pickSlab, areaOf, priceLine, priceOrder
};
