const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const DiscountRule = require('../models/DiscountRule');
const CustomerPricing = require('../models/CustomerPricing');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { orgUserFilter, orgScope } = require('../utils/accessScope');

const router = express.Router();

/*
  Discounts a business gives:
    • discount rules — "10% off orders over ₹5,000", "₹200 off for new customers",
      "8% off for these customers" — with dates and an on/off switch;
    • customer rates — a standing discount % for one customer.
  POST /calculate works out the best discount for a customer and an order
  amount; the invoice and quotation forms use it to suggest the discount.
  Mounted behind "Discounts" in app.js (calculate also for Invoicing/Quotations).
*/

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oid = (v) => mongoose.isValidObjectId(v);

const log = (req, entityType, record, action, actionType, name) =>
  ActivityLog.logActivity({
    action,
    description: `${action}: ${name}`,
    entityType,
    entityId: record._id,
    entityName: name,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity: 'low',
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

/** Customers of the caller's business among the given ids. */
async function businessCustomers(req, ids) {
  const list = (ids || []).filter(oid);
  if (!list.length) return [];
  return Customer.find({ _id: { $in: list }, ...orgScope(req.user) }).select('_id name');
}

// ---------------------------------------------------------------------------
// Discount rules

const ruleRules = [
  body('name').trim().notEmpty().withMessage('Give the rule a name').isLength({ max: 120 }),
  body('type').isIn(['percentage', 'fixed']).withMessage('Choose % off or ₹ off'),
  body('value').isFloat({ gt: 0 }).withMessage('Enter the discount'),
  body('value').if(body('type').equals('percentage')).isFloat({ max: 100 }).withMessage('A percentage can be at most 100'),
  body('minimumAmount').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Minimum order must be a positive amount'),
  body('maximumAmount').optional({ values: 'falsy' }).isFloat({ gt: 0 }).withMessage('Maximum discount must be a positive amount'),
  body('customerType').optional({ values: 'falsy' }).isIn(['all', 'new', 'returning', 'specific']),
  body('customerIds').optional().isArray({ max: 500 }),
  body('customerIds.*').optional().isMongoId(),
  body('validFrom').optional({ values: 'falsy' }).isISO8601().withMessage('Choose a valid start date'),
  body('validUntil').optional({ values: 'falsy' }).isISO8601().withMessage('Choose a valid end date'),
  body('isActive').optional().isBoolean(),
  body('description').optional().trim().isLength({ max: 500 })
];

async function ruleData(req) {
  const b = req.body;
  const data = {
    name: b.name,
    type: b.type,
    value: Number(b.value),
    minimumAmount: b.minimumAmount ? Number(b.minimumAmount) : undefined,
    maximumAmount: b.maximumAmount ? Number(b.maximumAmount) : undefined,
    customerType: b.customerType || 'all',
    validFrom: b.validFrom ? new Date(b.validFrom) : new Date(),
    validUntil: b.validUntil ? new Date(`${String(b.validUntil).slice(0, 10)}T23:59:59.999`) : undefined,
    isActive: b.isActive !== undefined ? b.isActive === true || b.isActive === 'true' : true,
    description: b.description
  };
  if (data.validUntil && data.validUntil < data.validFrom) return { error: 'The end date is before the start date' };
  if (data.customerType === 'specific') {
    const customers = await businessCustomers(req, b.customerIds);
    if (!customers.length) return { error: 'Choose at least one customer' };
    data.customerIds = customers.map((c) => c._id);
  } else {
    data.customerIds = [];
  }
  return { data };
}

// GET /api/discounts/rules?search=&status=active|inactive|all
router.get('/rules', protect, [query('search').optional().trim(), query('status').optional().isIn(['all', 'active', 'inactive'])], validate, async (req, res) => {
  try {
    const filter = { ...(await orgUserFilter(req.user)) };
    if (req.query.status === 'active') filter.isActive = true;
    if (req.query.status === 'inactive') filter.isActive = false;
    if (req.query.search) filter.name = new RegExp(escapeRegex(req.query.search), 'i');
    const discountRules = await DiscountRule.find(filter).populate('customerIds', 'name').sort({ isActive: -1, createdAt: -1 });
    res.json({ status: 'success', data: { discountRules } });
  } catch (error) {
    console.error('Get discount rules error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching discount rules' });
  }
});

router.post('/rules', protect, ruleRules, validate, async (req, res) => {
  try {
    const { data, error } = await ruleData(req);
    if (error) return res.status(400).json({ status: 'error', message: error });
    const rule = await DiscountRule.create({ ...data, userId: req.user._id });
    log(req, 'discount_rule', rule, 'Discount Rule Created', 'create', rule.name);
    res.status(201).json({ status: 'success', message: 'Discount rule added', data: { discountRule: await rule.populate('customerIds', 'name') } });
  } catch (error) {
    console.error('Create discount rule error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating discount rule' });
  }
});

