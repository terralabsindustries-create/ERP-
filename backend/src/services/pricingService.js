/**
 * The one pricing implementation. Routes, quotations, invoices and the quote
 * endpoint all call this; nothing else decides a price.
 *
 * Slabs: [{ minQty, rate }]. The order quantity takes the rate of the HIGHEST
 * minQty that is <= quantity, applied to the whole line (not progressive).
 *
 * Priority (first that applies):
 *   1 authorised manual override   { rate, reason }, needs "Pricing Master: Override Price"
 *   2 customer quantity slabs      CustomerItemRate.slabs
 *   3 customer fixed rate          CustomerItemRate.fixedRate
 *   4 item quantity slabs          PriceItem.slabs
 *   5 item default rate            PriceItem.defaultRate
 *
 * Tax: a rate is either GST-exclusive (GST added on top) or GST-inclusive
 * (taxable = gross / (1 + rate), GST = gross − taxable). GST rates come from the
 * item master and are parsed with billing.parseGstRate, never hard-coded here.
 * Money is rounded to paise (2 dp) with the same round2 as billing.js; unit
 * rates are kept to 4 dp.
 */
const mongoose = require('mongoose');
const { round2, parseGstRate } = require('../utils/billing');

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
// A GST-inclusive rate divided by 1+GST is stored to 8 dp so qty × price still reproduces the gross to the paisa.
const round8 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e8) / 1e8;

class PricingError extends Error {
  constructor(message, code = 'PRICING_ERROR', status = 400, details) {
    super(message);
    this.code = code; this.status = status; this.details = details;
  }
}

/** Validates and sorts slabs. Returns { slabs, errors[] }. */
function validateSlabs(input) {
  const errors = [];
  if (input === undefined || input === null) return { slabs: [], errors };
  if (!Array.isArray(input)) return { slabs: [], errors: ['Pricing slabs must be a list'] };
  if (input.length > 50) errors.push('At most 50 pricing slabs are allowed');
  const seen = new Set();
  const slabs = [];
  input.forEach((s, i) => {
    const row = `Row ${i + 1}`;
    const minQty = Number(s?.minQty);
    const rate = Number(s?.rate);
    if (s?.minQty === '' || s?.minQty === null || s?.minQty === undefined || !Number.isFinite(minQty) || minQty <= 0) { errors.push(`${row}: quantity must be a number above 0`); return; }
    if (s?.rate === '' || s?.rate === null || s?.rate === undefined || !Number.isFinite(rate) || rate < 0) { errors.push(`${row}: rate must be a number, 0 or more`); return; }
    if (round4(minQty) !== minQty && Math.abs(round4(minQty) - minQty) > 1e-9) { errors.push(`${row}: quantity can have at most 4 decimals`); return; }
    const key = String(round4(minQty));
    if (seen.has(key)) { errors.push(`Quantity ${key} appears more than once`); return; }
    seen.add(key);
    slabs.push({ minQty: round4(minQty), rate: round4(rate) });
  });
  slabs.sort((a, b) => a.minQty - b.minQty);
  return { slabs, errors };
}

/** The slab that applies to `quantity`: the highest minQty not above it. */
function slabFor(slabs, quantity) {
  let hit = null;
  for (const s of slabs || []) if (s.minQty <= quantity && (!hit || s.minQty > hit.minQty)) hit = s;
  return hit;
}

/** Display ranges: [{ minQty, maxQty|null, rate }] (maxQty is just below the next threshold). */
function slabRanges(slabs) {
  const sorted = [...(slabs || [])].sort((a, b) => a.minQty - b.minQty);
  return sorted.map((s, i) => ({ minQty: s.minQty, maxQty: i + 1 < sorted.length ? sorted[i + 1].minQty : null, rate: s.rate }));
}

/** Tax split for a line at an entered rate. */
function lineAmounts({ quantity, rate, gstRate, taxInclusive }) {
  const g = parseGstRate(gstRate) || 0;
  const factor = 1 + g / 100;
  const gross = round2(quantity * rate);
  if (taxInclusive) {
    const taxable = round2(gross / factor);
    return { unitPriceExclTax: round8(rate / factor), taxable, gst: round2(gross - taxable), total: gross, gstRate: g };
  }
  const taxable = gross;
  const gst = round2(taxable * g / 100);
  return { unitPriceExclTax: round4(rate), taxable, gst, total: round2(taxable + gst), gstRate: g };
}

/**
 * Chooses the rate. `item` is a PriceItem (or plain object), `customerRate` an
 * optional CustomerItemRate, `override` { rate, reason } when authorised.
 */
function resolveRate({ item, customerRate, quantity, override }) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new PricingError('Quantity must be more than 0', 'INVALID_QUANTITY');
  const base = { quantity: qty, itemId: String(item._id), taxInclusive: Boolean(item.taxInclusive), gstRate: parseGstRate(item.gstRate) || 0 };
  if (override && override.rate !== undefined && override.rate !== null && override.rate !== '') {
    const rate = Number(override.rate);
    if (!Number.isFinite(rate) || rate < 0) throw new PricingError('Override rate must be 0 or more', 'INVALID_OVERRIDE');
    return { ...base, source: 'manual_override', rate: round4(rate), reason: String(override.reason || '').trim() };
  }
  const cr = customerRate && customerRate.isActive !== false ? customerRate : null;
  if (cr) {
    const hit = slabFor(cr.slabs, qty);
    if (hit) return { ...base, source: 'customer_slab', rate: hit.rate, slab: { minQty: hit.minQty } };
    if (cr.fixedRate !== null && cr.fixedRate !== undefined) return { ...base, source: 'customer_fixed', rate: round4(cr.fixedRate) };
  }
  const hit = slabFor(item.slabs, qty);
  if (hit) return { ...base, source: 'item_slab', rate: hit.rate, slab: { minQty: hit.minQty } };
  if (item.defaultRate !== null && item.defaultRate !== undefined) return { ...base, source: 'item_default', rate: round4(item.defaultRate) };
  const lowest = [...(item.slabs || [])].sort((a, b) => a.minQty - b.minQty)[0];
  throw new PricingError(
    lowest ? `${item.name} is sold from a minimum quantity of ${lowest.minQty}` : `${item.name} has no rate set`,
    'NO_RATE_FOR_QUANTITY', 422, { minimumQuantity: lowest?.minQty }
  );
}

