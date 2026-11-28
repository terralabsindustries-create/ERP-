const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const Job = require('../models/Job');
const Customer = require('../models/Customer');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const Task = require('../models/Task');
const { isSameOrgUser, orgScope } = require('../utils/accessScope');
const { jobScope } = require('../utils/jobAccess');
const { notify } = require('../utils/notify');
const { HSN_PATTERN, priceLine, parseGstRate, round2 } = require('../utils/billing');

/*
  A job ticket's items as stored. An area item ("Square Feet") is length ×
  width per piece times its number of pieces — its quantity, 1 when not given
  — at the rate per sq ft / sq m; anything else is quantity × unit price.
  The area and the item total (with the item's GST) are worked out here from
  those, so what is saved always agrees with the pieces, the size and the rate.
*/
function jobItems(items) {
  return (items || []).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const gstRate = parseGstRate(item.gstRate) ?? 0;
    const withGst = (amount) => round2(amount + (amount * gstRate) / 100);
    if (item.itemType === 'Square Feet') {
      const quantity = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
      const unit = item.unit === 'sqm' ? 'sqm' : 'sqft';
      const p = priceLine({ quantity, unitPrice: item.unitPrice, unit, length: item.length, width: item.width });
      return { ...item, quantity, unit, totalSquareFeet: p.totalArea, itemTotal: withGst(p.amount) };
    }
    const p = priceLine({ quantity: item.quantity, unitPrice: item.unitPrice });
    return { ...item, totalSquareFeet: 0, itemTotal: withGst(p.amount) };
  });
}

/**
 * The billed parts of a job that a request would change, as names for a
 * message. Fields left out of the request, or sent unchanged, are not changes.
 */
function billedFieldsChanged(job, body) {
  const changed = [];
  const num = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
  if (body.customerId !== undefined && String(body.customerId) !== String(job.customerId)) changed.push('The customer');
  if (body.estimatedCost !== undefined && num(body.estimatedCost) !== num(job.estimatedCost)) changed.push('The estimated cost');
  if (body.items !== undefined) {
    const key = (i) => [String(i.itemName || '').trim(), num(i.quantity), num(i.unitPrice), num(i.gstRate), num(i.length), num(i.width), String(i.inventoryId || '')].join('|');
    const a = (Array.isArray(body.items) ? body.items : []).map(key).sort().join(';');
    const b = (job.items || []).map(key).sort().join(';');
    if (a !== b) changed.push('The items');
  }
  if (body.designCharge !== undefined) {
    const was = job.designCharge || {};
    const now = body.designCharge || {};
    if (num(now.amount) !== num(was.amount) || (num(now.amount) > 0 && num(now.gstRate ?? 18) !== num(was.gstRate ?? 18))) changed.push('The design charge');
  }
  if (body.printSpecs !== undefined && body.printSpecs) {
    const was = job.printSpecs || {};
    if (body.printSpecs.paperType !== undefined && String(body.printSpecs.paperType || '') !== String(was.paperType || '')) changed.push('The paper');
    if (body.printSpecs.sheets !== undefined && num(body.printSpecs.sheets) !== num(was.sheets)) changed.push('The sheet count');
  }
  return changed;
}

const router = express.Router();

