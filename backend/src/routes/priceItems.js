const express = require('express');
const mongoose = require('mongoose');
const PriceItem = require('../models/PriceItem');
const CustomerItemRate = require('../models/CustomerItemRate');
const Customer = require('../models/Customer');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { orgScope } = require('../utils/accessScope');
const { audit } = require('../utils/audit');
const pricing = require('../services/pricingService');
const { parseGstRate } = require('../utils/billing');

const router = express.Router();
router.use(protect);

const TYPES = ['digital', 'flex', 'offset', 'general'];
const need = (perm) => (req, res, next) => (userCan(req.user, perm) ? next() : res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to do this.', required: perm }));
const bad = (res, message, errors) => res.status(400).json({ status: 'error', message, errors });
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const present = (item) => ({ ...item, ranges: pricing.slabRanges(item.slabs) });

/** Fields a client may set. Returns { fields } or { error }. */
function readItem(body, partial) {
  const f = {};
  const str = (k, max = 160) => { if (body[k] !== undefined) f[k] = body[k] === null ? undefined : String(body[k]).trim().slice(0, max); };
  ['name', 'mediaName', 'paperType', 'printSize', 'unit'].forEach((k) => str(k));
  if (body.hsnCode !== undefined) {
    const h = String(body.hsnCode || '').trim().toUpperCase();
    if (h && !/^\d{4,8}$/.test(h)) return { error: 'HSN/SAC code must be 4 to 8 digits' };
    f.hsnCode = h;
  }
  if (body.type !== undefined) { if (!TYPES.includes(body.type)) return { error: 'Choose digital, flex, offset or general' }; f.type = body.type; }
  if (body.sides !== undefined) { if (body.sides && !['simplex', 'duplex'].includes(body.sides)) return { error: 'Sides must be simplex or duplex' }; f.sides = body.sides || null; }
  if (body.gsm !== undefined && body.gsm !== null && body.gsm !== '') { const g = Number(body.gsm); if (!Number.isFinite(g) || g < 0) return { error: 'GSM must be a positive number' }; f.gsm = g; }
  if (body.gstRate !== undefined) { const g = parseGstRate(body.gstRate); if (g === null || g === undefined || Number.isNaN(g)) return { error: 'Enter a valid GST rate' }; f.gstRate = g; }
  if (body.taxInclusive !== undefined) f.taxInclusive = body.taxInclusive === true;
  if (body.isActive !== undefined) f.isActive = body.isActive === true;
  if (body.defaultRate !== undefined) {
    if (body.defaultRate === null || body.defaultRate === '') f.defaultRate = null;
    else { const r = Number(body.defaultRate); if (!Number.isFinite(r) || r < 0) return { error: 'Default rate must be 0 or more' }; f.defaultRate = pricing.round4(r); }
  }
  if (body.inventoryItemId !== undefined) {
    if (!body.inventoryItemId) f.inventoryItemId = null;
    else if (!mongoose.isValidObjectId(body.inventoryItemId)) return { error: 'Choose a valid stock item' };
    else f.inventoryItemId = body.inventoryItemId;
  }
  if (body.slabs !== undefined) {
    const { slabs, errors } = pricing.validateSlabs(body.slabs);
    if (errors.length) return { error: errors[0], errors };
    f.slabs = slabs;
  }
  if (!partial && (!f.name || !f.type)) return { error: 'Item name and type are required' };
  if (f.name !== undefined && !f.name) return { error: 'Item name is required' };
  return { fields: f };
}

// GET /api/price-items?type=&search=&status=&media=
router.get('/', need('Pricing Master'), async (req, res) => {
  try {
    const q = { ...orgScope(req.user) };
    if (TYPES.includes(req.query.type)) q.type = req.query.type;
    if (req.query.status === 'active') q.isActive = true;
    if (req.query.status === 'inactive') q.isActive = false;
    if (req.query.media) q.mediaName = new RegExp(escapeRegex(req.query.media), 'i');
    if (req.query.search) { const rx = new RegExp(escapeRegex(req.query.search), 'i'); q.$or = [{ name: rx }, { mediaName: rx }, { paperType: rx }, { printSize: rx }, { hsnCode: rx }]; }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const [items, total] = await Promise.all([PriceItem.find(q).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(), PriceItem.countDocuments(q)]);
    res.json({ status: 'success', data: { items: items.map(present), pagination: { current: page, total: Math.ceil(total / limit), totalItems: total } } });
  } catch (e) { console.error('List price items error:', e); res.status(500).json({ status: 'error', message: 'Server error while loading items' }); }
});

// POST /api/price-items/quote  { priceItemId, customerId?, quantity, priceOverride? }
// Used by every sales screen to preview the price; the document routes call the same service.
router.post('/quote', async (req, res) => {
  try {
    const { priceItemId, customerId, quantity, priceOverride } = req.body || {};
    if (!mongoose.isValidObjectId(priceItemId)) return bad(res, 'Choose an item');
    const SALES = ['Pricing Master', 'Invoicing', 'Quotations', 'Jobs', 'Walk-In Jobs'];
    if (!SALES.some((p) => userCan(req.user, p))) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to do this.' });
    const item = await PriceItem.findOne({ _id: priceItemId, ...orgScope(req.user) }).lean();
    if (!item) return res.status(404).json({ status: 'error', message: 'Item not found' });
    let customerRate = null;
    if (customerId) {
      if (!mongoose.isValidObjectId(customerId)) return bad(res, 'Choose a valid customer');
      if (!(await Customer.exists({ _id: customerId, ...orgScope(req.user) }))) return res.status(404).json({ status: 'error', message: 'Customer not found' });
      customerRate = await CustomerItemRate.findOne({ itemId: item._id, customerId, ...orgScope(req.user) }).lean();
    }
    let override = null;
    if (priceOverride && priceOverride.rate !== undefined && priceOverride.rate !== '') {
      if (!userCan(req.user, 'Pricing Master: Override Price')) return res.status(403).json({ status: 'error', code: 'OVERRIDE_NOT_ALLOWED', message: 'You are not allowed to override prices.' });
      override = priceOverride;
    }
    const q = pricing.quote({ item, customerRate, quantity: Number(quantity), override });
    res.json({ status: 'success', data: { ...q, sourceLabel: pricing.SOURCE_LABEL[q.source], ranges: pricing.slabRanges(q.source === 'customer_slab' ? customerRate.slabs : item.slabs), itemName: item.name, hsnCode: item.hsnCode, unit: item.unit } });
  } catch (e) {
    if (e instanceof pricing.PricingError) return res.status(e.status).json({ status: 'error', code: e.code, message: e.message, details: e.details });
    console.error('Quote error:', e); res.status(500).json({ status: 'error', message: 'Server error while pricing' });
  }
});

router.get('/:id', need('Pricing Master'), async (req, res) => {
  const item = mongoose.isValidObjectId(req.params.id) ? await PriceItem.findOne({ _id: req.params.id, ...orgScope(req.user) }).lean() : null;
  if (!item) return res.status(404).json({ status: 'error', message: 'Item not found' });
  res.json({ status: 'success', data: { item: present(item) } });
});

async function stockLinkOk(req, id) {
  if (!id) return true;
  return Boolean(await mongoose.model('Inventory').exists({ _id: id, ...orgScope(req.user) }));
}

router.post('/', need('Pricing Master: Create & Edit'), async (req, res) => {
  try {
    const { fields, error, errors } = readItem(req.body || {}, false);
    if (error) return bad(res, error, errors);
    if (!(await stockLinkOk(req, fields.inventoryItemId))) return res.status(404).json({ status: 'error', message: 'Stock item not found' });
    const dup = await PriceItem.exists({ ...orgScope(req.user), type: fields.type, name: new RegExp(`^${escapeRegex(fields.name)}$`, 'i'), mediaName: fields.mediaName || { $in: [null, ''] }, printSize: fields.printSize || { $in: [null, ''] }, sides: fields.sides || { $in: [null] } });
    if (dup) return res.status(409).json({ status: 'error', message: 'An item with this name, media, size and sides already exists' });
    const item = await PriceItem.create({ ...fields, userId: req.user._id, createdBy: req.user._id, dataScope: req.user.dataScope });
    await audit(req, { action: 'Price Item Created', entityType: 'inventory', entityId: item._id, entityName: item.name, actionType: 'create', after: { type: item.type, slabs: item.slabs, defaultRate: item.defaultRate, taxInclusive: item.taxInclusive, gstRate: item.gstRate } });
    res.status(201).json({ status: 'success', data: { item: present(item.toObject()) } });
  } catch (e) { console.error('Create price item error:', e); res.status(500).json({ status: 'error', message: 'Server error while saving the item' }); }
});

router.put('/:id', need('Pricing Master: Create & Edit'), async (req, res) => {
  try {
    const item = mongoose.isValidObjectId(req.params.id) ? await PriceItem.findOne({ _id: req.params.id, ...orgScope(req.user) }) : null;
    if (!item) return res.status(404).json({ status: 'error', message: 'Item not found' });
    const { fields, error, errors } = readItem(req.body || {}, true);
    if (error) return bad(res, error, errors);
    if (fields.inventoryItemId && !(await stockLinkOk(req, fields.inventoryItemId))) return res.status(404).json({ status: 'error', message: 'Stock item not found' });
    const before = { slabs: item.slabs.map((s) => ({ minQty: s.minQty, rate: s.rate })), defaultRate: item.defaultRate, taxInclusive: item.taxInclusive, gstRate: item.gstRate, isActive: item.isActive };
    Object.assign(item, fields, { updatedBy: req.user._id });
    await item.save();
    await audit(req, { action: 'Price Item Updated', entityType: 'inventory', entityId: item._id, entityName: item.name, actionType: 'update', before, after: { slabs: item.slabs.map((s) => ({ minQty: s.minQty, rate: s.rate })), defaultRate: item.defaultRate, taxInclusive: item.taxInclusive, gstRate: item.gstRate, isActive: item.isActive } });
    res.json({ status: 'success', data: { item: present(item.toObject()) } });
  } catch (e) { console.error('Update price item error:', e); res.status(500).json({ status: 'error', message: 'Server error while saving the item' }); }
});

// Items are deactivated, not deleted: documents keep their pricing snapshots either way.
router.delete('/:id', need('Pricing Master: Delete'), async (req, res) => {
  const item = mongoose.isValidObjectId(req.params.id) ? await PriceItem.findOne({ _id: req.params.id, ...orgScope(req.user) }) : null;
  if (!item) return res.status(404).json({ status: 'error', message: 'Item not found' });
  item.isActive = false; item.updatedBy = req.user._id; await item.save();
  await audit(req, { action: 'Price Item Deactivated', entityType: 'inventory', entityId: item._id, entityName: item.name, actionType: 'update', before: { isActive: true }, after: { isActive: false } });
  res.json({ status: 'success', message: 'Item deactivated' });
});

// ---- customer-specific rates -------------------------------------------------
const rateScope = (req) => orgScope(req.user);

router.get('/:id/customer-rates', need('Pricing Master'), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Item not found' });
  const rows = await CustomerItemRate.find({ itemId: req.params.id, ...rateScope(req) }).populate('customerId', 'name company').sort({ updatedAt: -1 }).limit(500).lean();
  res.json({ status: 'success', data: { rates: rows.map((r) => ({ ...r, ranges: pricing.slabRanges(r.slabs) })) } });
});

