const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const Job = require('../models/Job');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Quotation = require('../models/Quotation');
const ProductRate = require('../models/ProductRate');
const NumberSequence = require('../models/NumberSequence');
const User = require('../models/User');
const { validate } = require('../middleware/validate');
const { userCan } = require('../middleware/requirePermission');
const { orgScope } = require('../utils/accessScope');
const { jobScope } = require('../utils/jobAccess');
const { audit } = require('../utils/audit');
const { priceOrderRequest, PricingError } = require('../services/salesOrderPricing');
const { priceInvoiceDocument } = require('../utils/billing');
const { stateName } = require('../utils/gstStates');

const router = express.Router();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STAGES = ['design', 'printing', 'finishing'];
const STAGE_STATUS = { design: { start: 'design_in_progress', done: 'design_approved' }, printing: { start: 'ready_for_print', done: 'quality_check' }, finishing: { start: 'quality_check' } };

const scope = (req) => ({ isSalesOrder: true, ...jobScope(req.user) });
const sendPricing = (res, error) => res.status(error.status).json({ status: 'error', code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
const fail = (res, error, what) => {
  if (error instanceof PricingError) return sendPricing(res, error);
  if (error?.code === 11000) return res.status(409).json({ status: 'error', code: 'DUPLICATE', message: 'This order already exists or its quotation already has a live sales order.' });
  console.error(`${what} error:`, error);
  return res.status(500).json({ status: 'error', message: `Server error while ${what}` });
};

async function nextOrderNumber(user, date) {
  const d = new Date(date);
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const key = `salesorder:${user.dataScope || user._id}:${ym}`;
  const existingMax = 0;
  const n = await NumberSequence.nextAfter(key, existingMax);
  return `SO-${ym}-${String(n).padStart(4, '0')}`;
}

const lineRules = [
  body('lines').isArray({ min: 1, max: 100 }).withMessage('Add at least one product line'),
  body('lines.*.productId').isMongoId().withMessage('Every line needs a product'),
  body('lines.*.copies').isFloat({ gt: 0 }).withMessage('Copies must be above 0'),
  body('lines.*.wastage').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Wastage cannot be negative'),
  body('otherCharges').optional().isArray({ max: 30 }).withMessage('Other charges must be a list'),
  body('otherCharges.*.amount').optional().isFloat({ min: 0 }).withMessage('A charge cannot be negative'),
  body('otherCharges.*.gstRate').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 })
];

/** The Job fields for an order, from the server's own pricing of the request. */
function orderFields(req, priced, b) {
  const orderLines = priced.lines.map(({ raw, product, result }) => ({
    materialType: product.materialType, productId: product._id, productName: product.productName, productCode: product.productCode,
    copies: result.quantity, unit: result.unit, length: Number(raw.length) || undefined, width: Number(raw.width) || undefined, dimUnit: raw.dimUnit || undefined,
    basicDetails: raw.basicDetails || '', additionalDetails: raw.additionalDetails || '', wastage: Number(raw.wastage) || 0, workType: raw.workType || '',
    stages: { design: !!raw.stages?.design, printing: !!raw.stages?.printing, finishing: !!raw.stages?.finishing },
    discountType: raw.discountType === 'amount' ? 'amount' : 'percent', discountValue: Number(raw.discountValue) || 0,
    pricing: {
      priced: result.priced, basis: result.basis, billableBasis: result.billableBasis, area: result.area, rate: result.rate, rateBasis: result.rateBasis,
      exclusiveRate: result.exclusiveRate, inclusiveRate: result.inclusiveRate, gstRate: result.gstRate, cessRate: result.cessRate,
      grossTaxable: result.grossTaxable, discount: result.discount, taxable: result.taxable, gst: result.gst, cess: result.cess, total: result.total, adjustments: result.adjustments
    },
    // What the price was worked out from. Later changes to the rate master never alter it.
    pricingSnapshot: result.snapshot
  }));
  const items = priced.lines.map(({ product, result }, i) => {
    const denom = result.area ? result.area.total : result.quantity;
    const l = orderLines[i];
    return {
      itemName: product.productName,
      description: [l.basicDetails, l.additionalDetails].filter(Boolean).join(' — '),
      quantity: result.quantity, unit: result.unit, itemType: result.area ? 'Square Feet' : 'Numbers',
      unitPrice: denom > 0 ? Math.round((result.taxable / denom) * 10000) / 10000 : 0,
      hsnCode: product.hsnCode, gstRate: result.gstRate,
      length: l.length, width: l.width, totalSquareFeet: result.area ? result.area.total : 0,
      itemTotal: round2(result.taxable + result.gst + result.cess)
    };
  });
  const required = Object.fromEntries(STAGES.map((s) => [s, orderLines.some((l) => l.stages[s])]));
  const customer = priced.customer;
  return {
    title: String(b.projectName || '').trim() || `${customer.name} — order`,
    customerId: customer._id,
    customerName: customer.name,
    isSalesOrder: true,
    orderDate: b.orderDate ? new Date(b.orderDate) : new Date(),
    projectName: b.projectName ? String(b.projectName).trim() : undefined,
    salesType: priced.salesType,
    partyType: priced.partyType,
    copyOption: b.copyOption === 'no_copy' ? 'no_copy' : 'copy',
    customerSnapshot: {
      name: customer.name, mobile: b.mobile || customer.phone || '', state: priced.customerStateName || b.customerState || '',
      gstin: customer.gstNumber || '', address: b.address || customer.address || ''
    },
    orderLines,
    otherCharges: priced.totals.charges,
    orderTotals: priced.totals,
    items,
    estimatedCost: priced.totals.total,
    priority: ['low', 'medium', 'high', 'urgent'].includes(b.priority) ? b.priority : 'medium',
    dueDate: b.dueDate ? new Date(b.dueDate) : undefined,
    notes: b.notes ? String(b.notes).trim() : undefined,
    production: Object.fromEntries(STAGES.map((s) => [s, { required: required[s], status: 'pending' }]))
  };
}

