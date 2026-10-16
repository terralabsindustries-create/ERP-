const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const WalkInJob = require('../models/WalkInJob');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { orgScope, orgMemberIds } = require('../utils/accessScope');

const { STATUSES, QUEUE_STATUSES, JOB_TYPES, PRIORITIES, COLOR_MODES, SIDES, FINISHING, PAYMENT_METHODS, TRANSITIONS } = WalkInJob;

const router = express.Router();

const STATUS_LABEL = {
  waiting: 'waiting',
  in_progress: 'in progress',
  quality_check: 'in quality check',
  ready: 'ready for pickup',
  collected: 'collected',
  cancelled: 'cancelled'
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Counter jobs of the caller's business. Jobs carry `dataScope`; any saved
 * without one are matched by who in the business created them.
 */
async function jobScope(user) {
  if (!user.dataScope) return { userId: user._id };
  return {
    $or: [
      { dataScope: user.dataScope },
      { dataScope: { $in: [null, ''] }, userId: { $in: await orgMemberIds(user) } }
    ]
  };
}

async function findJob(req, id = req.params.id) {
  return WalkInJob.findOne({ $and: [{ _id: id }, await jobScope(req.user)] });
}

const populateJob = (q) =>
  q
    .populate('assignedTo.operator', 'fullName email role')
    .populate('billing.invoice', 'invoiceNumber totalAmount paidAmount balanceAmount paymentStatus status');

const notFound = (res) => res.status(404).json({ status: 'error', message: 'Counter job not found' });
const badRequest = (res, message) => res.status(400).json({ status: 'error', message });

/** "+91 98470 00000", "98470-00000", "0984700000" → "9847000000". */
function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function log(req, job, { action, description, actionType = 'update', severity = 'low', changes }) {
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'walk_in_job',
    entityId: job._id,
    entityName: job.jobNumber,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    changes,
    severity,
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));
}

const historyEntry = (req, fields) => ({ at: new Date(), by: req.user._id, byName: req.user.fullName, ...fields });

/** Turns a Mongoose validation error into the first readable message. */
const validationMessage = (error) => Object.values(error.errors || {})[0]?.message || error.message;

// Every id in the path must at least look like one; anything else is simply not found.
router.param('id', (req, res, next, id) => (mongoose.isValidObjectId(id) ? next() : notFound(res)));

// ---------------------------------------------------------------------------
// Validation: exactly what the counter job editor sends.
// ---------------------------------------------------------------------------
const jobValidation = [
  body('customerName').isString().withMessage('Customer name is required').bail().trim().notEmpty().withMessage('Customer name is required').isLength({ max: 120 }).withMessage('Customer name is too long'),
  body('customerPhone')
    .customSanitizer(normalizePhone)
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Enter a 10-digit mobile number'),
  body('customerEmail').optional({ values: 'falsy' }).isEmail().withMessage('Enter a valid email address').bail().normalizeEmail({ gmail_remove_dots: false }),
  body('customerId').optional({ values: 'falsy' }).isMongoId().withMessage('Choose a valid customer'),
  body('jobType').isIn(JOB_TYPES).withMessage('Choose a job type'),
  body('description').isString().withMessage('Describe the job').bail().trim().notEmpty().withMessage('Describe the job').isLength({ max: 500 }).withMessage('Description is too long'),
  body('specifications.quantity').isInt({ min: 1, max: 1000000 }).withMessage('Quantity must be at least 1').toInt(),
  body('specifications.copies').optional({ values: 'falsy' }).isInt({ min: 1, max: 100000 }).withMessage('Copies must be at least 1').toInt(),
  body('specifications.paperSize').optional({ values: 'null' }).isString().trim().isLength({ max: 60 }).withMessage('Size is too long'),
  body('specifications.paperType').optional({ values: 'null' }).isString().trim().isLength({ max: 80 }).withMessage('Paper is too long'),
  body('specifications.colorMode').optional().isIn(COLOR_MODES).withMessage('Choose colour or black & white'),
  body('specifications.sides').optional().isIn(SIDES).withMessage('Choose single or double sided'),
  body('specifications.finishing').optional().isArray({ max: FINISHING.length }).withMessage('Choose finishing from the list'),
  body('specifications.finishing.*').isIn(FINISHING).withMessage('Choose finishing from the list'),
  body('specifications.specialInstructions').optional({ values: 'null' }).isString().trim().isLength({ max: 500 }).withMessage('Instructions are too long'),
  body('timeline.estimatedCompletion').isISO8601().withMessage('Choose when the job is promised'),
  body('timeline.priority').optional().isIn(PRIORITIES).withMessage('Choose a priority'),
  body('pricing.estimatedCost').optional({ values: 'falsy' }).isFloat({ min: 0, max: 10000000 }).withMessage('Price must be 0 or more'),
  body('pricing.advancePaid')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0 })
    .withMessage('Advance must be 0 or more')
    .bail()
    .custom((value, { req }) => Number(value) <= Number(req.body.pricing?.estimatedCost || 0))
    .withMessage('Advance can’t be more than the price'),
  body('pricing.advanceMethod').optional().isIn(PAYMENT_METHODS).withMessage('Choose how the advance was paid'),
  body('notes').optional({ values: 'null' }).isString().trim().isLength({ max: 1000 }).withMessage('Notes are too long')
];

