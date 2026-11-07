const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { body, query, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Customer = require('../models/Customer');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const { staffScopeQuery, canViewAllStaffData } = require('../utils/dataScopeHelper');
const { orgMemberIds, orgScope } = require('../utils/accessScope');
const ledger = require('../services/paymentLedger');

const router = express.Router();

const METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'upi', 'wallet'];
const STATUSES = ['pending', 'completed', 'failed', 'cancelled', 'refunded'];
// Statuses whose allocations can still be changed: received, or pending (a
// cheque not yet cleared — its allocations count once it is received).
const ALLOCATABLE = ['completed', 'pending'];
const { round2 } = ledger;

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

const populate = (q) =>
  q.populate('customerId', 'name email phone company').populate('invoiceId', 'invoiceNumber totalAmount balanceAmount paymentStatus dueDate');

/** A payment as the API returns it: its allocations (older records included) and what is left on account. */
function present(payment) {
  const allocations = ledger.allocationsOf(payment);
  const json = typeof payment.toJSON === 'function' ? payment.toJSON() : { ...payment };
  delete json.idempotencyKey;
  delete json.idempotencyFingerprint;
  return {
    ...json,
    allocations: allocations.map((a) => ({ invoiceId: String(a.invoiceId), invoiceNumber: a.invoiceNumber, amount: a.amount, allocatedAt: a.allocatedAt })),
    allocatedAmount: ledger.allocatedTotal(allocations),
    unallocatedAmount: ledger.unallocatedOf(payment)
  };
}

const sendError = (res, error, fallback) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message, code: error.code, details: error.details });
  }
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ status: 'error', message: error.message });
  }
  console.error(`${fallback}:`, error);
  return res.status(500).json({ status: 'error', message: `Server error while ${fallback.toLowerCase()}` });
};

const log = (req, payment, action, description, actionType, extra = {}) =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'payment',
    entityId: payment._id,
    entityName: payment.paymentId,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity: 'low',
    userId: req.user._id,
    dataScope: req.user.dataScope,
    ...extra
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

const describeAllocations = (allocations) =>
  allocations.length ? allocations.map((a) => `${a.invoiceNumber || a.invoiceId} ₹${a.amount}`).join(', ') : 'on account';

// Validation rules
const allocationRules = [
  body('allocations').optional().isArray({ max: 100 }).withMessage('allocations must be a list'),
  body('allocations.*.invoiceId').optional().isMongoId().withMessage('Choose a valid invoice'),
  body('allocations.*.amount').optional().isFloat({ min: 0.01 }).withMessage('Each allocation must be more than 0')
];