/** Refuses to save an order with a line that has no price. */
function assertAllPriced(priced) {
  const bad = priced.lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.result.priced);
  if (bad.length) {
    const first = bad[0];
    throw new PricingError(422, `Line ${first.i + 1}: ${first.l.result.warnings[0]?.message || 'no price'}`, 'UNPRICED_LINE', { lines: bad.map(({ l, i }) => ({ line: i + 1, warnings: l.result.warnings })) });
  }
  if (priced.totals.warnings.length) throw new PricingError(400, priced.totals.warnings[0].message, 'BAD_CHARGE');
}

async function paymentsOf(order) {
  const rows = await Payment.find({ salesOrderId: order._id }).select('paymentId amount paymentMethod status paymentDate createdAt allocations').lean();
  const advance = round2(rows.filter((p) => p.status === 'completed').reduce((s, p) => s + p.amount, 0));
  return { rows, advance };
}

const shape = async (order) => {
  const { rows, advance } = await paymentsOf(order);
  const total = order.orderTotals?.total || 0;
  return { ...order, payments: rows, paid: advance, balance: round2(Math.max(0, total - advance)), excess: round2(Math.max(0, advance - total)) };
};

// ---- queue -----------------------------------------------------------------

// GET /api/sales-orders?search=&approval=&from=&to=&page=&limit=
router.get('/', [
  query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 }),
  query('approval').optional({ values: 'falsy' }).isIn(['all', 'pending', 'approved', 'cancelled'])
], validate, async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const filter = { ...scope(req) };
    if (req.query.approval && req.query.approval !== 'all') filter['approval.status'] = req.query.approval;
    if (req.query.from || req.query.to) {
      filter.orderDate = {};
      if (req.query.from) filter.orderDate.$gte = new Date(req.query.from);
      if (req.query.to) { const e = new Date(req.query.to); e.setHours(23, 59, 59, 999); filter.orderDate.$lte = e; }
    }
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [{ orderNumber: rx }, { customerName: rx }, { 'customerSnapshot.mobile': rx }, { projectName: rx }];
    }
    const base = { ...scope(req) };
    const [orders, total, counts] = await Promise.all([
      Job.find(filter).select('orderNumber orderDate projectName customerName customerSnapshot orderTotals approval production status assignedTo salesInvoiceId priority dueDate')
        .sort({ orderDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Job.countDocuments(filter),
      Job.aggregate([{ $match: base }, { $group: { _id: '$approval.status', n: { $sum: 1 } } }])
    ]);
    // One query for every row's advance, not one per row.
    const sums = await Payment.aggregate([{ $match: { salesOrderId: { $in: orders.map((o) => o._id) }, status: 'completed' } }, { $group: { _id: '$salesOrderId', paid: { $sum: '$amount' } } }]);
    const paid = new Map(sums.map((s) => [String(s._id), round2(s.paid)]));
    const rows = orders.map((o) => {
      const t = o.orderTotals?.total || 0;
      const p = paid.get(String(o._id)) || 0;
      const production = o.production || {};
      const stage = STAGES.find((s) => production[s]?.required && !['done', 'skipped'].includes(production[s].status));
      return {
        _id: o._id, orderNumber: o.orderNumber, orderDate: o.orderDate, projectName: o.projectName, customer: o.customerName, mobile: o.customerSnapshot?.mobile,
        total: t, discount: o.orderTotals?.discount || 0, paid: p, balance: round2(Math.max(0, t - p)),
        approvalStatus: o.approval?.status, productionStatus: o.status, processStatus: stage ? `${stage}: ${production[stage].status}` : (o.approval?.status === 'approved' ? 'all stages done' : '—'),
        assignedTo: o.assignedTo?.handlerName, invoiced: !!o.salesInvoiceId
      };
    });
    res.json({ status: 'success', data: { orders: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, counts: Object.fromEntries(counts.map((c) => [c._id || 'none', c.n])) } });
  } catch (error) { fail(res, error, 'loading sales orders'); }
});