/** The editable fields of a job as [path, value] pairs; status, billing and numbering are server-side. */
function editableFields(b) {
  const s = b.specifications || {};
  const p = b.pricing || {};
  const t = b.timeline || {};
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    customerName: b.customerName,
    customerPhone: b.customerPhone,
    customerEmail: text(b.customerEmail),
    jobType: b.jobType,
    description: b.description,
    'specifications.quantity': s.quantity,
    'specifications.copies': s.copies || 1,
    'specifications.paperSize': text(s.paperSize),
    'specifications.paperType': text(s.paperType),
    'specifications.colorMode': s.colorMode || 'black_white',
    'specifications.sides': s.sides || 'single',
    'specifications.finishing': Array.isArray(s.finishing) ? [...new Set(s.finishing)] : [],
    'specifications.specialInstructions': text(s.specialInstructions),
    'timeline.estimatedCompletion': new Date(t.estimatedCompletion),
    'timeline.priority': t.priority || 'medium',
    'pricing.estimatedCost': round2(p.estimatedCost || 0),
    'pricing.advancePaid': round2(p.advancePaid || 0),
    'pricing.advanceMethod': p.advanceMethod || 'cash',
    notes: text(b.notes)
  };
}

/** The customer picked in the editor, checked against the caller's business. */
async function resolveCustomer(req, res) {
  if (!req.body.customerId) return { id: undefined };
  const customer = await Customer.findOne({ _id: req.body.customerId, ...orgScope(req.user) }).select('_id');
  if (!customer) {
    res.status(400).json({ status: 'error', message: 'That customer is not in your customer list' });
    return null;
  }
  return { id: customer._id };
}

// ---------------------------------------------------------------------------
// Reads (declared before /:id so "stats" and "operators" are not read as ids)
// ---------------------------------------------------------------------------

// @route   GET /api/walk-in-jobs/stats/summary
// @desc    Today's counter figures, counts per status and average turnaround
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const stats = await WalkInJob.getCounterStats(await jobScope(req.user));
    res.status(200).json({ status: 'success', data: { stats } });
  } catch (error) {
    console.error('Get counter job stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching counter job figures' });
  }
});

// @route   GET /api/walk-in-jobs/operators
// @desc    Active logins of the business a job can be assigned to
router.get('/operators', protect, async (req, res) => {
  try {
    const operators = await User.find({
      _id: { $in: await orgMemberIds(req.user) },
      isActive: { $ne: false },
      status: { $ne: 'invited' }
    })
      .select('fullName role')
      .sort({ fullName: 1 })
      .lean();
    res.status(200).json({ status: 'success', data: { operators } });
  } catch (error) {
    console.error('Get counter job operators error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching operators' });
  }
});