// Validation rules
// Items are optional, but every item a job does carry must be worth something:
// a name, a price above 0, and a quantity (or, priced by area, a length and
// width) above 0.
const jobValidation = [
  body('title').notEmpty().withMessage('Job title is required').trim(),
  body('customerId').isMongoId().withMessage('Valid customer ID is required'),
  body('priority').optional({ values: 'falsy' }).isIn(['low', 'medium', 'high', 'urgent']),
  body('items').optional({ values: 'null' }).isArray({ max: 100 }).withMessage('Items must be a list'),
  body('items.*.itemName').trim().notEmpty().withMessage('Every item needs a name'),
  body('items.*.description').optional({ values: 'null' }).isString().trim().isLength({ max: 500 }).withMessage('Item notes are limited to 500 characters'),
  body('items.*.unitPrice').isFloat({ gt: 0 }).withMessage('Every item needs a price above 0'),
  body('items.*.hsnCode').optional({ values: 'falsy' }).trim().matches(HSN_PATTERN).withMessage('HSN codes are 4 to 8 digits'),
  body('items.*').custom((item) => {
    if (item?.itemType === 'Square Feet') {
      if (!(Number(item.length) > 0 && Number(item.width) > 0)) throw new Error('Every item priced by area needs a length and width above 0');
      // The number of pieces: a whole number, 1 or more (1 when left out).
      const pieces = item.quantity === undefined || item.quantity === null || item.quantity === '' ? 1 : Number(item.quantity);
      if (!Number.isInteger(pieces) || pieces < 1) throw new Error('The number of pieces must be a whole number, 1 or more');
    } else if (!(Number(item?.quantity) > 0)) {
      throw new Error('Every item needs a quantity above 0');
    }
    return true;
  }),
  body('designCharge').optional({ values: 'null' }).custom((charge) => {
    if (typeof charge === 'object' && !(Number(charge.amount) > 0)) throw new Error('Enter a design charge above 0, or remove it');
    return true;
  }),
  body('estimatedCost').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('The estimated cost cannot be negative'),
  body('printSpecs.quantity').optional({ values: 'falsy' }).isFloat({ gt: 0 }).withMessage('The print quantity must be above 0'),
  body('printSpecs.sheets').optional({ values: 'falsy' }).isFloat({ gt: 0 }).withMessage('The number of sheets must be above 0')
];

// @route   GET /api/jobs
// @desc    Get all jobs for the authenticated user
// @access  Private
router.get('/', protect, [
  query('status').optional({ values: 'falsy' }).isIn(['all', 'inquiry', 'quotation_sent', 'quotation_approved', 'design_in_progress',
    'design_approved', 'production_ready', 'ready_for_print', 'quality_check',
    'completed', 'delivered', 'cancelled'
  ]),
  query('priority').optional({ values: 'falsy' }).isIn(['all', 'low', 'medium', 'high', 'urgent']),
  query('stage').optional({ values: 'falsy' }).isIn(['all', 'open', 'pre_production', 'in_production', 'ready', 'closed']),
  query('customerId').optional({ values: 'falsy' }).isMongoId(),
  query('dateField').optional({ values: 'falsy' }).isIn(['createdAt', 'dueDate']),
  query('from').optional({ values: 'falsy' }).isISO8601(),
  query('to').optional({ values: 'falsy' }).isISO8601(),
  query('overdue').optional({ values: 'falsy' }).isIn(['true', 'false']),
  query('sortBy').optional({ values: 'falsy' }).isIn(['createdAt', 'updatedAt', 'dueDate', 'title', 'priority', 'status']),
  query('sortOrder').optional({ values: 'falsy' }).isIn(['asc', 'desc']),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 }),
  query('search').optional({ values: 'falsy' }).trim(),
], validate, async (req, res) => {
  try {
    const {
      status,
      priority,
      search,
      customerId,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    // Only the job tickets this login may see (utils/jobAccess.js); search,
    // filters, the count and the pages all stay inside them.
    const query = { ...jobScope(req.user) };

    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (priority && priority !== 'all') {
      query.priority = priority;
    }
    
    if (customerId) {
      query.customerId = customerId;
    }

    // Production stage groups (utils/jobMetrics.js), a date range on the
    // creation or delivery date, and overdue work — all on the server, so the
    // filters cover every job, not one page.
    const metrics = require('../utils/jobMetrics');
    const and = [];
    const STAGE_FILTERS = {
      open: { status: { $nin: metrics.CLOSED } },
      pre_production: { status: { $in: metrics.PRE_PRODUCTION } },
      in_production: { status: { $in: metrics.IN_PRODUCTION } },
      ready: { status: { $in: metrics.READY_FOR_DISPATCH } },
      closed: { status: { $in: metrics.CLOSED } }
    };
    if (req.query.stage && req.query.stage !== 'all') and.push(STAGE_FILTERS[req.query.stage]);
    if (req.query.from || req.query.to) {
      const field = req.query.dateField === 'dueDate' ? 'dueDate' : 'createdAt';
      const range = {};
      if (req.query.from) range.$gte = new Date(req.query.from);
      if (req.query.to) range.$lt = new Date(new Date(req.query.to).getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? 864e5 : 0));
      and.push({ [field]: range });
    }
    if (req.query.overdue === 'true') and.push({ ...metrics.UNFINISHED, dueDate: { $lt: metrics.startOfDay() } });

    if (search) {
      // Matched literally (not as a regex), and a customer's name finds their jobs.
      const rx = { $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const customerIds = await Customer.find({ ...(req.user.dataScope ? { dataScope: req.user.dataScope } : { userId: req.user._id }), $or: [{ name: rx }, { company: rx }] }).distinct('_id');
      and.push({ $or: [
        { title: rx },
        { description: rx },
        { 'items.itemName': rx },
        ...(mongoose.isValidObjectId(search) ? [{ _id: search }] : []),
        ...(customerIds.length ? [{ customerId: { $in: customerIds } }] : [])
      ] });
    }
    if (and.length) query.$and = and;
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    // The page and its count are independent: one round trip, not two. The
    // invoice summary carries what the list shows (number, totals, payment
    // state); line items come with the invoice itself when it is opened.
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 500);
    const [jobs, totalJobs] = await Promise.all([
      Job.find(query)
        .populate('customerId', 'name email phone company')
        .populate('assignedTo.handlerId', 'fullName')
        .populate('createdBy', 'fullName')
        .populate({
          path: 'invoices',
          select: '_id invoiceNumber totalAmount status paymentStatus paidAmount balanceAmount dueDate noGst createdAt',
          // Cancelled invoices don't count, and No GST ones only for logins allowed to see them.
          match: { status: { $ne: 'cancelled' }, ...(userCan(req.user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } }) },
          options: { sort: { createdAt: -1 } }
        })
        // Delivery state beside the payment state, for logins that can see deliveries.
        .populate(userCan(req.user, 'Delivery') ? {
          path: 'deliveries',
          select: '_id jobId deliveryId status deliveryDate dispatchedAt deliveryProof.deliveredAt',
          // The jobs are already limited to the caller's business; older deliveries may lack dataScope.
          match: { status: { $ne: 'cancelled' } },
          options: { sort: { createdAt: -1 } }
        } : [])
        .sort({ ...sort, _id: sort[sortBy] || -1 })
        .skip(skip)
        .limit(pageSize),
      Job.countDocuments(query)
    ]);
    
    res.status(200).json({
      status: 'success',
      data: {
        jobs,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalJobs / pageSize),
          count: jobs.length,
          totalJobs
        }
      }
    });
    
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching jobs'
    });
  }
});