// GET /api/sales-orders/from-quotation/:id — a quotation's details as order lines
router.get('/from-quotation/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Quotation not found' });
    const q = await Quotation.findOne({ _id: req.params.id, ...orgScope(req.user) }).populate('customer_id', 'name phone address gstNumber customerType').lean();
    if (!q) return res.status(404).json({ status: 'error', message: 'Quotation not found' });
    const names = (q.items || []).map((i) => i.item_name).filter(Boolean);
    const products = names.length ? await ProductRate.find({ ...orgScope(req.user), isActive: true, productName: { $in: names.map((n) => new RegExp(`^${escapeRegex(n)}$`, 'i')) } }).select('productName materialType unit').lean() : [];
    const byName = new Map(products.map((p) => [p.productName.toLowerCase(), p]));
    const live = await Job.findOne({ ...scope(req), quotationId: q._id, activeQuotationKey: { $exists: true } }).select('orderNumber').lean();
    res.json({
      status: 'success',
      data: {
        quotationId: q._id, quotationNumber: q.quotationNumber, customerId: q.customer_id?._id, customer: q.customer_id,
        existingOrder: live?.orderNumber || null,
        lines: (q.items || []).map((i) => {
          const p = byName.get(String(i.item_name || '').toLowerCase());
          return { itemName: i.item_name, productId: p?._id, materialType: p?.materialType, copies: i.quantity, unit: i.unit, length: i.length, width: i.width, quotedRate: i.unit_price, basicDetails: i.description || '', matched: !!p };
        })
      }
    });
  } catch (error) { fail(res, error, 'reading the quotation'); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const order = await Job.findOne({ _id: req.params.id, ...scope(req) }).lean();
    if (!order) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    res.json({ status: 'success', data: { order: await shape(order) } });
  } catch (error) { fail(res, error, 'loading the sales order'); }
});

// ---- create / edit -----------------------------------------------------------

router.post('/', [body('customerId').isMongoId().withMessage('Choose a customer'), body('clientRequestId').optional().isString().isLength({ max: 80 }), ...lineRules], validate, async (req, res) => {
  try {
    const rid = req.body.clientRequestId ? String(req.body.clientRequestId) : undefined;
    if (rid) {
      const again = await Job.findOne({ ...scope(req), clientRequestId: rid }).lean();
      if (again) return res.status(200).json({ status: 'success', replayed: true, data: { order: await shape(again) } });
    }
    const priced = await priceOrderRequest(req.user, req.body, { fresh: true });
    assertAllPriced(priced);

    let quotation = null;
    if (req.body.quotationId) {
      if (!mongoose.isValidObjectId(req.body.quotationId)) return res.status(400).json({ status: 'error', message: 'Invalid quotation' });
      quotation = await Quotation.findOne({ _id: req.body.quotationId, ...orgScope(req.user) }).select('_id customer_id quotationNumber').lean();
      if (!quotation) return res.status(404).json({ status: 'error', message: 'Quotation not found' });
      if (String(quotation.customer_id) !== String(priced.customer._id)) return res.status(400).json({ status: 'error', message: 'The quotation belongs to a different customer' });
    }
    const fields = orderFields(req, priced, req.body);
    const order = await Job.create({
      ...fields,
      orderNumber: await nextOrderNumber(req.user, fields.orderDate),
      approval: { status: 'pending' },
      status: 'inquiry',
      createdBy: req.user._id, userId: req.user._id,
      ...(req.user.dataScope && { dataScope: req.user.dataScope }),
      ...(quotation && { quotationId: quotation._id, activeQuotationKey: String(quotation._id) }),
      ...(rid && { clientRequestId: rid })
    });
    audit(req, { action: 'Sales Order Created', entityType: 'job', entityId: order._id, entityName: order.orderNumber, actionType: 'create', after: { total: order.orderTotals.total, lines: order.orderLines.length }, relatedCustomer: order.customerId });
    res.status(201).json({ status: 'success', data: { order: await shape(order.toObject()) } });
  } catch (error) {
    // A simultaneous request with the same clientRequestId won the race: answer with its order.
    if (error?.code === 11000 && req.body.clientRequestId) {
      const won = await Job.findOne({ ...scope(req), clientRequestId: String(req.body.clientRequestId) }).lean();
      if (won) return res.status(200).json({ status: 'success', replayed: true, data: { order: await shape(won) } });
    }
    fail(res, error, 'creating the sales order');
  }
});