const VIEWS = {
  all: () => ({}),
  queue: () => ({ status: { $in: QUEUE_STATUSES } }),
  active: () => ({ status: { $in: [...QUEUE_STATUSES, 'ready'] } }),
  overdue: () => ({ status: { $in: QUEUE_STATUSES }, 'timeline.estimatedCompletion': { $lt: new Date() } }),
  unbilled: () => ({ status: { $in: ['ready', 'collected'] }, 'billing.invoice': null }),
  ...Object.fromEntries(STATUSES.map((s) => [s, () => ({ status: s })]))
};
const SORTS = { createdAt: 'createdAt', promisedAt: 'timeline.estimatedCompletion', jobNumber: 'jobNumber', customerName: 'customerName' };

// @route   GET /api/walk-in-jobs
// @desc    Counter jobs of the business, by view, with filters and paging
router.get('/', protect, [
  query('view').optional().isIn(Object.keys(VIEWS)).withMessage('Unknown view'),
  query('status').optional().isIn([...STATUSES, 'all']).withMessage('Unknown status'),
  query('jobType').optional().isIn([...JOB_TYPES, 'all']).withMessage('Unknown job type'),
  query('priority').optional().isIn([...PRIORITIES, 'all']).withMessage('Unknown priority'),
  query('operator').optional().custom((v) => v === 'all' || v === 'unassigned' || mongoose.isValidObjectId(v)).withMessage('Unknown operator'),
  query('search').optional().isString().trim().isLength({ max: 100 }),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('sortBy').optional().isIn(Object.keys(SORTS)),
  query('sortOrder').optional().isIn(['asc', 'desc'])
], validate, async (req, res) => {
  try {
    const { view = 'all', status, jobType, priority, operator, search, page = 1, limit = 25, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const conditions = [await jobScope(req.user), VIEWS[view]()];
    if (status && status !== 'all') conditions.push({ status });
    if (jobType && jobType !== 'all') conditions.push({ jobType });
    if (priority && priority !== 'all') conditions.push({ 'timeline.priority': priority });
    if (operator === 'unassigned') conditions.push({ 'assignedTo.operator': null });
    else if (operator && operator !== 'all') conditions.push({ 'assignedTo.operator': operator });
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const or = [{ jobNumber: rx }, { customerName: rx }, { description: rx }, { 'billing.invoiceNumber': rx }, { customerPhone: rx }];
      const digits = search.replace(/\D/g, '');
      if (digits.length >= 3) or.push({ customerPhone: new RegExp(escapeRegex(normalizePhone(digits) || digits)) });
      conditions.push({ $or: or });
    }
    const where = { $and: conditions };

    const [jobs, totalJobs] = await Promise.all([
      populateJob(WalkInJob.find(where))
        .sort({ [SORTS[sortBy]]: sortOrder === 'asc' ? 1 : -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      WalkInJob.countDocuments(where)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        jobs,
        pagination: { current: page, total: Math.ceil(totalJobs / limit), count: jobs.length, totalJobs }
      }
    });
  } catch (error) {
    console.error('Get counter jobs error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching counter jobs' });
  }
});

