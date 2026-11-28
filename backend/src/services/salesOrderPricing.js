const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const ProductRate = require('../models/ProductRate');
const { businessSettings } = require('../utils/businessSettings');
const { orgScope } = require('../utils/accessScope');
const { userCan } = require('../middleware/requirePermission');
const { stateCodeOf, stateName } = require('../utils/gstStates');
const pricing = require('../utils/productPricing');

class PricingError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/*
  Short-lived cache of product rate documents, so typing a quantity does not
  re-read the master on every keystroke. Writes to the master clear the
  business's entries at once (invalidateProductCache); saving an order always
  reads fresh (fresh: true), so a stale cache can only affect a preview, and
  only for a few seconds on another server process.
*/
const CACHE_MS = 15 * 1000;
const cache = new Map(); // `${scopeKey}:${productId}` -> { at, doc }
const scopeKey = (user) => user.dataScope || String(user._id);
function invalidateProductCache(user) {
  const prefix = `${scopeKey(user)}:`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

async function loadProducts(user, ids, { fresh = false } = {}) {
  const wanted = [...new Set(ids.map(String))];
  const found = new Map();
  const missing = [];
  for (const id of wanted) {
    const hit = !fresh && cache.get(`${scopeKey(user)}:${id}`);
    if (hit && Date.now() - hit.at < CACHE_MS) found.set(id, hit.doc);
    else missing.push(id);
  }
  if (missing.length) {
    const docs = await ProductRate.find({ _id: { $in: missing.filter((i) => mongoose.isValidObjectId(i)) }, ...orgScope(user) }).lean();
    for (const d of docs) {
      found.set(String(d._id), d);
      cache.set(`${scopeKey(user)}:${d._id}`, { at: Date.now(), doc: d });
    }
  }
  return found;
}

/** The business's state code, from its GSTIN, or the state in its address. */
async function companyStateCode(user) {
  const s = await businessSettings(user);
  return stateCodeOf(s.gstNumber) || stateCodeOf(s.companyAddress?.state);
}

/**
 * Prices a whole order on the server: resolves the customer (party type, state,
 * GSTIN), every product's rule and slab, applies discounts / overrides the
 * user is allowed to give, and totals the order. Used by the preview endpoint
 * and by saving an order (with fresh:true), so the two cannot disagree.
 *
 * body: { customerId?, partyType?, salesType, lines[], otherCharges[], isInterState?, advance? }
 * Throws PricingError for things the caller must fix (not for "no rate", which
 * comes back as a line warning so the form can show it).
 */
async function priceOrderRequest(user, body, { fresh = false } = {}) {
  let customer = null;
  if (body.customerId) {
    if (!mongoose.isValidObjectId(body.customerId)) throw new PricingError(400, 'Choose a valid customer', 'BAD_CUSTOMER');
    customer = await Customer.findOne({ _id: body.customerId, ...orgScope(user) }).lean();
    if (!customer) throw new PricingError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  }
  const partyType = customer?.customerType || body.partyType || undefined;
  const salesType = body.salesType ? String(body.salesType).trim() : undefined;
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (lines.length > 100) throw new PricingError(400, 'An order can have at most 100 lines', 'TOO_MANY_LINES');

  const products = await loadProducts(user, lines.map((l) => l.productId).filter(Boolean), { fresh });
  const canDiscount = userCan(user, 'Sales Orders: Apply Discount');
  const canOverride = userCan(user, 'Sales Orders: Override Rate');

  const priced = lines.map((raw, i) => {
    const product = raw.productId ? products.get(String(raw.productId)) : null;
    if (raw.productId && (!product || product.isActive === false)) {
      throw new PricingError(400, `Line ${i + 1}: the product is not available`, 'PRODUCT_NOT_FOUND');
    }
    if (Number(raw.discountValue) > 0 && !canDiscount) {
      throw new PricingError(403, `Line ${i + 1}: you are not allowed to give a discount`, 'DISCOUNT_NOT_ALLOWED');
    }
    const hasOverride = raw.rateOverride && raw.rateOverride.rate !== undefined && raw.rateOverride.rate !== null && raw.rateOverride.rate !== '';
    if (hasOverride) {
      if (!canOverride) throw new PricingError(403, `Line ${i + 1}: you are not allowed to change the rate`, 'OVERRIDE_NOT_ALLOWED');
      if (!String(raw.rateOverride.reason || '').trim()) throw new PricingError(400, `Line ${i + 1}: give a reason for changing the rate`, 'OVERRIDE_REASON_REQUIRED');
    }
    const result = pricing.priceLine({ product, ctx: { customerId: customer?._id, partyType, salesType }, line: raw });
    if (result.snapshot && result.snapshot.override) {
      result.snapshot.override = { ...result.snapshot.override, by: user._id, byName: user.fullName };
    }
    return { raw, product, result };
  });

  // Inter-state: the customer's GSTIN/state against the business's. Unknown
  // on either side means the caller's explicit choice, else intra-state.
  const customerState = stateCodeOf(body.customerState) || stateCodeOf(customer?.gstNumber) || stateCodeOf(customer?.state);
  const ours = await companyStateCode(user);
  const isInterState = customerState && ours ? customerState !== ours : body.isInterState === true;

  const totals = pricing.priceOrder({
    lines: priced.map((p) => p.result),
    otherCharges: body.otherCharges,
    isInterState,
    advance: body.advance
  });
  return { customer, partyType, salesType, customerState, customerStateName: stateName(customerState), isInterState, lines: priced, totals };
}

module.exports = { priceOrderRequest, invalidateProductCache, loadProducts, PricingError };