const paymentValidation = [
  body('customerId').isMongoId().withMessage('Choose a customer'),
  body('invoiceId').optional({ checkFalsy: true }).isMongoId().withMessage('Choose a valid invoice'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('paymentMethod').isIn(METHODS).withMessage('Choose a payment method'),
  body('status').optional().isIn(STATUSES).withMessage('Invalid payment status'),
  body('paymentDate').optional({ checkFalsy: true }).isISO8601().withMessage('Valid payment date required'),
  body('referenceNumber').optional().isString().trim().isLength({ max: 100 }),
  body('notes').optional().isString().trim().isLength({ max: 1000 }),
  body('idempotencyKey').optional().isString().trim().isLength({ min: 8, max: 100 }).withMessage('Invalid idempotency key'),
  ...allocationRules
];

// Fields a client may set; ids, numbering, ownership and allocations are server-side.
const pickFields = (b) => {
  const out = {};
  for (const k of ['amount', 'paymentMethod', 'status', 'paymentDate', 'referenceNumber', 'transactionId', 'notes', 'chequeDetails', 'bankDetails', 'upiDetails', 'cardDetails']) {
    if (b[k] !== undefined && b[k] !== '') out[k] = b[k];
  }
  if (out.amount !== undefined) out.amount = round2(out.amount);
  return out;
};

const idempotencyKeyOf = (req) => {
  const key = (req.get('Idempotency-Key') || req.body.idempotencyKey || '').toString().trim();
  return key || undefined;
};

/** JSON with object keys sorted at every level, and empty values dropped, so equal requests serialise equally. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined && value[k] !== null && value[k] !== '')
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * What a payment request asks for, as a hash: the customer, every field the
 * payment is saved with (amount, method, status, date, reference, notes and
 * method details) and its invoice allocations. Two requests with the same
 * idempotency key are the same payment only if these match. `invoiceId` is
 * read as an allocation of the whole amount, allocations in any order, and a
 * date by the instant it names.
 */
function requestFingerprint(body) {
  const fields = pickFields(body);
  const requested = Array.isArray(body.allocations)
    ? body.allocations
    : body.invoiceId ? [{ invoiceId: body.invoiceId, amount: fields.amount }] : [];
  const allocations = requested
    .map((a) => ({ invoiceId: String((a && a.invoiceId) || '').toLowerCase(), amount: round2(a && a.amount) }))
    .sort((x, y) => (x.invoiceId < y.invoiceId ? -1 : x.invoiceId > y.invoiceId ? 1 : x.amount - y.amount));
  const date = fields.paymentDate ? new Date(fields.paymentDate) : null;
  return crypto
    .createHash('sha256')
    .update(canonical({
      ...fields,
      customerId: String(body.customerId || '').toLowerCase(),
      status: fields.status || 'completed',
      paymentDate: date && !Number.isNaN(date.getTime()) ? date.toISOString() : fields.paymentDate,
      allocations
    }))
    .digest('hex');
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
    if (req.query.customerId) base.push({ customerId: new mongoose.Types.ObjectId(req.query.customerId) });
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
      base.push({ $or: [{ paymentId: rx }, { customerName: rx }, { invoiceNumber: rx }, { 'allocations.invoiceNumber': rx }, { referenceNumber: rx }] });
    }
    const listQuery = { $and: status && status !== 'all' ? [...base, { status }] : base };

    // Allocated part of a payment: its allocations, or for an older record
    // with none, all of it when it names an invoice.
    const allocated = {
      $cond: [
        { $gt: [{ $size: { $ifNull: ['$allocations', []] } }, 0] },
        { $sum: '$allocations.amount' },
        { $cond: [{ $ifNull: ['$invoiceId', false] }, '$amount', 0] }
      ]
    };

    const pageSize = parseInt(limit);
    const [payments, totalPayments, byStatus, onAccount] = await Promise.all([
      populate(Payment.find(listQuery))
        .sort({ [sortBy]: sortOrder, _id: -1 })
        .skip((parseInt(page) - 1) * pageSize)
        .limit(pageSize),
      Payment.countDocuments(listQuery),
      Payment.aggregate([
        { $match: { $and: base } },
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: { $and: [...base, { status: 'completed' }] } },
        { $project: { left: { $subtract: ['$amount', allocated] } } },
        { $match: { left: { $gte: 0.005 } } },
        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$left' } } }
      ])
    ]);

    const summary = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amount: 0 }]));
    for (const row of byStatus) summary[row._id] = { count: row.count, amount: round2(row.amount) };
    summary.all = {
      count: byStatus.reduce((n, r) => n + r.count, 0),
      amount: round2(byStatus.reduce((n, r) => n + r.amount, 0))
    };
    // Received but not yet applied to any invoice (advances).
    summary.onAccount = { count: onAccount[0]?.count || 0, amount: round2(onAccount[0]?.amount || 0) };

    res.status(200).json({
      status: 'success',
      data: {
        payments: payments.map(present),
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
    sendError(res, error, 'Fetching payments');
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
    sendError(res, error, 'Fetching payment statistics');
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
    res.status(200).json({ status: 'success', data: { payment: present(payment) } });
  } catch (error) {
    sendError(res, error, 'Fetching payment');
  }
});

/**
 * The earlier submission with this idempotency key, as the response to a
 * repeat: the same payment, not a second one — but only if the repeat asks for
 * exactly the same payment (requestFingerprint). A key reused for anything
 * else is refused with 409.
 */
async function replay(req, res, key, fingerprint) {
  const existing = await Payment.findOne({ userId: req.user._id, idempotencyKey: key });
  if (!existing) return false;
  // Keys recorded before fingerprints were stored can only be matched on
  // customer and amount.
  const same = existing.idempotencyFingerprint
    ? existing.idempotencyFingerprint === fingerprint
    : String(existing.customerId) === String(req.body.customerId) && round2(existing.amount) === round2(req.body.amount);
  if (!same) {
    res.status(409).json({ status: 'error', message: 'This submission key was already used for a different payment.', code: 'IDEMPOTENCY_KEY_REUSED' });
    return true;
  }
  res.status(200).json({ status: 'success', message: 'Payment already recorded', replayed: true, data: { payment: present(await populate(Payment.findById(existing._id))) } });
  return true;
}