// @route   GET /api/walk-in-jobs/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const job = await populateJob(WalkInJob.findOne({ $and: [{ _id: req.params.id }, await jobScope(req.user)] }));
    if (!job) return notFound(res);
    res.status(200).json({ status: 'success', data: { job } });
  } catch (error) {
    console.error('Get counter job error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching the counter job' });
  }
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// @route   POST /api/walk-in-jobs
// @desc    Take a new counter job; it starts in the queue as waiting
router.post('/', protect, jobValidation, validate, async (req, res) => {
  try {
    const customer = await resolveCustomer(req, res);
    if (!customer) return;

    let job;
    // The number is the next free one for the day across every business; two
    // counters saving at the same moment can pick the same one, so retry.
    for (let attempt = 0; ; attempt++) {
      job = new WalkInJob({
        customerId: customer.id,
        status: 'waiting',
        history: [historyEntry(req, { status: 'waiting', event: 'created' })],
        userId: req.user._id,
        dataScope: req.user.dataScope
      });
      job.set(editableFields(req.body));
      try {
        await job.save();
        break;
      } catch (error) {
        if (error.code === 11000 && error.keyPattern?.jobNumber && attempt < 3) continue;
        throw error;
      }
    }

    log(req, job, { action: 'Counter Job Created', description: `Counter job ${job.jobNumber} for ${job.customerName} was taken`, actionType: 'create' });

    res.status(201).json({
      status: 'success',
      message: 'Counter job created',
      data: { job: await populateJob(WalkInJob.findById(job._id)) }
    });
  } catch (error) {
    if (error.name === 'ValidationError') return badRequest(res, validationMessage(error));
    console.error('Create counter job error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating the counter job' });
  }
});

// @route   PUT /api/walk-in-jobs/:id
// @desc    Edit a job's customer, details, promise and price
router.put('/:id', protect, jobValidation, validate, async (req, res) => {
  try {
    const job = await findJob(req);
    if (!job) return notFound(res);

    const fields = editableFields(req.body);
    if (job.billing?.invoice) {
      const priceChanged =
        fields['pricing.estimatedCost'] !== round2(job.pricing?.estimatedCost || 0) || fields['pricing.advancePaid'] !== round2(job.pricing?.advancePaid || 0);
      if (priceChanged) return badRequest(res, `This job is billed on ${job.billing.invoiceNumber}; its price and advance can't change.`);
    }

    const customer = await resolveCustomer(req, res);
    if (!customer) return;

    job.set(fields);
    job.customerId = customer.id || (job.billing?.invoice ? job.customerId : undefined);
    await job.save();

    log(req, job, { action: 'Counter Job Updated', description: `Counter job ${job.jobNumber} was edited`, changes: { fields: Object.keys(fields) } });

    res.status(200).json({ status: 'success', message: 'Counter job updated', data: { job: await populateJob(WalkInJob.findById(job._id)) } });
  } catch (error) {
    if (error.name === 'ValidationError') return badRequest(res, validationMessage(error));
    console.error('Update counter job error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating the counter job' });
  }
});

// @route   DELETE /api/walk-in-jobs/:id
// @desc    Remove a job taken by mistake. Billed jobs stay: they back an invoice.
router.delete('/:id', protect, async (req, res) => {
  try {
    const job = await findJob(req);
    if (!job) return notFound(res);
    if (job.billing?.invoice) {
      return badRequest(res, `This job is billed on ${job.billing.invoiceNumber} and can't be deleted.`);
    }
    await job.deleteOne();

    log(req, job, { action: 'Counter Job Deleted', description: `Counter job ${job.jobNumber} was deleted`, actionType: 'delete', severity: 'high' });

    res.status(200).json({ status: 'success', message: 'Counter job deleted' });
  } catch (error) {
    console.error('Delete counter job error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting the counter job' });
  }
});