router.put('/:id', [body('customerId').isMongoId(), ...lineRules], validate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const existing = await Job.findOne({ _id: req.params.id, ...scope(req) });
    if (!existing) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    if (existing.approval?.status !== 'pending') {
      return res.status(409).json({ status: 'error', code: 'ORDER_LOCKED', message: `A ${existing.approval?.status} order can no longer be edited.` });
    }
    const priced = await priceOrderRequest(req.user, req.body, { fresh: true });
    assertAllPriced(priced);
    const fields = orderFields(req, priced, req.body);
    delete fields.production; // untouched while pending, but rebuilt from the new lines:
    const production = Object.fromEntries(STAGES.map((s) => [s, { required: fields.orderLines.some((l) => l.stages[s]), status: 'pending' }]));
    const before = existing.orderTotals?.total;
    const updated = await Job.findOneAndUpdate({ _id: existing._id, 'approval.status': 'pending' }, { $set: { ...fields, production } }, { new: true }).lean();
    if (!updated) return res.status(409).json({ status: 'error', code: 'ORDER_LOCKED', message: 'The order was approved or cancelled while you were editing it.' });
    audit(req, { action: 'Sales Order Edited', entityType: 'job', entityId: updated._id, entityName: updated.orderNumber, actionType: 'update', before: { total: before }, after: { total: updated.orderTotals.total } });
    res.json({ status: 'success', data: { order: await shape(updated) } });
  } catch (error) { fail(res, error, 'saving the sales order'); }
});

// ---- approval -----------------------------------------------------------------