// @route   GET /api/jobs/staff/stats
// @desc    Get total design charge for staff
// @access  Private (Staff role)
// NOTE: This route MUST be before /:id route to avoid matching "staff" as an ID
router.get('/staff/stats', protect, async (req, res) => {
  try {
    console.log('Getting staff stats for user:', req.user._id);

    const { period = 'all' } = req.query; // 'weekly', 'monthly', 'yearly', 'all'
    console.log('Period filter:', period);

    // Calculate date range based on period
    const mongoose = require('mongoose');
    let dateFilter = {};
    const now = new Date();

    if (period === 'weekly') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { createdAt: { $gte: weekAgo } };
    } else if (period === 'monthly') {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { createdAt: { $gte: monthAgo } };
    } else if (period === 'yearly') {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      dateFilter = { createdAt: { $gte: yearAgo } };
    }
    // If period is 'all', no date filter is applied

    // Design charges on the job tickets this staff member created, WITHOUT GST
    // (the GST is the business's tax, not the designer's earning). Cancelled
    // jobs earn nothing. The GST and the GST-inclusive figure come alongside.
    const me = new mongoose.Types.ObjectId(req.user._id);
    // Job counts for the same period: created (not cancelled), proof approved
    // (reached "Proof Approved" — design_approved — or any later stage) and
    // pending approval (still before it). Cancelled ones are counted apart.
    const APPROVED = ['design_approved', 'production_ready', 'ready_for_print', 'quality_check', 'completed', 'delivered'];
    const [result, jobCounts] = await Promise.all([
      Job.aggregate([
        {
          $match: {
            userId: me,
            'designCharge.amount': { $exists: true, $gt: 0 },
            status: { $ne: 'cancelled' },
            ...dateFilter
          }
        },
        {
          $group: {
            _id: null,
            amount: { $sum: '$designCharge.amount' },
            withGst: { $sum: { $ifNull: ['$designCharge.totalAmount', '$designCharge.amount'] } }
          }
        }
      ]),
      Job.aggregate([
        { $match: { userId: me, ...dateFilter } },
        {
          $group: {
            _id: null,
            all: { $sum: 1 },
            cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
            approved: { $sum: { $cond: [{ $in: ['$status', APPROVED] }, 1, 0] } }
          }
        }
      ])
    ]);
    const c = jobCounts[0] || { all: 0, cancelled: 0, approved: 0 };
    const jobs = { created: c.all - c.cancelled, approved: c.approved, pending: c.all - c.cancelled - c.approved, cancelled: c.cancelled };

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const totalDesignCharge = round2(result[0]?.amount || 0);
    const designChargeWithGst = round2(result[0]?.withGst || 0);

    console.log(`Total design charge calculated for staff (${period}):`, totalDesignCharge);

    res.status(200).json({
      status: 'success',
      data: {
        totalDesignCharge, // before GST
        designChargeGst: round2(designChargeWithGst - totalDesignCharge),
        designChargeWithGst,
        jobs
      }
    });

  } catch (error) {
    console.error('Get staff stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching staff statistics'
    });
  }
});