router.put('/rules/:id', protect, ruleRules, validate, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(404).json({ status: 'error', message: 'Discount rule not found' });
    const { data, error } = await ruleData(req);
    if (error) return res.status(400).json({ status: 'error', message: error });
    const rule = await DiscountRule.findOneAndUpdate({ _id: req.params.id, ...(await orgUserFilter(req.user)) }, data, { new: true, runValidators: true }).populate('customerIds', 'name');
    if (!rule) return res.status(404).json({ status: 'error', message: 'Discount rule not found' });
    log(req, 'discount_rule', rule, 'Discount Rule Updated', 'update', rule.name);
    res.json({ status: 'success', message: 'Discount rule updated', data: { discountRule: rule } });
  } catch (error) {
    console.error('Update discount rule error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating discount rule' });
  }
});

// PATCH /api/discounts/rules/:id/active  { isActive }
router.patch('/rules/:id/active', protect, [body('isActive').isBoolean()], validate, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(404).json({ status: 'error', message: 'Discount rule not found' });
    const rule = await DiscountRule.findOneAndUpdate({ _id: req.params.id, ...(await orgUserFilter(req.user)) }, { isActive: req.body.isActive === true || req.body.isActive === 'true' }, { new: true });
    if (!rule) return res.status(404).json({ status: 'error', message: 'Discount rule not found' });
    log(req, 'discount_rule', rule, rule.isActive ? 'Discount Rule Turned On' : 'Discount Rule Turned Off', 'update', rule.name);
    res.json({ status: 'success', data: { discountRule: rule } });
  } catch (error) {
    console.error('Toggle discount rule error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating discount rule' });
  }
});

router.delete('/rules/:id', protect, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(404).json({ status: 'error', message: 'Discount rule not found' });
    const rule = await DiscountRule.findOneAndDelete({ _id: req.params.id, ...(await orgUserFilter(req.user)) });
    if (!rule) return res.status(404).json({ status: 'error', message: 'Discount rule not found' });
    log(req, 'discount_rule', rule, 'Discount Rule Deleted', 'delete', rule.name);
    res.json({ status: 'success', message: 'Discount rule deleted' });
  } catch (error) {
    console.error('Delete discount rule error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting discount rule' });
  }
});

// ---------------------------------------------------------------------------
// Customer rates (one standing discount per customer)

const rateRules = (creating) => [
  ...(creating ? [body('customerId').isMongoId().withMessage('Choose a customer')] : []),
  body('discountPercentage').isFloat({ gt: 0, max: 100 }).withMessage('Discount must be between 0 and 100%'),
  body('validFrom').optional({ values: 'falsy' }).isISO8601(),
  body('validUntil').optional({ values: 'falsy' }).isISO8601(),
  body('isActive').optional().isBoolean(),
  body('notes').optional().trim().isLength({ max: 500 })
];

const rateData = (b) => {
  const data = {
    discountPercentage: Number(b.discountPercentage),
    validFrom: b.validFrom ? new Date(b.validFrom) : new Date(),
    validUntil: b.validUntil ? new Date(`${String(b.validUntil).slice(0, 10)}T23:59:59.999`) : undefined,
    isActive: b.isActive !== undefined ? b.isActive === true || b.isActive === 'true' : true,
    notes: b.notes
  };
  if (data.validUntil && data.validUntil < data.validFrom) return { error: 'The end date is before the start date' };
  return { data };
};

router.get('/customer-pricing', protect, [query('search').optional().trim()], validate, async (req, res) => {
  try {
    const filter = { ...(await orgUserFilter(req.user)) };
    if (req.query.search) filter.customerName = new RegExp(escapeRegex(req.query.search), 'i');
    const customerPricing = await CustomerPricing.find(filter).populate('customerId', 'name phone email').sort({ customerName: 1 });
    res.json({ status: 'success', data: { customerPricing } });
  } catch (error) {
    console.error('Get customer pricing error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching customer rates' });
  }
});

router.post('/customer-pricing', protect, rateRules(true), validate, async (req, res) => {
  try {
    const [customer] = await businessCustomers(req, [req.body.customerId]);
    if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });
    const scope = await orgUserFilter(req.user);
    if (await CustomerPricing.exists({ ...scope, customerId: customer._id })) {
      return res.status(409).json({ status: 'error', message: `${customer.name} already has a rate — edit it instead` });
    }
    const { data, error } = rateData(req.body);
    if (error) return res.status(400).json({ status: 'error', message: error });
    const rate = await CustomerPricing.create({ ...data, customerId: customer._id, customerName: customer.name, userId: req.user._id });
    log(req, 'customer_pricing', rate, 'Customer Rate Added', 'create', customer.name);
    res.status(201).json({ status: 'success', message: 'Customer rate added', data: { customerPricing: await rate.populate('customerId', 'name phone email') } });
  } catch (error) {
    console.error('Create customer pricing error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while adding customer rate' });
  }
});

