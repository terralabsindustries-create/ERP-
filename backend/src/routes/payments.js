const express = require('express');
const mongoose = require('mongoose');
const { body, query, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { staffScopeQuery, canViewAllStaffData } = require('../utils/dataScopeHelper');
const { orgMemberIds, orgScope } = require('../utils/accessScope');

const router = express.Router();

const METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'upi', 'wallet'];
const STATUSES = ['pending', 'completed', 'failed', 'cancelled', 'refunded'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Payments a login may see. Same rule as invoices: staff see the payments they
 * recorded; the admin and "view all staff data" logins see the business's.
 * Payments recorded before `dataScope` existed are matched by who recorded them.
 */
async function paymentScope(user) {
  if (!user.dataScope || !canViewAllStaffData(user)) return { userId: user._id };
  return { $or: [{ dataScope: user.dataScope }, { userId: { $in: await orgMemberIds(user) } }] };
}

const rejectInvalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ status: 'error', message: errors.array()[0].msg, errors: errors.array() });
  return true;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Move an invoice's paid amount by `delta` (positive when money comes in,
 * negative when a payment is cancelled, refunded or deleted) and recompute its
 * balance and payment status. Adjusting by the difference keeps amounts that
 * were recorded directly on the invoice (Invoices → Record payment) intact.
 */
async function applyToInvoice(invoiceId, delta) {
  if (!invoiceId || !delta) return;
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) return;
  invoice.paidAmount = round2(Math.min(Math.max((invoice.paidAmount || 0) + delta, 0), invoice.totalAmount));
  invoice.paymentStatus = invoice.paidAmount >= invoice.totalAmount ? 'paid' : invoice.paidAmount > 0 ? 'partial' : 'pending';
  if (invoice.paymentStatus === 'paid') invoice.status = 'paid';
  else if (invoice.status === 'paid') invoice.status = 'sent';
  await invoice.save(); // pre-save recomputes balanceAmount
}

const counted = (payment) => (payment.status === 'completed' ? payment.amount : 0);

const populate = (q) =>
  q.populate('customerId', 'name email phone company').populate('invoiceId', 'invoiceNumber totalAmount balanceAmount paymentStatus dueDate');