// @route   GET /api/jobs/mine
// @desc    Jobs relevant to the caller: ones they are the handler for, or have a
//          task on. Open to every login (no Jobs permission needed) because it
//          only returns work already assigned to them.
// @access  Private
router.get('/mine', protect, async (req, res) => {
  try {
    const taskJobIds = await Task.distinct('jobId', {
      assignedTo: req.user._id,
      status: { $nin: ['completed', 'cancelled'] },
      jobId: { $ne: null }
    });
    const jobs = await Job.find({
      ...orgScope(req.user),
      status: { $nin: ['delivered', 'cancelled'] },
      $or: [{ 'assignedTo.handlerId': req.user._id }, { _id: { $in: taskJobIds } }]
    })
      .select('title status priority dueDate printSpecs customerId assignedTo updatedAt')
      .populate('customerId', 'name')
      .sort({ dueDate: 1, updatedAt: -1 })
      .limit(50);

    res.status(200).json({ status: 'success', data: { jobs } });
  } catch (error) {
    console.error('Get my jobs error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching your jobs' });
  }
});

// @route   GET /api/jobs/:id
// @desc    Get single job
// @access  Private
// @route   GET /api/jobs/stats/summary
// @desc    Job Tickets page header over every visible job (not one page):
//          total, in progress, completed, and what their invoices billed.
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = jobScope(req.user);
    const Invoice = require('../models/Invoice');
    const [counts] = await Job.aggregate([
      { $match: scope },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $in: ['$status', ['completed', 'delivered', 'cancelled']] }, 0, 1] } },
        completed: { $sum: { $cond: [{ $in: ['$status', ['completed', 'delivered']] }, 1, 0] } }
      } }
    ]);
    let billed = null;
    if (userCan(req.user, 'Invoicing') || userCan(req.user, 'Jobs')) {
      const jobIds = await Job.find(scope).distinct('_id');
      const [b] = await Invoice.aggregate([
        { $match: { jobId: { $in: jobIds }, status: { $ne: 'cancelled' }, ...(userCan(req.user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } }) } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } }
      ]);
      billed = Math.round((b?.total || 0) * 100) / 100;
    }
    res.json({ status: 'success', data: { total: counts?.total || 0, active: counts?.active || 0, completed: counts?.completed || 0, billed } });
  } catch (error) {
    console.error('Job summary error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading job figures' });
  }
});