// @route   POST /api/payments
// @desc    Record a payment received from a customer. `allocations`
//          ([{ invoiceId, amount }]) applies it to invoices, `invoiceId` applies
//          all of it to one; with neither it is held on account.
// @access  Private (Payments: Record Payment, or Invoicing: Record Payment for
//          a payment applied in full to invoices)
router.post('/', protect, paymentValidation, async (req, res) => {
  const key = idempotencyKeyOf(req);
  try {
    if (rejectInvalid(req, res)) return;
    if (key && key.length > 100) return res.status(400).json({ status: 'error', message: 'Invalid idempotency key' });

    const canRecord = userCan(req.user, 'Payments: Record Payment');
    if (!canRecord && !userCan(req.user, 'Invoicing: Record Payment')) {
      return res.status(403).json({ status: 'error', message: 'You do not have permission to record payment in Payments.', code: 'PERMISSION_DENIED', required: 'Payments: Record Payment' });
    }

    const fields = pickFields(req.body);
    const fingerprint = key ? requestFingerprint(req.body) : undefined;
    if (key && (await replay(req, res, key, fingerprint))) return;

    const customer = await Customer.findOne({ _id: req.body.customerId, ...orgScope(req.user) });
    if (!customer) {
      return res.status(404).json({ status: 'error', message: 'Customer not found' });
    }

    const requested = Array.isArray(req.body.allocations)
      ? req.body.allocations
      : req.body.invoiceId ? [{ invoiceId: req.body.invoiceId, amount: fields.amount }] : [];
    const allocations = await ledger.resolveAllocations(requested, { customerId: customer._id, invoiceScope: staffScopeQuery(req.user), userId: req.user._id });
    const allocated = ledger.allocatedTotal(allocations);
    if (allocated > fields.amount + 0.005) {
      return res.status(400).json({ status: 'error', message: `The allocations (₹${allocated.toLocaleString('en-IN')}) add up to more than the payment.`, code: 'ALLOCATION_EXCEEDS_PAYMENT' });
    }
    // Recording money on account (an advance) is a Payments task; invoice
    // logins may only record what they apply to invoices.
    if (!canRecord && Math.abs(allocated - fields.amount) >= 0.005) {
      return res.status(403).json({ status: 'error', message: 'Only logins with Payments: Record Payment can record money on account.', code: 'PERMISSION_DENIED', required: 'Payments: Record Payment' });
    }

    let payment;
    try {
      payment = await ledger.createPayment({
        ...fields,
        status: fields.status || 'completed',
        paymentId: `PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        customerId: customer._id,
        customerName: customer.name,
        allocations,
        idempotencyKey: key,
        idempotencyFingerprint: fingerprint,
        collectedByName: req.user.fullName,
        userId: req.user._id,
        dataScope: req.user.dataScope
      });
    } catch (error) {
      // A concurrent submission with the same key got there first (or this
      // one failed because it did): answer with that payment.
      if (key && (await replay(req, res, key, fingerprint))) return;
      throw error;
    }

    log(req, payment, 'Payment Recorded',
      `Payment ${payment.paymentId} of ₹${payment.amount} was recorded for ${customer.name} (${describeAllocations(allocations)})`, 'create');

    res.status(201).json({
      status: 'success',
      message: 'Payment recorded',
      data: { payment: present(await populate(Payment.findById(payment._id))) }
    });
  } catch (error) {
    sendError(res, error, 'Creating payment');
  }
});

// @route   PUT /api/payments/:id/allocations
// @desc    Set which invoices a payment pays: { allocations: [{ invoiceId, amount }],
//          version? }. The list replaces the current one, so sending it twice
//          changes nothing the second time; an invoice left out goes back on
//          account. `version` (the payment's __v as loaded) refuses the change
//          if someone else changed the payment since.
// @access  Private (Payments: Record Payment)
router.put('/:id/allocations', protect, requirePermission('Payments: Record Payment'), [
  body('allocations').isArray({ max: 100 }).withMessage('allocations must be a list'),
  ...allocationRules.slice(1),
  body('version').optional().isInt({ min: 0 })
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
    if (req.body.version !== undefined && Number(req.body.version) !== (payment.__v || 0)) {
      return res.status(409).json({ status: 'error', message: 'This payment was changed by someone else. Reload it and try again.', code: 'PAYMENT_CHANGED' });
    }
    if (!ALLOCATABLE.includes(payment.status)) {
      return res.status(400).json({ status: 'error', message: `A ${payment.status} payment cannot be applied to invoices.`, code: 'PAYMENT_NOT_ALLOCATABLE' });
    }

    const existing = ledger.allocationsOf(payment);
    const allocations = await ledger.resolveAllocations(req.body.allocations, {
      customerId: payment.customerId,
      invoiceScope: staffScopeQuery(req.user),
      existing,
      userId: req.user._id
    });
    const allocated = ledger.allocatedTotal(allocations);
    if (allocated > payment.amount + 0.005) {
      return res.status(400).json({
        status: 'error',
        message: `Only ₹${round2(payment.amount).toLocaleString('en-IN')} can be allocated from this payment; these allocations add up to ₹${allocated.toLocaleString('en-IN')}.`,
        code: 'ALLOCATION_EXCEEDS_PAYMENT'
      });
    }

    const updated = await ledger.updatePayment(payment, { allocations, ...(!payment.dataScope && req.user.dataScope ? { dataScope: req.user.dataScope } : {}) });

    log(req, payment, 'Payment Allocated',
      `Payment ${payment.paymentId}: ${describeAllocations(existing)} → ${describeAllocations(allocations)}`, 'update',
      { severity: 'medium', changes: { before: { allocations: existing }, after: { allocations }, fields: ['allocations'] } });

    res.status(200).json({ status: 'success', message: 'Allocations saved', data: { payment: present(await populate(Payment.findById(updated._id))) } });
  } catch (error) {
    sendError(res, error, 'Allocating payment');
  }
});

// @route   PUT /api/payments/:id
// @desc    Correct a payment (amount, method, status, date, reference, notes).
//          Marking it refunded, failed or cancelled takes it off every invoice
//          it paid; marking it received again puts it back. `invoiceId` (older
//          clients) applies an unallocated payment in full to that invoice.
// @access  Private (Payments: Record Payment)
router.put('/:id', protect, requirePermission('Payments: Record Payment'), [
  body('amount').optional().isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('paymentMethod').optional().isIn(METHODS),
  body('invoiceId').optional({ checkFalsy: true }).isMongoId().withMessage('Choose a valid invoice'),
  body('status').optional().isIn(STATUSES),
  body('paymentDate').optional({ checkFalsy: true }).isISO8601(),
  body('referenceNumber').optional().isString().trim().isLength({ max: 100 }),
  body('notes').optional().isString().trim().isLength({ max: 1000 })
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

    const fields = pickFields(req.body);
    const amount = fields.amount ?? payment.amount;
    const existing = ledger.allocationsOf(payment);
    let allocations = existing;

    if (req.body.invoiceId) {
      const sameInvoice = existing.length === 1 && String(existing[0].invoiceId) === String(req.body.invoiceId);
      if (existing.length && !sameInvoice) {
        return res.status(400).json({ status: 'error', message: 'This payment is already allocated to an invoice' });
      }
      if (!sameInvoice) {
        allocations = await ledger.resolveAllocations([{ invoiceId: req.body.invoiceId, amount }], {
          customerId: payment.customerId,
          invoiceScope: staffScopeQuery(req.user),
          userId: req.user._id
        });
      }
    }
    // A payment recorded against one invoice follows its amount there; an
    // advance or a split payment keeps its allocations, which must still fit.
    const wholeToOne = allocations.length === 1 && Math.abs(allocations[0].amount - payment.amount) < 0.005;
    if (fields.amount !== undefined && wholeToOne) {
      allocations = [{ ...allocations[0], amount }];
    } else if (ledger.allocatedTotal(allocations) > amount + 0.005) {
      return res.status(400).json({
        status: 'error',
        message: `₹${ledger.allocatedTotal(allocations).toLocaleString('en-IN')} of this payment is applied to invoices; take some of it off them before lowering the amount.`,
        code: 'ALLOCATION_EXCEEDS_PAYMENT'
      });
    }

    const changes = { ...fields, allocations };
    if (!payment.dataScope && req.user.dataScope) changes.dataScope = req.user.dataScope;
    if (fields.status === 'refunded' && payment.status !== 'refunded') {
      changes.refundDetails = { ...(payment.toObject().refundDetails || {}), refundAmount: amount, refundDate: new Date() };
    }
    await ledger.updatePayment(payment, changes);

    log(req, payment, 'Payment Updated', `Payment ${payment.paymentId} was updated`, 'update', {
      severity: fields.status && fields.status !== payment.status ? 'medium' : 'low',
      changes: {
        before: { status: payment.status, amount: payment.amount, allocations: existing },
        after: { status: fields.status || payment.status, amount, allocations },
        fields: Object.keys(fields)
      }
    });

    res.status(200).json({ status: 'success', message: 'Payment updated', data: { payment: present(await populate(Payment.findById(payment._id))) } });
  } catch (error) {
    sendError(res, error, 'Updating payment');
  }
});

// @route   DELETE /api/payments/:id
// @desc    Delete a payment and take it back off every invoice it paid
// @access  Private (Payments: Delete)
router.delete('/:id', protect, requirePermission('Payments: Delete'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    const payment = await Payment.findOne({ $and: [{ _id: req.params.id }, await paymentScope(req.user)] });
    if (!payment) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    const allocations = ledger.allocationsOf(payment);
    await ledger.deletePayment(payment);

    log(req, payment, 'Payment Deleted',
      `Payment ${payment.paymentId} of ₹${payment.amount} (${payment.status}, ${describeAllocations(allocations)}) was deleted`, 'delete',
      { severity: 'high', changes: { before: { amount: payment.amount, status: payment.status, allocations }, after: null, fields: ['deleted'] } });

    res.status(200).json({ status: 'success', message: 'Payment deleted successfully' });
  } catch (error) {
    sendError(res, error, 'Deleting payment');
  }
});

module.exports = router;