// Validation rules
const paymentValidation = [
  body('customerId').isMongoId().withMessage('Choose a customer'),
  body('invoiceId').optional({ checkFalsy: true }).isMongoId().withMessage('Choose a valid invoice'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('paymentMethod').isIn(METHODS).withMessage('Choose a payment method'),
  body('status').optional().isIn(STATUSES).withMessage('Invalid payment status'),
  body('paymentDate').optional({ checkFalsy: true }).isISO8601().withMessage('Valid payment date required'),
  body('referenceNumber').optional().isString().trim().isLength({ max: 100 }),
  body('notes').optional().isString().trim().isLength({ max: 1000 })
];

// Fields a client may set; ids, numbering and ownership are server-side.
const pickFields = (b) => {
  const out = {};
  for (const k of ['amount', 'paymentMethod', 'status', 'paymentDate', 'referenceNumber', 'transactionId', 'notes', 'chequeDetails', 'bankDetails', 'upiDetails', 'cardDetails']) {
    if (b[k] !== undefined && b[k] !== '') out[k] = b[k];
  }
  if (out.amount !== undefined) out.amount = round2(out.amount);
  return out;
};

/** Customer and (optional) invoice the payment refers to, checked against the caller's business. */
async function resolveParties(req, res) {
  const customer = await Customer.findOne({ _id: req.body.customerId, ...orgScope(req.user) });
  if (!customer) {
    res.status(404).json({ status: 'error', message: 'Customer not found' });
    return null;
  }
  let invoice = null;
  if (req.body.invoiceId) {
    invoice = await Invoice.findOne({ _id: req.body.invoiceId, ...staffScopeQuery(req.user) });
    if (!invoice) {
      res.status(404).json({ status: 'error', message: 'Invoice not found' });
      return null;
    }
    if (String(invoice.customerId) !== String(customer._id)) {
      res.status(400).json({ status: 'error', message: 'That invoice belongs to a different customer' });
      return null;
    }
  }
  return { customer, invoice };
}

// @route   GET /api/payments
// @desc    Payments the caller may see, with totals for the same filters
// @access  Private (Payments)
router.get('/', protect, [
  query('status').optional().isIn([...STATUSES, 'all']),
  query('paymentMethod').optional().isIn([...METHODS, 'all']),
  query('search').optional().trim(),
  query('customerId').optional().isMongoId(),
  query('dateFrom').optional().isISO8601(),
  query('dateTo').optional().isISO8601(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const { status, paymentMethod, search, dateFrom, dateTo, page = 1, limit = 20 } = req.query;
    const sortBy = ['paymentDate', 'amount', 'createdAt'].includes(req.query.sortBy) ? req.query.sortBy : 'paymentDate';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;

    // Everything except the status filter: the status totals are computed over
    // this, so the cards stay meaningful while one status is selected.
    const base = [await paymentScope(req.user)];
    if (paymentMethod && paymentMethod !== 'all') base.push({ paymentMethod });
    if (req.query.customerId) base.push({ customerId: req.query.customerId });
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
      base.push({ paymentDate: range });
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      base.push({ $or: [{ paymentId: rx }, { customerName: rx }, { invoiceNumber: rx }, { referenceNumber: rx }] });
    }
    const listQuery = { $and: status && status !== 'all' ? [...base, { status }] : base };

    const pageSize = parseInt(limit);
    const [payments, totalPayments, byStatus] = await Promise.all([
      populate(Payment.find(listQuery))
        .sort({ [sortBy]: sortOrder, _id: -1 })
        .skip((parseInt(page) - 1) * pageSize)
        .limit(pageSize),
      Payment.countDocuments(listQuery),
      Payment.aggregate([
        { $match: { $and: base } },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }
      ])
    ]);

    const summary = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amount: 0 }]));
    for (const row of byStatus) summary[row._id] = { count: row.count, amount: round2(row.amount) };
    summary.all = {
      count: byStatus.reduce((n, r) => n + r.count, 0),
      amount: round2(byStatus.reduce((n, r) => n + r.amount, 0))
    };

    res.status(200).json({
      status: 'success',
      data: {
        payments,
        summary,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalPayments / pageSize),
          count: payments.length,
          totalPayments
        }
      }
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching payments' });
  }
});

// @route   GET /api/payments/stats/summary
// @desc    Payment statistics (declared before /:id so "stats" is not read as an id)
// @access  Private (Payments)
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = await paymentScope(req.user);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const sum = (match) =>
      Payment.aggregate([{ $match: { $and: [scope, match] } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).then((r) => round2(r[0]?.total || 0));

    const [totalPayments, todayPayments, monthlyPayments, totalAmount, todayAmount, monthlyAmount, paymentMethodStats] = await Promise.all([
      Payment.countDocuments(scope),
      Payment.countDocuments({ $and: [scope, { paymentDate: { $gte: today } }] }),
      Payment.countDocuments({ $and: [scope, { paymentDate: { $gte: monthStart } }] }),
      sum({ status: 'completed' }),
      sum({ status: 'completed', paymentDate: { $gte: today } }),
      sum({ status: 'completed', paymentDate: { $gte: monthStart } }),
      Payment.aggregate([
        { $match: { $and: [scope, { status: 'completed' }] } },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$amount' } } },
        { $sort: { total: -1 } }
      ])
    ]);

    res.status(200).json({
      status: 'success',
      data: { stats: { totalPayments, todayPayments, monthlyPayments, totalAmount, todayAmount, monthlyAmount, paymentMethodStats } }
    });
  } catch (error) {
    console.error('Get payment stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching payment statistics' });
  }
});

// @route   GET /api/payments/:id
// @access  Private (Payments)
router.get('/:id', protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    const payment = await populate(Payment.findOne({ $and: [{ _id: req.params.id }, await paymentScope(req.user)] }));
    if (!payment) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    res.status(200).json({ status: 'success', data: { payment } });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching payment' });
  }
});