// @route   GET /api/jobs/board
// @desc    The production board and dashboard pipeline in one light request:
//          counts per stage (utils/jobMetrics.js — the one definition both
//          screens use), every open job as a card, and the latest deliveries.
// @access  Private (Jobs and the other job readers, see app.js)
const BOARD_FIELDS = 'title status priority dueDate customerId customerName printSpecs.paperType printSpecs.quantity printSpecs.printSize assignedTo.handlerName createdAt updatedAt';
const BOARD_LIMIT = 2000;
router.get('/board', protect, async (req, res) => {
  try {
    const scope = jobScope(req.user);
    const { pipelineSummary, CLOSED } = require('../utils/jobMetrics');
    const [summary, open, delivered] = await Promise.all([
      pipelineSummary(Job, scope),
      Job.find({ ...scope, status: { $nin: CLOSED } })
        .select(BOARD_FIELDS)
        .populate('customerId', 'name company')
        .sort({ dueDate: 1, _id: 1 })
        .limit(BOARD_LIMIT + 1)
        .lean(),
      Job.find({ ...scope, status: 'delivered' })
        .select(BOARD_FIELDS)
        .populate('customerId', 'name company')
        .sort({ updatedAt: -1 })
        .limit(15)
        .lean()
    ]);
    res.json({
      status: 'success',
      data: {
        ...summary,
        jobs: [...open.slice(0, BOARD_LIMIT), ...delivered],
        truncated: open.length > BOARD_LIMIT
      }
    });
  } catch (error) {
    console.error('Job board error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading the production board' });
  }
});

router.get('/:id', protect, async (req, res) => {
  try {
    const findQuery = { _id: req.params.id, ...jobScope(req.user) };
    const job = await Job.findOne(findQuery)
      .populate('customerId', 'name email phone address company')
      .populate('assignedTo.handlerId', 'fullName')
      .populate('assignedOperator', 'fullName')
      .populate('createdBy', 'fullName')
      .populate({
        path: 'flowHistory.updatedBy',
        select: 'fullName'
      });
    
    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      data: {
        job
      }
    });
    
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching job'
    });
  }
});

// @route   POST /api/jobs
// @desc    Create new job
// @access  Private
router.post('/', protect, requirePermission('Jobs: Create & Edit'), jobValidation, validate, async (req, res) => {
  try {
    // Verify customer exists and belongs to the authenticated user's dataScope or userId
    const customerQuery = req.user.dataScope
      ? { _id: req.body.customerId, dataScope: req.user.dataScope, status: 'active' }
      : { _id: req.body.customerId, userId: req.user._id, status: 'active' };
    const customer = await Customer.findOne(customerQuery);

    if (!customer) {
      return res.status(400).json({
        status: 'error',
        message: 'Customer not found or inactive'
      });
    }

    // The creator is the authenticated login, never a value from the request.
    const { userId: _userId, createdBy: _createdBy, dataScope: _dataScope, ...fields } = req.body;
    const jobData = {
      ...fields,
      createdBy: req.user._id,
      userId: req.user._id,
      ...(req.user.dataScope && { dataScope: req.user.dataScope }),
      // Explicitly handle items array
      items: jobItems(req.body.items),
      // Explicitly handle design charge
      designCharge: req.body.designCharge || null
    };

    const job = await Job.create(jobData);
    
    await job.populate([
      { path: 'customerId', select: 'name email phone' },
      { path: 'createdBy', select: 'fullName' }
    ]);

    ActivityLog.logActivity({
      action: 'Job Created',
      description: `Job ${job.title} was created`,
      entityType: 'job',
      entityId: job._id,
      entityName: job.title,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create job) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Job created successfully',
      data: {
        job
      }
    });

  } catch (error) {
    console.error('Create job error:', error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Server error while creating job'
    });
  }
});