router.put('/customer-pricing/:id', protect, rateRules(false), validate, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(404).json({ status: 'error', message: 'Customer rate not found' });
    const { data, error } = rateData(req.body);
    if (error) return res.status(400).json({ status: 'error', message: error });
    const rate = await CustomerPricing.findOneAndUpdate({ _id: req.params.id, ...(await orgUserFilter(req.user)) }, data, { new: true, runValidators: true }).populate('customerId', 'name phone email');
    if (!rate) return res.status(404).json({ status: 'error', message: 'Customer rate not found' });
    log(req, 'customer_pricing', rate, 'Customer Rate Updated', 'update', rate.customerName);
    res.json({ status: 'success', message: 'Customer rate updated', data: { customerPricing: rate } });
  } catch (error) {
    console.error('Update customer pricing error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating customer rate' });
  }
});

router.delete('/customer-pricing/:id', protect, async (req, res) => {
  try {
    if (!oid(req.params.id)) return res.status(404).json({ status: 'error', message: 'Customer rate not found' });
    const rate = await CustomerPricing.findOneAndDelete({ _id: req.params.id, ...(await orgUserFilter(req.user)) });
    if (!rate) return res.status(404).json({ status: 'error', message: 'Customer rate not found' });
    log(req, 'customer_pricing', rate, 'Customer Rate Removed', 'delete', rate.customerName);
    res.json({ status: 'success', message: 'Customer rate removed' });
  } catch (error) {
    console.error('Delete customer pricing error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while removing customer rate' });
  }
});

// ---------------------------------------------------------------------------
// Best discount for a customer and an order amount

const inForce = (now) => ({
  isActive: true,
  $and: [{ $or: [{ validFrom: { $lte: now } }, { validFrom: null }] }, { $or: [{ validUntil: { $gte: now } }, { validUntil: null }] }]
});

router.post(
  '/calculate',
  protect,
  [body('customerId').isMongoId().withMessage('Valid customer ID is required'), body('amount').isFloat({ min: 0 }).withMessage('Amount must be non-negative')],
  validate,
  async (req, res) => {
    try {
      const amount = Number(req.body.amount) || 0;
      const [customer] = await businessCustomers(req, [req.body.customerId]);
      if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });
      const scope = await orgUserFilter(req.user);
      const now = new Date();

      const candidates = [];
      const rate = await CustomerPricing.findOne({ ...scope, customerId: customer._id, ...inForce(now) });
      if (rate && rate.discountPercentage > 0) {
        candidates.push({
          type: 'customer_pricing',
          id: rate._id,
          name: `${customer.name}'s rate`,
          label: `${rate.discountPercentage}% off`,
          discountAmount: (amount * rate.discountPercentage) / 100
        });
      }

      // New = no issued invoice yet for this customer.
      const isNewCustomer = !(await Invoice.exists({ ...orgScope(req.user), customerId: customer._id, status: { $nin: ['draft', 'cancelled'] } }));
      const rules = await DiscountRule.find({ ...scope, ...inForce(now) });
      for (const rule of rules) {
        if (rule.minimumAmount && amount < rule.minimumAmount) continue;
        const who = rule.customerType || 'all';
        if (who === 'new' && !isNewCustomer) continue;
        if (who === 'returning' && isNewCustomer) continue;
        if (who === 'specific' && !(rule.customerIds || []).some((id) => String(id) === String(customer._id))) continue;
        let discountAmount = rule.type === 'fixed' ? rule.value : (amount * rule.value) / 100;
        if (rule.maximumAmount) discountAmount = Math.min(discountAmount, rule.maximumAmount);
        candidates.push({
          type: 'discount_rule',
          id: rule._id,
          name: rule.name,
          label: rule.type === 'fixed' ? `₹${rule.value} off` : `${rule.value}% off`,
          discountAmount
        });
      }

      const best = candidates.map((c) => ({ ...c, discountAmount: Math.round(Math.min(c.discountAmount, amount) * 100) / 100 })).sort((a, b) => b.discountAmount - a.discountAmount)[0] || null;
      res.json({
        status: 'success',
        data: {
          originalAmount: amount,
          discountAmount: best?.discountAmount || 0,
          finalAmount: amount - (best?.discountAmount || 0),
          appliedRule: best,
          isNewCustomer
        }
      });
    } catch (error) {
      console.error('Calculate discount error:', error);
      res.status(500).json({ status: 'error', message: 'Server error while calculating discount' });
    }
  }
);

// GET /api/discounts/stats/summary
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = await orgUserFilter(req.user);
    const now = new Date();
    const [rules, activeRules, rates, activeRates] = await Promise.all([
      DiscountRule.countDocuments(scope),
      DiscountRule.countDocuments({ ...scope, ...inForce(now) }),
      CustomerPricing.countDocuments(scope),
      CustomerPricing.countDocuments({ ...scope, ...inForce(now) })
    ]);
    res.json({ status: 'success', data: { stats: { rules, activeRules, rates, activeRates } } });
  } catch (error) {
    console.error('Get discount stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching discount statistics' });
  }
});

module.exports = router;
