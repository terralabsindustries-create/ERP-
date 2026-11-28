const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const ProductRate = require('../models/ProductRate');
const Customer = require('../models/Customer');
const { validate } = require('../middleware/validate');
const { orgScope } = require('../utils/accessScope');
const { validateRules, UNITS } = require('../utils/productPricing');
const { priceOrderRequest, invalidateProductCache, PricingError } = require('../services/salesOrderPricing');
const { audit } = require('../utils/audit');

const router = express.Router();
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const productRules = [
  body('materialType').trim().notEmpty().withMessage('Material type is required'),
  body('productName').trim().notEmpty().withMessage('Product name is required'),
  body('unit').optional().isIn(UNITS).withMessage('Choose a valid unit'),
  body('gstRate').optional().isFloat({ min: 0, max: 100 }).withMessage('GST must be 0 to 100%'),
  body('cessRate').optional().isFloat({ min: 0, max: 100 }).withMessage('Cess must be 0 to 100%'),
  body('rules').optional().isArray({ max: 200 }).withMessage('Rules must be a list')
];

/** Validates the rule set and that every customer named belongs to this business. */
async function normaliseProduct(req) {
  const gstRate = req.body.taxExempt ? 0 : Number(req.body.gstRate ?? 18);
  const unit = req.body.unit || 'pieces';
  const { rules, errors } = validateRules(req.body.rules || [], { gstRate, unit });
  const ids = rules.map((r) => r.customerId).filter(Boolean).map(String);
  if (ids.some((id) => !mongoose.isValidObjectId(id))) errors.push('A rule names an invalid customer');
  else if (ids.length) {
    const ok = await Customer.countDocuments({ _id: { $in: ids }, ...orgScope(req.user) });
    if (ok !== new Set(ids).size) errors.push('A rule names a customer that is not in this business');
  }
  return { rules, errors, gstRate, unit };
}

const fieldsOf = (b, gstRate, unit) => ({
  materialType: b.materialType, productName: b.productName,
  productCode: b.productCode ? String(b.productCode).trim().toUpperCase() : undefined,
  unit, hsnCode: b.hsnCode || undefined,
  gstRate, taxExempt: !!b.taxExempt, cessRate: b.taxExempt ? 0 : Number(b.cessRate || 0),
  isActive: b.isActive !== false
});

// GET /api/product-rates?search=&materialType=&active=&page=&limit=
// Server-side search and pagination; the rules are only sent with one product.
router.get('/', [
  query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const filter = { ...orgScope(req.user) };
    if (req.query.materialType && req.query.materialType !== 'all') filter.materialType = req.query.materialType;
    if (req.query.active === 'true') filter.isActive = true;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [{ productName: rx }, { productCode: rx }];
    }
    const [products, total] = await Promise.all([
      ProductRate.find(filter).select('-rules').sort({ materialType: 1, productName: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProductRate.countDocuments(filter)
    ]);
    res.json({ status: 'success', data: { products, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
  } catch (error) {
    console.error('List product rates error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading products' });
  }
});

// GET /api/product-rates/material-types — for the filter
router.get('/material-types', async (req, res) => {
  try {
    res.json({ status: 'success', data: { materialTypes: (await ProductRate.distinct('materialType', orgScope(req.user))).sort() } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error while loading material types' });
  }
});

// POST /api/product-rates/price — the server's price for an order as typed so
// far (same code as saving). Lines without a rate come back as warnings.
router.post('/price', async (req, res) => {
  try {
    const out = await priceOrderRequest(req.user, req.body);
    res.json({
      status: 'success',
      data: {
        partyType: out.partyType, salesType: out.salesType, isInterState: out.isInterState, customerState: out.customerStateName,
        lines: out.lines.map((l) => ({ ...l.result, snapshot: undefined, snapshotSummary: l.result.snapshot && { rule: l.result.snapshot.rule, slab: l.result.snapshot.slab } })),
        totals: out.totals
      }
    });
  } catch (error) {
    if (error instanceof PricingError) return res.status(error.status).json({ status: 'error', code: error.code, message: error.message });
    console.error('Price order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while pricing the order' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Product not found' });
    const product = await ProductRate.findOne({ _id: req.params.id, ...orgScope(req.user) }).lean();
    if (!product) return res.status(404).json({ status: 'error', message: 'Product not found' });
    res.json({ status: 'success', data: { product } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error while loading the product' });
  }
});

router.post('/', productRules, validate, async (req, res) => {
  try {
    const { rules, errors, gstRate, unit } = await normaliseProduct(req);
    if (errors.length) return res.status(400).json({ status: 'error', code: 'INVALID_RATES', message: errors[0], errors });
    const product = await ProductRate.create({ ...fieldsOf(req.body, gstRate, unit), rules, userId: req.user._id, updatedBy: req.user._id, ...(req.user.dataScope && { dataScope: req.user.dataScope }) });
    invalidateProductCache(req.user);
    audit(req, { action: 'Product Rate Created', entityType: 'product_rate', entityId: product._id, entityName: product.productName, actionType: 'create', after: { rules: rules.length } });
    res.status(201).json({ status: 'success', data: { product } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', code: 'DUPLICATE_CODE', message: 'Another product already has that product code' });
    console.error('Create product rate error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving the product' });
  }
});

router.put('/:id', productRules, validate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Product not found' });
    const existing = await ProductRate.findOne({ _id: req.params.id, ...orgScope(req.user) });
    if (!existing) return res.status(404).json({ status: 'error', message: 'Product not found' });
    const { rules, errors, gstRate, unit } = await normaliseProduct(req);
    if (errors.length) return res.status(400).json({ status: 'error', code: 'INVALID_RATES', message: errors[0], errors });
    const before = { rules: existing.rules.length, gstRate: existing.gstRate };
    existing.set({ ...fieldsOf(req.body, gstRate, unit), rules, updatedBy: req.user._id });
    await existing.save();
    invalidateProductCache(req.user);
    // Rate changes never touch saved orders: they keep their own pricing snapshot.
    audit(req, { action: 'Product Rate Updated', entityType: 'product_rate', entityId: existing._id, entityName: existing.productName, actionType: 'update', before, after: { rules: rules.length, gstRate }, severity: 'medium' });
    res.json({ status: 'success', data: { product: existing } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', code: 'DUPLICATE_CODE', message: 'Another product already has that product code' });
    console.error('Update product rate error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving the product' });
  }
});

// DELETE deactivates: past orders keep their snapshot, and the product can be restored with PUT isActive.
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Product not found' });
    const product = await ProductRate.findOneAndUpdate({ _id: req.params.id, ...orgScope(req.user) }, { $set: { isActive: false, updatedBy: req.user._id } }, { new: true });
    if (!product) return res.status(404).json({ status: 'error', message: 'Product not found' });
    invalidateProductCache(req.user);
    audit(req, { action: 'Product Rate Deactivated', entityType: 'product_rate', entityId: product._id, entityName: product.productName, actionType: 'update', severity: 'medium' });
    res.json({ status: 'success', message: `${product.productName} was deactivated. Existing orders keep their prices.`, data: { product } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error while deactivating the product' });
  }
});

module.exports = router;