// @route   PUT /api/jobs/:id
// @desc    Update job
// @access  Private
router.put('/:id', protect, requirePermission('Jobs: Create & Edit'), jobValidation, validate, async (req, res) => {
  try {
    const findQuery = { _id: req.params.id, ...jobScope(req.user) };
    const job = await Job.findOne(findQuery);

    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found'
      });
    }

    // Edit restrictions. A cancelled job is closed. Once the job is billed
    // (a live invoice exists) or finished, what is billed — customer, items,
    // design charge, estimate, paper and sheets — can no longer change here:
    // the invoice and the stock taken for it would stop matching. Priority,
    // delivery date, title and instructions stay editable.
    if (job.status === 'cancelled') {
      return res.status(409).json({ status: 'error', code: 'JOB_CANCELLED', message: 'This job is cancelled and can no longer be edited.' });
    }
    const Invoice = require('../models/Invoice');
    const liveInvoice = await Invoice.findOne({ jobId: job._id, status: { $ne: 'cancelled' } }).select('invoiceNumber').lean();
    const finished = ['completed', 'delivered'].includes(job.status);
    if (liveInvoice || finished) {
      const changed = billedFieldsChanged(job, req.body);
      if (changed.length) {
        const why = liveInvoice ? `it is billed on invoice ${liveInvoice.invoiceNumber}` : `it is ${job.status}`;
        return res.status(409).json({
          status: 'error',
          code: liveInvoice ? 'JOB_INVOICED' : 'JOB_FINISHED',
          message: `${changed.join(', ')} cannot be changed because ${why}. ${liveInvoice ? 'Cancel the invoice first, or raise a credit/debit note.' : 'Reopen the job first.'}`,
          fields: changed
        });
      }
    }

    // Check customer if customerId is being updated
    if (req.body.customerId && String(req.body.customerId) !== String(job.customerId)) {
      const customerQuery = req.user.dataScope
        ? { _id: req.body.customerId, dataScope: req.user.dataScope, status: 'active' }
        : { _id: req.body.customerId, userId: req.user._id, status: 'active' };
      const customer = await Customer.findOne(customerQuery);
      
      if (!customer) {
        return res.status(400).json({
          status: 'error',
          message: 'Customer not found or inactive'
        });
      }
    }

    // Prepare update data. Who created the job and which business it belongs
    // to never change on an edit, whoever makes it.
    const { userId: _userId, createdBy: _createdBy, dataScope: _dataScope, _id: _jobId, ...changes } = req.body;
    const updateData = {
      ...changes,
      // Explicitly handle items array
      items: req.body.items !== undefined ? jobItems(req.body.items) : job.items,
      // Explicitly handle design charge
      designCharge: req.body.designCharge !== undefined ? req.body.designCharge : job.designCharge
    };

    // Update job
    const updatedJob = await Job.findOneAndUpdate(
      findQuery,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('customerId', 'name email phone')
      .populate('createdBy', 'fullName');

    ActivityLog.logActivity({
      action: 'Job Updated',
      description: `Job ${updatedJob.title} was updated`,
      entityType: 'job',
      entityId: updatedJob._id,
      entityName: updatedJob.title,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update job) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Job updated successfully',
      data: {
        job: updatedJob
      }
    });

  } catch (error) {
    console.error('Update job error:', error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Server error while updating job'
    });
  }
});

// @route   DELETE /api/jobs/:id
// @desc    Delete job (hard delete)
// @access  Private
router.delete('/:id', protect, requirePermission('Jobs: Delete'), async (req, res) => {
  try {
    const findQuery = { _id: req.params.id, ...jobScope(req.user) };
    const job = await Job.findOne(findQuery);
    
    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found'
      });
    }

    // Hard delete - actually remove from database
    await Job.deleteOne(findQuery);

    ActivityLog.logActivity({
      action: 'Job Deleted',
      description: `Job ${job.title} was deleted`,
      entityType: 'job',
      entityId: job._id,
      entityName: job.title,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (delete job) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Job deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting job'
    });
  }
});