// @route   POST /api/payments
// @desc    Record a payment received from a customer
// @access  Private (Payments: Record Payment)
router.post('/', protect, requirePermission('Payments: Record Payment'), paymentValidation, async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const parties = await resolveParties(req, res);
    if (!parties) return;
    const { customer, invoice } = parties;

    const fields = pickFields(req.body);
    const status = fields.status || 'completed';
    if (invoice && status === 'completed' && fields.amount > round2(invoice.balanceAmount) + 0.01) {
      return res.status(400).json({
        status: 'error',
        message: `Amount is more than the invoice balance (₹${round2(invoice.balanceAmount).toLocaleString('en-IN')}).`,
        code: 'AMOUNT_EXCEEDS_BALANCE'
      });
    }

    const payment = await Payment.create({
      ...fields,
      status,
      paymentId: `PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      customerId: customer._id,
      customerName: customer.name,
      invoiceId: invoice?._id,
      invoiceNumber: invoice?.invoiceNumber,
      collectedByName: req.user.fullName,
      userId: req.user._id,
      dataScope: req.user.dataScope
    });

    await applyToInvoice(invoice?._id, counted(payment));

    ActivityLog.logActivity({
      action: 'Payment Recorded',
      description: `Payment ${payment.paymentId} of ₹${payment.amount} was recorded for ${customer.name}${invoice ? ` against ${invoice.invoiceNumber}` : ''}`,
      entityType: 'payment',
      entityId: payment._id,
      entityName: payment.paymentId,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch((err) => console.error('Activity log (create payment) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Payment recorded',
      data: { payment: await populate(Payment.findById(payment._id)) }
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating payment' });
  }
});

// @route   PUT /api/payments/:id
// @desc    Correct a payment (amount, method, status, date, reference, notes)
// @access  Private (Payments: Record Payment)
router.put('/:id', protect, requirePermission('Payments: Record Payment'), [
  body('amount').optional().isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('paymentMethod').optional().isIn(METHODS),
  body('status').optional().isIn(STATUSES),
  body('paymentDate').optional({ checkFalsy: true }).isISO8601()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    const payment = await Payment.findOne({ $and: [{ _id: req.params.id }, await paymentScope(req.user)] });
    if (!payment) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }

    const before = counted(payment);
    Object.assign(payment, pickFields(req.body));
    if (!payment.dataScope && req.user.dataScope) payment.dataScope = req.user.dataScope;
    await payment.save();
    await applyToInvoice(payment.invoiceId, counted(payment) - before);

    ActivityLog.logActivity({
      action: 'Payment Updated',
      description: `Payment ${payment.paymentId} was updated`,
      entityType: 'payment',
      entityId: payment._id,
      entityName: payment.paymentId,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(pickFields(req.body)) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch((err) => console.error('Activity log (update payment) failed:', err.message));

    res.status(200).json({ status: 'success', message: 'Payment updated', data: { payment: await populate(Payment.findById(payment._id)) } });
  } catch (error) {
    console.error('Update payment error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating payment' });
  }
});

// @route   DELETE /api/payments/:id
// @access  Private (Payments: Delete)
router.delete('/:id', protect, requirePermission('Payments: Delete'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    const payment = await Payment.findOneAndDelete({ $and: [{ _id: req.params.id }, await paymentScope(req.user)] });
    if (!payment) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    await applyToInvoice(payment.invoiceId, -counted(payment));

    ActivityLog.logActivity({
      action: 'Payment Deleted',
      description: `Payment ${payment.paymentId} of ₹${payment.amount} was deleted`,
      entityType: 'payment',
      entityId: payment._id,
      entityName: payment.paymentId,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch((err) => console.error('Activity log (delete payment) failed:', err.message));

    res.status(200).json({ status: 'success', message: 'Payment deleted successfully' });
  } catch (error) {
    console.error('Delete payment error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting payment' });
  }
});

module.exports = router;