router.post('/:id/approve', async (req, res) => {
  try {
    if (!userCan(req.user, 'Sales Orders: Approve')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', required: 'Sales Orders: Approve', message: 'You are not allowed to approve orders.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const order = await Job.findOneAndUpdate(
      { _id: req.params.id, ...scope(req), 'approval.status': 'pending' },
      { $set: { 'approval.status': 'approved', 'approval.by': req.user._id, 'approval.byName': req.user.fullName, 'approval.at': new Date(), 'approval.note': req.body.note || undefined, status: 'quotation_approved' } },
      { new: true }
    ).lean();
    if (!order) {
      const current = await Job.findOne({ _id: req.params.id, ...scope(req) }).select('approval').lean();
      if (!current) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
      return res.status(409).json({ status: 'error', code: 'NOT_PENDING', message: `This order is already ${current.approval?.status}.` });
    }
    audit(req, { action: 'Sales Order Approved', entityType: 'job', entityId: order._id, entityName: order.orderNumber, actionType: 'approve', severity: 'medium', relatedCustomer: order.customerId });
    res.json({ status: 'success', data: { order: await shape(order) } });
  } catch (error) { fail(res, error, 'approving the order'); }
});

router.post('/:id/cancel', [body('reason').trim().notEmpty().withMessage('Give a reason for cancelling').isLength({ max: 300 })], validate, async (req, res) => {
  try {
    if (!userCan(req.user, 'Sales Orders: Cancel')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', required: 'Sales Orders: Cancel', message: 'You are not allowed to cancel orders.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const order = await Job.findOne({ _id: req.params.id, ...scope(req) }).lean();
    if (!order) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    if (order.approval?.status === 'cancelled') return res.status(409).json({ status: 'error', code: 'ALREADY_CANCELLED', message: 'This order is already cancelled.' });
    if (order.salesInvoiceId) {
      const inv = await Invoice.findById(order.salesInvoiceId).select('status invoiceNumber').lean();
      if (inv && inv.status !== 'cancelled') return res.status(409).json({ status: 'error', code: 'ORDER_INVOICED', message: `Invoice ${inv.invoiceNumber} was raised from this order. Cancel the invoice first.` });
    }
    if (STAGES.some((s) => order.production?.[s]?.status === 'done')) return res.status(409).json({ status: 'error', code: 'PRODUCTION_DONE', message: 'Production has already been completed for part of this order, so it cannot be cancelled.' });
    const done = await Job.findOneAndUpdate(
      { _id: order._id, 'approval.status': { $in: ['pending', 'approved'] }, $or: [{ salesInvoiceId: { $exists: false } }, { salesInvoiceId: null }, { salesInvoiceId: order.salesInvoiceId }] },
      { $set: { 'approval.status': 'cancelled', 'approval.note': req.body.reason, 'approval.by': req.user._id, 'approval.byName': req.user.fullName, 'approval.at': new Date(), status: 'cancelled' }, $unset: { activeQuotationKey: '' } },
      { new: true }
    ).lean();
    if (!done) return res.status(409).json({ status: 'error', message: 'The order changed while cancelling. Refresh and try again.' });
    const { advance } = await paymentsOf(done);
    audit(req, { action: 'Sales Order Cancelled', entityType: 'job', entityId: done._id, entityName: done.orderNumber, actionType: 'cancel', reason: req.body.reason, severity: 'high', relatedCustomer: done.customerId });
    res.json({ status: 'success', message: advance > 0 ? `Order cancelled. The ₹${advance} advance taken stays on the customer's account; refund or apply it from Payments.` : 'Order cancelled.', data: { order: await shape(done) } });
  } catch (error) { fail(res, error, 'cancelling the order'); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!userCan(req.user, 'Sales Orders: Delete')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', required: 'Sales Orders: Delete', message: 'You are not allowed to delete orders.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const order = await Job.findOne({ _id: req.params.id, ...scope(req) }).lean();
    if (!order) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const reasons = [];
    if (order.approval?.status === 'approved') reasons.push('it is approved (cancel it instead)');
    if (order.salesInvoiceId) reasons.push('an invoice was raised from it');
    if (STAGES.some((s) => ['in_progress', 'done', 'skipped'].includes(order.production?.[s]?.status))) reasons.push('production has started');
    if (await Payment.countDocuments({ salesOrderId: order._id })) reasons.push('payments are recorded against it');
    if (await Invoice.countDocuments({ jobId: order._id })) reasons.push('invoices are linked to it');
    if (reasons.length) return res.status(409).json({ status: 'error', code: 'ORDER_NOT_DELETABLE', message: `${order.orderNumber} cannot be deleted because ${reasons.join(', ')}.`, reasons });
    const gone = await Job.deleteOne({ _id: order._id, 'approval.status': { $in: ['pending', 'cancelled'] }, salesInvoiceId: { $exists: false } });
    if (!gone.deletedCount) return res.status(409).json({ status: 'error', message: 'The order changed while deleting. Refresh and try again.' });
    audit(req, { action: 'Sales Order Deleted', entityType: 'job', entityId: order._id, entityName: order.orderNumber, actionType: 'delete', severity: 'high', before: { total: order.orderTotals?.total, status: order.approval?.status } });
    res.json({ status: 'success', message: `${order.orderNumber} deleted` });
  } catch (error) { fail(res, error, 'deleting the order'); }
});

// ---- production stages ------------------------------------------------------------

// POST /api/sales-orders/:id/stages/:stage { action: start|complete|skip, assigneeId?, reason? }
router.post('/:id/stages/:stage', [body('action').isIn(['start', 'complete', 'skip'])], validate, async (req, res) => {
  try {
    const { stage } = req.params;
    if (!STAGES.includes(stage)) return res.status(400).json({ status: 'error', message: 'Unknown stage' });
    if (!userCan(req.user, 'Sales Orders: Change Stage')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', required: 'Sales Orders: Change Stage', message: 'You are not allowed to change production stages.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const order = await Job.findOne({ _id: req.params.id, ...scope(req) }).lean();
    if (!order) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    if (order.approval?.status !== 'approved') return res.status(409).json({ status: 'error', code: 'APPROVAL_REQUIRED', message: 'Production can start only after the order is approved.' });
    const prod = order.production || {};
    const cur = prod[stage] || { required: false, status: 'pending' };
    const { action } = req.body;
    const resolved = (s) => !prod[s]?.required || ['done', 'skipped'].includes(prod[s]?.status);
    const earlier = STAGES.slice(0, STAGES.indexOf(stage));
    const now = new Date();
    let to;
    if (action === 'start') {
      if (!cur.required) return res.status(409).json({ status: 'error', code: 'NOT_REQUIRED', message: `${stage} is not needed for this order.` });
      if (cur.status !== 'pending') return res.status(409).json({ status: 'error', code: 'BAD_TRANSITION', message: `${stage} is already ${cur.status}.` });
      const waiting = earlier.find((s) => !resolved(s));
      if (waiting) return res.status(409).json({ status: 'error', code: 'EARLIER_STAGE_OPEN', message: `Finish or skip ${waiting} first.` });
      to = 'in_progress';
    } else if (action === 'complete') {
      if (cur.status !== 'in_progress') return res.status(409).json({ status: 'error', code: 'BAD_TRANSITION', message: cur.status === 'done' ? `${stage} is already done.` : `Start ${stage} before completing it.` });
      to = 'done';
    } else {
      if (cur.status !== 'pending') return res.status(409).json({ status: 'error', code: 'BAD_TRANSITION', message: `${stage} is already ${cur.status}.` });
      if (cur.required && !String(req.body.reason || '').trim()) return res.status(400).json({ status: 'error', code: 'REASON_REQUIRED', message: `Give a reason for skipping ${stage}, which this order asked for.` });
      to = 'skipped';
    }
    let assignee = null;
    if (req.body.assigneeId && action === 'start') {
      assignee = mongoose.isValidObjectId(req.body.assigneeId) ? await User.findOne({ _id: req.body.assigneeId, ...(req.user.dataScope ? { dataScope: req.user.dataScope } : { _id: req.user._id }) }).select('fullName').lean() : null;
      if (!assignee) return res.status(400).json({ status: 'error', message: 'That person is not in this business' });
    }
    const set = { [`production.${stage}.status`]: to, [`production.${stage}.at`]: now, [`production.${stage}.by`]: req.user._id };
    if (action === 'skip') set[`production.${stage}.reason`] = req.body.reason || 'Not required';
    if (assignee) { set[`production.${stage}.assigneeId`] = assignee._id; set[`production.${stage}.assigneeName`] = assignee.fullName; set['assignedTo.handlerId'] = assignee._id; set['assignedTo.handlerName'] = assignee.fullName; set['assignedTo.assignedAt'] = now; }
    const map = STAGE_STATUS[stage] || {};
    if (to === 'in_progress' && map.start) set.status = map.start;
    if (to === 'done' && map.done) set.status = map.done;
    const after = { ...prod, [stage]: { ...cur, status: to } };
    if (STAGES.every((s) => !after[s]?.required || ['done', 'skipped'].includes(after[s]?.status)) && to !== 'in_progress') { set.status = 'completed'; set.completionDate = now; }
    const updated = await Job.findOneAndUpdate({ _id: order._id, 'approval.status': 'approved', [`production.${stage}.status`]: cur.status }, { $set: set }, { new: true }).lean();
    if (!updated) return res.status(409).json({ status: 'error', code: 'CHANGED', message: 'Someone else changed this stage. Refresh and try again.' });
    audit(req, { action: `Sales Order ${stage} ${to}`, entityType: 'job', entityId: updated._id, entityName: updated.orderNumber, actionType: 'update', before: { stage, status: cur.status }, after: { stage, status: to }, reason: req.body.reason });
    res.json({ status: 'success', data: { order: await shape(updated) } });
  } catch (error) { fail(res, error, 'changing the stage'); }
});

// ---- invoice ----------------------------------------------------------------------

// POST /api/sales-orders/:id/invoice — a draft invoice with the order's priced lines
router.post('/:id/invoice', async (req, res) => {
  let claimed = null;
  try {
    if (!userCan(req.user, 'Invoicing: Create & Edit')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', required: 'Invoicing: Create & Edit', message: 'You are not allowed to create invoices.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
    const stale = new Date(Date.now() - 60 * 1000);
    const order = await Job.findOneAndUpdate(
      { _id: req.params.id, ...scope(req), 'approval.status': 'approved', $and: [{ $or: [{ salesInvoiceId: { $exists: false } }, { salesInvoiceId: null }] }, { $or: [{ salesInvoiceClaimAt: { $exists: false } }, { salesInvoiceClaimAt: null }, { salesInvoiceClaimAt: { $lt: stale } }] }] },
      { $set: { salesInvoiceClaimAt: new Date() } }, { new: true }
    ).lean();
    if (!order) {
      const cur = await Job.findOne({ _id: req.params.id, ...scope(req) }).select('approval salesInvoiceId orderNumber').lean();
      if (!cur) return res.status(404).json({ status: 'error', message: 'Sales order not found' });
      if (cur.approval?.status !== 'approved') return res.status(409).json({ status: 'error', code: 'APPROVAL_REQUIRED', message: 'Only an approved order can be invoiced.' });
      if (cur.salesInvoiceId) {
        const inv = await Invoice.findById(cur.salesInvoiceId).select('invoiceNumber status').lean();
        return res.status(409).json({ status: 'error', code: 'ALREADY_INVOICED', message: `Already invoiced${inv ? ` (${inv.invoiceNumber})` : ''}.`, data: { invoiceId: cur.salesInvoiceId } });
      }
      return res.status(409).json({ status: 'error', code: 'INVOICE_IN_PROGRESS', message: 'An invoice is already being created for this order.' });
    }
    claimed = order._id;
    const charges = (order.otherCharges || []).map((c) => ({ itemName: c.name || 'Other charge', quantity: 1, unit: 'pieces', unitPrice: c.amount, gstRate: c.taxable === false ? 0 : c.gstRate }));
    const { lines, totals, design } = priceInvoiceDocument({ items: [...order.items, ...charges], designCharge: 0, discount: 0, isInterState: !!order.orderTotals?.isInterState });
    const customer = await require('../models/Customer').findById(order.customerId).lean();
    const invoiceDate = new Date();
    const dueDate = new Date(invoiceDate); dueDate.setDate(dueDate.getDate() + 30);
    let invoice;
    try {
      invoice = await Invoice.createNumbered({
        customerId: order.customerId, jobId: order._id, customerName: order.customerName,
        customerGstNumber: customer?.gstNumber || '', customerAddress: customer?.address || '',
        invoiceDate, dueDate, items: lines, subtotal: totals.subtotal, ...design, discountAmount: totals.discount,
        taxableAmount: totals.taxableAmount, totalGstAmount: totals.gst, totalAmount: totals.total,
        status: 'draft', isInterState: !!order.orderTotals?.isInterState, noGst: false,
        notes: order.projectName ? `Order ${order.orderNumber} — ${order.projectName}` : `Order ${order.orderNumber}`,
        userId: req.user._id, ...(req.user.dataScope && { dataScope: req.user.dataScope })
      });
    } catch (error) {
      if (Invoice.isNumberTaken && Invoice.isNumberTaken(error)) return res.status(409).json({ status: 'error', message: 'Several invoices were being numbered at the same moment. Please try again.' });
      throw error;
    }
    const linked = await Job.findOneAndUpdate({ _id: order._id, $or: [{ salesInvoiceId: { $exists: false } }, { salesInvoiceId: null }] }, { $set: { salesInvoiceId: invoice._id } }, { new: true });
    if (!linked) {
      await Invoice.deleteOne({ _id: invoice._id, status: 'draft' });
      return res.status(409).json({ status: 'error', message: 'The order changed while invoicing. No invoice was created; try again.' });
    }
    audit(req, { action: 'Sales Order Invoiced', entityType: 'job', entityId: order._id, entityName: order.orderNumber, actionType: 'create', after: { invoiceId: invoice._id }, relatedInvoice: invoice._id });
    res.status(201).json({ status: 'success', message: `Draft invoice ${invoice.invoiceNumber} created from ${order.orderNumber}. The advance (if any) stays on account until you apply it to the invoice in Payments.`, data: { invoice, orderTotal: order.orderTotals?.total } });
  } catch (error) { fail(res, error, 'creating the invoice'); } finally {
    if (claimed) await Job.updateOne({ _id: claimed }, { $unset: { salesInvoiceClaimAt: '' } }).catch(() => {});
  }
});

module.exports = router;