router.put('/:id/customer-rates/:customerId', need('Pricing Master: Customer Rates'), async (req, res) => {
  try {
    const { id, customerId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(customerId)) return res.status(404).json({ status: 'error', message: 'Not found' });
    const [item, customer] = await Promise.all([PriceItem.exists({ _id: id, ...rateScope(req) }), Customer.exists({ _id: customerId, ...rateScope(req) })]);
    if (!item || !customer) return res.status(404).json({ status: 'error', message: 'Item or customer not found' });
    const { slabs, errors } = pricing.validateSlabs(req.body.slabs || []);
    if (errors.length) return bad(res, errors[0], errors);
    let fixedRate = null;
    if (req.body.fixedRate !== undefined && req.body.fixedRate !== null && req.body.fixedRate !== '') {
      fixedRate = Number(req.body.fixedRate);
      if (!Number.isFinite(fixedRate) || fixedRate < 0) return bad(res, 'Fixed rate must be 0 or more');
      fixedRate = pricing.round4(fixedRate);
    }
    if (fixedRate === null && !slabs.length) return bad(res, 'Give a fixed rate or at least one quantity rate');
    const existing = await CustomerItemRate.findOne({ itemId: id, customerId, ...rateScope(req) });
    const before = existing ? { fixedRate: existing.fixedRate, slabs: existing.slabs.map((s) => ({ minQty: s.minQty, rate: s.rate })), isActive: existing.isActive } : null;
    const after = { fixedRate, slabs, isActive: req.body.isActive !== false };
    const entry = { at: new Date(), by: req.user._id, byName: req.user.fullName, action: existing ? 'updated' : 'created', before, after, reason: String(req.body.reason || '').slice(0, 300) };
    let doc = existing;
    if (doc) { Object.assign(doc, after); doc.history = [...(doc.history || []).slice(-49), entry]; await doc.save(); }
    else doc = await CustomerItemRate.create({ itemId: id, customerId, ...after, history: [entry], userId: req.user._id, dataScope: req.user.dataScope });
    await audit(req, { action: 'Customer Rate Saved', entityType: 'inventory', entityId: id, entityName: String(customerId), actionType: existing ? 'update' : 'create', before, after, reason: entry.reason, relatedCustomer: customerId });
    res.json({ status: 'success', data: { rate: { ...doc.toObject(), ranges: pricing.slabRanges(doc.slabs) } } });
  } catch (e) { console.error('Save customer rate error:', e); res.status(500).json({ status: 'error', message: 'Server error while saving the customer rate' }); }
});

router.delete('/:id/customer-rates/:customerId', need('Pricing Master: Customer Rates'), async (req, res) => {
  const { id, customerId } = req.params;
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(customerId)) return res.status(404).json({ status: 'error', message: 'Not found' });
  const doc = await CustomerItemRate.findOneAndDelete({ itemId: id, customerId, ...rateScope(req) });
  if (!doc) return res.status(404).json({ status: 'error', message: 'Customer rate not found' });
  await audit(req, { action: 'Customer Rate Removed', entityType: 'inventory', entityId: id, entityName: String(customerId), actionType: 'delete', before: { fixedRate: doc.fixedRate, slabs: doc.slabs }, relatedCustomer: customerId, reason: req.body?.reason });
  res.json({ status: 'success', message: 'Customer rate removed' });
});

module.exports = router;