// @route   POST /api/jobs/:id/update-status
// @desc    Update job status
// @access  Private
router.post('/:id/update-status', protect, requirePermission('Jobs: Change Status'), [
  body('status').isIn([
    'inquiry', 'quotation_sent', 'quotation_approved', 'design_in_progress',
    'design_approved', 'production_ready', 'ready_for_print', 'quality_check',
    'completed', 'delivered', 'cancelled'
  ]).withMessage('Invalid status provided'),
  body('remarks').optional({ values: 'falsy' }).trim(),
], validate, async (req, res) => {
  try {
    const { status, remarks } = req.body;

    const findQuery = { _id: req.params.id, ...jobScope(req.user) };
    const job = await Job.findOne(findQuery);

    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found'
      });
    }

    job.status = status;
    
    // Add to flow history if status change affects flow stage
    const flowStageMap = {
      'quotation_sent': 'quotation_sent',
      'quotation_approved': 'quotation_approved',
      'design_in_progress': 'design_in_progress',
      'design_approved': 'design_approved',
      'production_ready': 'production_ready',
      'ready_for_print': 'ready_for_print',
      'quality_check': 'quality_check',
      'completed': 'job_complete',
      'delivered': 'product_received'
    };

    if (flowStageMap[status]) {
      job.flowStage = flowStageMap[status];
      job.flowHistory.push({
        stage: flowStageMap[status],
        handlerName: req.user.fullName,
        remarks: remarks || `Status changed to ${status}`,
        updatedBy: req.user._id
      });
      
      if (status === 'completed') {
        job.completionDate = new Date();
      }
    }

    await job.save();
    
    await job.populate([
      { path: 'customerId', select: 'name email phone' },
      { path: 'assignedTo.handlerId', select: 'fullName' }
    ]);

    ActivityLog.logActivity({
      action: 'Job Status Updated',
      description: `Job ${job.title} status was changed to ${status}`,
      entityType: 'job',
      entityId: job._id,
      entityName: job.title,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (job status update) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Job status updated successfully',
      data: {
        job
      }
    });
    
  } catch (error) {
    console.error('Update job status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating job status'
    });
  }
});

// @route   POST /api/jobs/:id/assign
// @desc    Assign job to operator
// @access  Private
router.post('/:id/assign', protect, [
  body('operatorId').isMongoId().withMessage('Valid operator ID is required'),
  body('operatorName').notEmpty().withMessage('Operator name is required').trim(),
], validate, async (req, res) => {
  try {
    const { operatorId, operatorName } = req.body;

    const findQuery = { _id: req.params.id, ...jobScope(req.user) };
    const job = await Job.findOne(findQuery);

    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found'
      });
    }

    // The handler has to be someone in this business.
    if (!(await isSameOrgUser(req.user, operatorId))) {
      return res.status(400).json({
        status: 'error',
        message: 'Choose a handler from your team'
      });
    }

    await job.assignToOperator(operatorId, operatorName);
    await notify({
      recipients: [operatorId],
      actor: req.user,
      type: 'job_assigned',
      title: `Job handed to you: ${job.title}`,
      message: `${req.user.fullName} made you the handler for this job.`,
      link: `/jobs?q=${encodeURIComponent(job.title)}`,
      entityType: 'job',
      entityId: job._id
    });
    
    // Update flow to "job_handler_assigned" if not already assigned
    if (job.flowStage === 'customer_inquiry') {
      await job.updateFlowStage(
        'job_handler_assigned',
        operatorName,
        `Job assigned to ${operatorName}`,
        req.user._id
      );
    }
    
    await job.populate([
      { path: 'assignedOperator', select: 'fullName' },
      { path: 'customerId', select: 'name email' }
    ]);

    ActivityLog.logActivity({
      action: 'Job Assigned',
      description: `Job ${job.title} was assigned to ${operatorName}`,
      entityType: 'job',
      entityId: job._id,
      entityName: job.title,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'assign',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (job assign) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Job assigned successfully',
      data: {
        job
      }
    });
    
  } catch (error) {
    console.error('Assign job error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while assigning job'
    });
  }
});

// @route   POST /api/jobs/:id/update-flow-stage
// @desc    Update job flow stage
// @access  Private
router.post('/:id/update-flow-stage', protect, [
  body('stage').isIn([
    'customer_inquiry', 'job_handler_assigned', 'accountant_review',
    'quotation_sent', 'quotation_approved', 'design_in_progress',
    'design_approved', 'production_ready', 'ready_for_print',
    'quality_check', 'payment_pending', 'payment_collected',
    'job_complete', 'product_received', 'exited'
  ]).withMessage('Invalid flow stage provided'),
  body('remarks').optional({ values: 'falsy' }).trim(),
], validate, async (req, res) => {
  try {
    const { stage, remarks } = req.body;

    const findQuery = { _id: req.params.id, ...jobScope(req.user) };
    const job = await Job.findOne(findQuery);

    if (!job) {
      return res.status(404).json({
        status: 'error',
        message: 'Job not found'
      });
    }

    await job.updateFlowStage(
      stage,
      req.user.fullName,
      remarks || `Flow stage updated to ${stage}`,
      req.user._id
    );
    
    await job.populate([
      { path: 'customerId', select: 'name email phone' },
      { path: 'assignedTo.handlerId', select: 'fullName' }
    ]);

    ActivityLog.logActivity({
      action: 'Job Flow Stage Updated',
      description: `Job ${job.title} flow stage was changed to ${stage}`,
      entityType: 'job',
      entityId: job._id,
      entityName: job.title,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (job flow stage update) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Job flow stage updated successfully',
      data: {
        job
      }
    });
    
  } catch (error) {
    console.error('Update flow stage error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating flow stage'
    });
  }
});