/** Full quote: rate source + amounts + a snapshot that is stored on the document line. */
function quote(args) {
  const r = resolveRate(args);
  const amounts = lineAmounts({ quantity: r.quantity, rate: r.rate, gstRate: r.gstRate, taxInclusive: r.taxInclusive });
  const snapshot = {
    itemId: r.itemId, itemName: args.item.name, source: r.source, rate: r.rate, taxInclusive: r.taxInclusive, gstRate: r.gstRate,
    quantity: r.quantity, slab: r.slab || null, unitPriceExclTax: amounts.unitPriceExclTax, reason: r.reason || undefined, pricedAt: new Date()
  };
  return { ...r, ...amounts, snapshot };
}

const SOURCE_LABEL = {
  manual_override: 'Manual price override',
  customer_slab: 'Customer-specific quantity rate',
  customer_fixed: 'Customer-specific rate',
  item_slab: 'Quantity-based rate',
  item_default: 'Standard rate'
};

const scopeOf = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/**
 * Prices document lines that name a master item (`priceItemId`) on the server.
 * Lines without one pass through untouched (existing behaviour). A line whose
 * stored pricing snapshot still matches (same item, same quantity) keeps its
 * stored price, so editing a document never re-prices history.
 *
 *   items         lines from the client (camel or snake keys per `keys`)
 *   existing      the document's stored lines (to keep unchanged snapshots)
 *   canOverride   whether the caller holds Pricing Master: Override Price
 */
async function resolveLinePrices(items, { user, customerId, canOverride = false, existing = [], keys = 'camel' } = {}) {
  const K = keys === 'snake'
    ? { name: 'item_name', price: 'unit_price', gst: 'tax_rate', hsn: 'hsn_code', snap: 'pricing_snapshot', qty: 'quantity', unit: 'unit' }
    : { name: 'itemName', price: 'unitPrice', gst: 'gstRate', hsn: 'hsnCode', snap: 'pricingSnapshot', qty: 'quantity', unit: 'unit' };
  const PriceItem = mongoose.model('PriceItem');
  const CustomerItemRate = mongoose.model('CustomerItemRate');
  const out = [];
  const ids = [...new Set((items || []).map((i) => i && i.priceItemId).filter((id) => id && mongoose.isValidObjectId(id)).map(String))];
  const masters = new Map((ids.length ? await PriceItem.find({ _id: { $in: ids }, ...scopeOf(user) }).lean() : []).map((m) => [String(m._id), m]));
  const rates = new Map();
  if (ids.length && customerId && mongoose.isValidObjectId(customerId)) {
    for (const r of await CustomerItemRate.find({ itemId: { $in: ids }, customerId, ...scopeOf(user) }).lean()) rates.set(String(r.itemId), r);
  }
  for (const raw of items || []) {
    const item = { ...raw };
    delete item[K.snap]; // never trust a snapshot sent by the client
    if (!item.priceItemId) { out.push(item); continue; }
    if (!mongoose.isValidObjectId(item.priceItemId) || !masters.has(String(item.priceItemId))) {
      throw new PricingError('A priced item on this document was not found', 'PRICE_ITEM_NOT_FOUND', 404);
    }
    const master = masters.get(String(item.priceItemId));
    const qty = Number(item[K.qty]);
    const kept = (existing || []).find((e) => e[K.snap] && String(e[K.snap].itemId) === String(master._id) && Number(e[K.snap].quantity) === qty
      && (!item.priceOverride || (e[K.snap].source === 'manual_override' && Number(e[K.snap].rate) === Number(item.priceOverride.rate))));
    if (kept && !item.repriceNow) {
      out.push({ ...item, [K.price]: kept[K.price], [K.gst]: kept[K.gst], [K.snap]: kept[K.snap] });
      continue;
    }
    if (!master.isActive) throw new PricingError(`${master.name} is inactive`, 'PRICE_ITEM_INACTIVE', 409);
    let override = null;
    if (item.priceOverride && item.priceOverride.rate !== undefined && item.priceOverride.rate !== '') {
      if (!canOverride) throw new PricingError('You are not allowed to override prices', 'OVERRIDE_NOT_ALLOWED', 403);
      if (String(item.priceOverride.reason || '').trim().length < 3) throw new PricingError('Give a reason for the price override', 'OVERRIDE_REASON_REQUIRED', 400);
      override = item.priceOverride;
    }
    const q = quote({ item: master, customerRate: rates.get(String(master._id)), quantity: qty, override });
    out.push({
      ...item,
      [K.name]: String(item[K.name] || '').trim() || master.name,
      [K.hsn]: item[K.hsn] || master.hsnCode || '',
      [K.unit]: item[K.unit] || master.unit || 'pieces',
      [K.price]: q.unitPriceExclTax,
      [K.gst]: q.gstRate,
      [K.snap]: q.snapshot
    });
  }
  return out;
}

module.exports = { PricingError, validateSlabs, slabFor, slabRanges, resolveRate, lineAmounts, quote, resolveLinePrices, SOURCE_LABEL, round4 };