// @route   PUT /api/walk-in-jobs/:id/status
// @desc    Move a job along the counter flow (see TRANSITIONS in the model)
router.put('/:id/status', protect, [
  body('status').isIn(STATUSES).withMessage('Choose a valid status'),
  body('note').optional({ values: 'null' }).isString().trim().isLength({ max: 500 }).withMessage('Note is too long')
], validate, async (req, res) => {
  try {
    const job = await findJob(req);
    if (!job) return notFound(res);

    const from = job.status;
    const to = req.body.status;
    if (from === to) return badRequest(res, `The job is already ${STATUS_LABEL[to]}.`);
    if (!TRANSITIONS[from]?.includes(to)) {
      if (from === 'quality_check' && to === 'ready') return badRequest(res, 'Record the quality check to mark this job ready.');
      return badRequest(res, `A job that is ${STATUS_LABEL[from]} can't be moved to ${STATUS_LABEL[to]}.`);
    }
    if (to === 'cancelled' && job.billing?.invoice) {
      return badRequest(res, `This job is billed on ${job.billing.invoiceNumber}; cancel the invoice instead.`);
    }

    const now = new Date();
    const note = req.body.note || undefined;
    job.status = to;
    if (to === 'in_progress' && !job.timeline.startedAt) job.timeline.startedAt = now;
    if (to === 'quality_check') {
      job.timeline.qualityCheckAt = now;
      job.qualityCheck = { checked: false, approved: false };
    }
    if (to === 'ready') job.timeline.readyAt = now;
    if (to === 'collected') job.timeline.collectedAt = now;
    if (to === 'cancelled') {
      job.timeline.cancelledAt = now;
      job.cancelReason = note;
    }
    if (from === 'cancelled') {
      job.timeline.cancelledAt = undefined;
      job.cancelReason = undefined;
    }
    if (from === 'collected') job.timeline.collectedAt = undefined;
    job.history.push(historyEntry(req, { status: to, event: 'status', note }));
    await job.save();

    log(req, job, {
      action: 'Counter Job Status Updated',
      description: `Counter job ${job.jobNumber} is now ${STATUS_LABEL[to]}`,
      actionType: to === 'cancelled' ? 'cancel' : to === 'collected' ? 'complete' : to === 'in_progress' && from === 'waiting' ? 'start' : 'update',
      severity: 'medium'
    });

    res.status(200).json({ status: 'success', message: `Job is ${STATUS_LABEL[to]}`, data: { job: await populateJob(WalkInJob.findById(job._id)) } });
  } catch (error) {
    if (error.name === 'ValidationError') return badRequest(res, validationMessage(error));
    console.error('Update counter job status error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating the job status' });
  }
});

// @route   PUT /api/walk-in-jobs/:id/assign
// @desc    Give the job to an operator (a login of the business), or clear it with null
router.put('/:id/assign', protect, [
  body('operatorId').optional({ values: 'null' }).isMongoId().withMessage('Choose an operator')
], validate, async (req, res) => {
  try {
    const job = await findJob(req);
    if (!job) return notFound(res);
    if (['collected', 'cancelled'].includes(job.status)) return badRequest(res, `The job is ${STATUS_LABEL[job.status]}; there is nothing to assign.`);

    const { operatorId } = req.body;
    let operator = null;
    if (operatorId) {
      const members = await orgMemberIds(req.user);
      if (members.some((id) => id.toString() === String(operatorId))) {
        operator = await User.findOne({ _id: operatorId, isActive: { $ne: false }, status: { $ne: 'invited' } }).select('fullName');
      }
      if (!operator) return badRequest(res, 'Choose an active login from your business');
    }

    job.assignedTo = operator ? { operator: operator._id, operatorName: operator.fullName, assignedAt: new Date() } : {};
    job.history.push(historyEntry(req, { event: 'assigned', note: operator ? operator.fullName : 'Unassigned' }));
    await job.save();

    log(req, job, {
      action: 'Counter Job Assigned',
      description: operator ? `Counter job ${job.jobNumber} was assigned to ${operator.fullName}` : `Counter job ${job.jobNumber} was unassigned`,
      actionType: 'assign',
      severity: 'medium'
    });

    res.status(200).json({ status: 'success', message: operator ? `Assigned to ${operator.fullName}` : 'Unassigned', data: { job: await populateJob(WalkInJob.findById(job._id)) } });
  } catch (error) {
    console.error('Assign counter job error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while assigning the job' });
  }
});