// @route   GET /api/jobs/stats/dashboard
// @desc    Get job statistics for dashboard
// @access  Private
router.get('/stats/dashboard', protect, async (req, res) => {
  try {
    console.log('Getting job stats for dashboard');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const mongoose = require('mongoose');
    const stats = await Job.aggregate([
      // FIXED: Filter by dataScope if available, fallback to userId
      {
        $match: jobScope(req.user)
      },
      {
        $facet: {
          totalJobs: [{ $count: "count" }],
          todayJobs: [
            { $match: { createdAt: { $gte: today, $lt: tomorrow } } },
            { $count: "count" }
          ],
          completedToday: [
            {
              $match: {
                status: 'completed',
                completionDate: { $gte: today, $lt: tomorrow }
              }
            },
            { $count: "count" }
          ],
          urgentJobs: [
            { $match: { priority: 'urgent', status: { $nin: ['completed', 'delivered', 'cancelled'] } } },
            { $count: "count" }
          ],
          inProgressJobs: [
            { $match: { status: { $in: ['design_in_progress', 'production_ready', 'ready_for_print'] } } },
            { $count: "count" }
          ],
          monthlyRevenue: [
            {
              $match: {
                status: 'completed',
                completionDate: { $gte: monthStart }
              }
            },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: '$estimatedCost' }
              }
            }
          ]
        }
      }
    ]);

    const result = {
      totalJobs: stats[0].totalJobs[0]?.count || 0,
      todayJobs: stats[0].todayJobs[0]?.count || 0,
      completedToday: stats[0].completedToday[0]?.count || 0,
      urgentJobs: stats[0].urgentJobs[0]?.count || 0,
      inProgressJobs: stats[0].inProgressJobs[0]?.count || 0,
      monthlyRevenue: stats[0].monthlyRevenue[0]?.totalRevenue || 0
    };

    res.status(200).json({
      status: 'success',
      data: {
        stats: result
      }
    });
    
  } catch (error) {
    console.error('Get job stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching job statistics'
    });
  }
});

// @route   GET /api/jobs/calendar-status
// @desc    Get job completion status for calendar by month
// @access  Private
router.get('/calendar-status', protect, async (req, res) => {
  try {
    const { year, month } = req.query;

    if (!year || !month) {
      return res.status(400).json({
        status: 'error',
        message: 'Year and month are required'
      });
    }

    const startDate = new Date(parseInt(year), parseInt(month), 1);
    const endDate = new Date(parseInt(year), parseInt(month) + 1, 0, 23, 59, 59);

    const mongoose = require('mongoose');

    // Get all jobs created in the specified month, grouped by creation date
    const jobsByDate = await Job.aggregate([
      {
        $match: { ...jobScope(req.user), createdAt: { $gte: startDate, $lte: endDate } }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          totalJobs: { $sum: 1 },
          completedJobs: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] }
          }
        }
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          totalJobs: 1,
          completedJobs: 1,
          allCompleted: { $eq: ["$totalJobs", "$completedJobs"] }
        }
      }
    ]);

    // Convert to object for easier lookup
    const statusByDate = {};
    jobsByDate.forEach(item => {
      const day = new Date(item.date).getDate();
      statusByDate[day] = {
        totalJobs: item.totalJobs,
        completedJobs: item.completedJobs,
        allCompleted: item.allCompleted
      };
    });

    res.status(200).json({
      status: 'success',
      data: { statusByDate }
    });

  } catch (error) {
    console.error('Get calendar status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching calendar status'
    });
  }
});

module.exports = router;