// @route   PUT /api/walk-in-jobs/:id/quality-check
// @desc    Record the check: pass makes the job ready, fail sends it back to production
router.put('/:id/quality-check', protect, [
  body('passed').isBoolean({ strict: true }).withMessage('Choose pass or fail'),
  body('notes').optional({ values: 'null' }).isString().trim().isLength({ max: 500 }).withMessage('Note is too long'),
  body('notes').if(body('passed').equals('false')).isString().withMessage('Say what needs fixing').bail().trim().notEmpty().withMessage('Say what needs fixing')
], validate, async (req, res) => {
  try {
    const job = await findJob(req);
    if (!job) return notFound(res);
    if (job.status !== 'quality_check') return badRequest(res, 'Send the job to quality check first.');

    const passed = req.body.passed === true;
    const notes = req.body.notes || undefined;
    const now = new Date();
    job.qualityCheck = { checked: true, approved: passed, checkedBy: req.user._id, checkedByName: req.user.fullName, checkedAt: now, notes };
    job.status = passed ? 'ready' : 'in_progress';
    if (passed) job.timeline.readyAt = now;
    job.history.push(historyEntry(req, { status: job.status, event: passed ? 'qc_passed' : 'qc_failed', note: notes }));
    await job.save();

    log(req, job, {
      action: 'Counter Job Quality Check',
      description: `Counter job ${job.jobNumber} ${passed ? 'passed' : 'failed'} quality check`,
      actionType: passed ? 'approve' : 'reject',
      severity: 'medium'
    });

    res.status(200).json({
      status: 'success',
      message: passed ? 'Passed — ready for pickup' : 'Failed — back in production',
      data: { job: await populateJob(WalkInJob.findById(job._id)) }
    });
  } catch (error) {
    console.error('Counter job quality check error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while recording the quality check' });
  }
});

// @route   PUT /api/walk-in-jobs/:id/invoice
// @desc    Link the invoice the job was billed on (created through POST /api/invoices)
router.put('/:id/invoice', protect, [
  body('invoiceId').isMongoId().withMessage('Choose a valid invoice')
], validate, async (req, res) => {
  try {
    const job = await findJob(req);
    if (!job) return notFound(res);
    if (!['ready', 'collected'].includes(job.status)) return badRequest(res, 'Bill the job once it is ready for pickup.');

    const invoice = await Invoice.findOne({ _id: req.body.invoiceId, ...orgScope(req.user) });
    if (!invoice) return res.status(404).json({ status: 'error', message: 'Invoice not found' });
    if (invoice.status === 'cancelled') return badRequest(res, `${invoice.invoiceNumber} is cancelled.`);
    if (invoice.noGst) return badRequest(res, `${invoice.invoiceNumber} is an older No GST bill; bill the job on a new invoice.`);

    if (job.billing?.invoice && String(job.billing.invoice) !== String(invoice._id)) {
      const current = await Invoice.findOne({ _id: job.billing.invoice, ...orgScope(req.user) }).select('status');
      if (current && current.status !== 'cancelled') return badRequest(res, `This job is already billed on ${job.billing.invoiceNumber}.`);
    }
    const other = await WalkInJob.findOne({ 'billing.invoice': invoice._id, _id: { $ne: job._id } }).select('jobNumber');
    if (other) return badRequest(res, `${invoice.invoiceNumber} is already linked to counter job ${other.jobNumber}.`);

    job.billing = {
      invoice: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.totalAmount,
      billedAt: new Date(),
      billedBy: req.user._id,
      billedByName: req.user.fullName
    };
    job.customerId = invoice.customerId;
    job.history.push(historyEntry(req, { event: 'billed', note: invoice.invoiceNumber }));
    await job.save();

    log(req, job, { action: 'Counter Job Billed', description: `Counter job ${job.jobNumber} was billed on ${invoice.invoiceNumber}`, severity: 'medium' });

    res.status(200).json({ status: 'success', message: `Billed on ${invoice.invoiceNumber}`, data: { job: await populateJob(WalkInJob.findById(job._id)) } });
  } catch (error) {
    console.error('Link counter job invoice error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while linking the invoice' });
  }
});

module.exports = router;
