const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const EmergencyOrder = require('../models/EmergencyOrder');
const Customer = require('../models/Customer');
const Job = require('../models/Job');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { orgMemberIds, orgScope } = require('../utils/accessScope');

const router = express.Router();

const DAY = 864e5;
const { PRIORITIES } = EmergencyOrder;
const VIEWS = ['open', 'due', 'completed', 'cancelled', 'all'];
const OPEN = ['pending', 'in_progress'];
const STATUS_LABEL = { pending: 'open', in_progress: 'in progress', completed: 'completed', converted: 'converted to a job', cancelled: 'cancelled' };
const POPULATE = [
  { path: 'jobId', select: 'title status dueDate' },
  { path: 'customerId', select: 'name phone email company' }
];

/**
 * Rush orders of the caller's business: tagged with its dataScope, or created
 * by one of its logins (records from before orders carried a dataScope).
 */
async function businessFilter(user) {
  const byMember = { userId: { $in: await orgMemberIds(user) } };
  return user.dataScope ? { $or: [{ dataScope: user.dataScope }, byMember] } : byMember;
}

const isId = (id) => mongoose.isValidObjectId(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digits = (v) => String(v || '').replace(/\D/g, '');
const validPhone = (v) => {
  const d = digits(v);
  return d.length >= 10 && d.length <= 13;
};
const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const notFound = (res) => res.status(404).json({ status: 'error', message: 'Rush order not found' });
const fail = (res, code, message) => res.status(code).json({ status: 'error', message });

const log = (req, order, action, actionType, description, severity = 'low') =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'emergency_order',
    entityId: order._id,
    entityName: order.orderId,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

// What the rush order editor sends, for both create and edit.
const orderRules = [
  body('customerId').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid customer'),
  body('customerName').trim().notEmpty().withMessage('Enter the customer name').isLength({ max: 100 }).withMessage('The customer name is too long'),
  body('customerPhone').custom(validPhone).withMessage('Enter a valid phone number'),
  body('customerEmail').optional({ values: 'falsy' }).trim().isEmail().withMessage('Enter a valid email address'),
  body('orderDetails').trim().notEmpty().withMessage('Describe what the customer needs').isLength({ max: 2000 }).withMessage('The details are too long'),
  body('estimatedAmount').isFloat({ min: 0 }).withMessage('Enter the estimated amount (zero or more)'),
  body('advancePaid')
    .optional({ values: 'falsy' })
    .isFloat({ min: 0 })
    .withMessage('The advance cannot be negative')
    .bail()
    .custom((v, { req }) => Number(v) <= Number(req.body.estimatedAmount))
    .withMessage('The advance is more than the estimated amount'),
  body('priority').optional().isIn(PRIORITIES).withMessage('Choose a priority from the list'),
  body('expectedCompletion').isISO8601().withMessage('Choose when it is needed by'),
  body('notes').optional({ values: 'null' }).trim().isLength({ max: 1000 }).withMessage('Notes are too long'),
  body('specialInstructions').optional({ values: 'null' }).trim().isLength({ max: 1000 }).withMessage('Instructions are too long')
];

/** The fields a person may set on a rush order, taken from the request body. */
const detailsFrom = (b) => ({
  customerName: clean(b.customerName),
  customerPhone: clean(b.customerPhone),
  customerEmail: clean(b.customerEmail) || undefined,
  orderDetails: clean(b.orderDetails),
  estimatedAmount: Number(b.estimatedAmount),
  advancePaid: Number(b.advancePaid) || 0,
  priority: b.priority || 'high',
  expectedCompletion: new Date(b.expectedCompletion),
  notes: clean(b.notes) || undefined,
  specialInstructions: clean(b.specialInstructions) || undefined
});

/** The picked customer, if it belongs to the caller's business. */
async function customerFor(user, customerId) {
  if (!customerId) return { customer: null };
  const customer = await Customer.findOne({ _id: customerId, ...orgScope(user) }).select('name phone email');
  return customer ? { customer } : { error: 'Customer not found' };
}

// @route   GET /api/emergency-orders
// @desc    Rush orders of the business, by view, with the counts behind the page's views
// @access  Private (Emergency Orders)
router.get('/', protect, [
  query('view').optional().isIn(VIEWS),
  query('status').optional().isIn([...EmergencyOrder.STATUSES, 'all']),
  query('priority').optional().isIn([...PRIORITIES, 'all']),
  query('search').optional().trim().isLength({ max: 100 }),
  query('weekStart').optional().isISO8601(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const { view = 'all', status, priority, search } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const now = new Date();
    const soon = new Date(now.getTime() + DAY);
    const weekStart = req.query.weekStart ? new Date(req.query.weekStart) : new Date(now.getTime() - 7 * DAY);

    const and = [await businessFilter(req.user)];
    if (priority && priority !== 'all') and.push({ priority });
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      and.push({ $or: ['orderId', 'customerName', 'customerPhone', 'orderDetails', 'notes'].map((f) => ({ [f]: rx })) });
    }
    const base = { $and: and };

    const viewFilter = {
      open: { status: { $in: OPEN } },
      due: { status: { $in: OPEN }, expectedCompletion: { $lte: soon } },
      completed: { status: { $in: ['completed', 'converted'] } },
      cancelled: { status: 'cancelled' },
      all: {}
    };
    const viewSort = {
      open: { expectedCompletion: 1, createdAt: 1 },
      due: { expectedCompletion: 1, createdAt: 1 },
      completed: { updatedAt: -1 },
      cancelled: { updatedAt: -1 },
      all: { createdAt: -1 }
    };

    const listFilter = { $and: [...and, viewFilter[view]] };
    if (status && status !== 'all') listFilter.$and.push({ status });

    const count = (extra) => [{ $match: extra }, { $count: 'n' }];
    const [emergencyOrders, total, facets] = await Promise.all([
      EmergencyOrder.find(listFilter).populate(POPULATE).sort(viewSort[view]).skip((page - 1) * limit).limit(limit),
      EmergencyOrder.countDocuments(listFilter),
      EmergencyOrder.aggregate([
        { $match: base },
        {
          $facet: {
            all: count({}),
            open: count(viewFilter.open),
            due: count(viewFilter.due),
            overdue: count({ status: { $in: OPEN }, expectedCompletion: { $lt: now } }),
            completed: count(viewFilter.completed),
            converted: count({ status: 'converted' }),
            completedThisWeek: count({
              $or: [
                { status: 'completed', actualCompletion: { $gte: weekStart } },
                { status: 'converted', convertedAt: { $gte: weekStart } }
              ]
            }),
            cancelled: count(viewFilter.cancelled),
            openMoney: [
              { $match: viewFilter.open },
              { $group: { _id: null, estimated: { $sum: '$estimatedAmount' }, advance: { $sum: { $ifNull: ['$advancePaid', 0] } } } }
            ]
          }
        }
      ])
    ]);

    const f = facets[0] || {};
    const summary = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'openMoney').map(([k, v]) => [k, v[0]?.n || 0]));
    summary.openEstimated = f.openMoney?.[0]?.estimated || 0;
    summary.openAdvance = f.openMoney?.[0]?.advance || 0;

    res.status(200).json({
      status: 'success',
      data: {
        emergencyOrders,
        summary,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: emergencyOrders.length,
          totalEmergencyOrders: total
        }
      }
    });
  } catch (error) {
    console.error('Get emergency orders error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching rush orders' });
  }
});

// @route   GET /api/emergency-orders/stats/summary
// @desc    Rush order counts for the business
// @access  Private (Emergency Orders)
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = await businessFilter(req.user);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const where = (extra) => ({ $and: [scope, extra] });

    const [
      totalEmergencyOrders,
      todayEmergencyOrders,
      monthlyEmergencyOrders,
      pendingEmergencyOrders,
      completedEmergencyOrders,
      urgentEmergencyOrders
    ] = await Promise.all([
      EmergencyOrder.countDocuments(scope),
      EmergencyOrder.countDocuments(where({ createdAt: { $gte: today } })),
      EmergencyOrder.countDocuments(where({ createdAt: { $gte: monthStart } })),
      EmergencyOrder.countDocuments(where({ status: 'pending' })),
      EmergencyOrder.countDocuments(where({ status: 'completed' })),
      EmergencyOrder.countDocuments(where({ priority: 'urgent', status: { $in: OPEN } }))
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalEmergencyOrders,
          todayEmergencyOrders,
          monthlyEmergencyOrders,
          pendingEmergencyOrders,
          completedEmergencyOrders,
          urgentEmergencyOrders
        }
      }
    });
  } catch (error) {
    console.error('Get emergency order stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching rush order statistics' });
  }
});

// @route   GET /api/emergency-orders/:id
// @desc    One rush order
// @access  Private (Emergency Orders)
router.get('/:id', protect, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const emergencyOrder = await EmergencyOrder.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] }).populate(POPULATE);
    if (!emergencyOrder) return notFound(res);
    res.status(200).json({ status: 'success', data: { emergencyOrder } });
  } catch (error) {
    console.error('Get emergency order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching rush order' });
  }
});

// @route   POST /api/emergency-orders
// @desc    Take a rush order
// @access  Private (Emergency Orders: Create & Edit)
router.post('/', protect, orderRules, validate, async (req, res) => {
  try {
    const { customer, error } = await customerFor(req.user, req.body.customerId);
    if (error) return fail(res, 404, error);

    const emergencyOrder = await EmergencyOrder.createNumbered({
      ...detailsFrom(req.body),
      customerId: customer?._id,
      status: 'pending',
      userId: req.user._id,
      dataScope: req.user.dataScope
    });
    await emergencyOrder.populate(POPULATE);

    log(req, emergencyOrder, 'Emergency Order Created', 'create', `Rush order ${emergencyOrder.orderId} for ${emergencyOrder.customerName} was taken`);

    res.status(201).json({ status: 'success', message: 'Rush order added', data: { emergencyOrder } });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return fail(res, 400, Object.values(error.errors)[0]?.message || 'Invalid rush order');
    }
    console.error('Create emergency order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating rush order' });
  }
});

// @route   PUT /api/emergency-orders/:id
// @desc    Edit a rush order's details (not its status)
// @access  Private (Emergency Orders: Create & Edit)
router.put('/:id', protect, orderRules, validate, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const emergencyOrder = await EmergencyOrder.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!emergencyOrder) return notFound(res);
    if (['converted', 'cancelled'].includes(emergencyOrder.status)) {
      return fail(res, 409, `A rush order that is ${STATUS_LABEL[emergencyOrder.status]} can't be edited`);
    }

    const { customer, error } = await customerFor(req.user, req.body.customerId);
    if (error) return fail(res, 404, error);

    emergencyOrder.set({ ...detailsFrom(req.body), customerId: customer?._id });
    if (!customer) emergencyOrder.customerId = undefined;
    await emergencyOrder.save();
    await emergencyOrder.populate(POPULATE);

    log(req, emergencyOrder, 'Emergency Order Updated', 'update', `Rush order ${emergencyOrder.orderId} was updated`);

    res.status(200).json({ status: 'success', message: 'Rush order updated', data: { emergencyOrder } });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return fail(res, 400, Object.values(error.errors)[0]?.message || 'Invalid rush order');
    }
    console.error('Update emergency order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating rush order' });
  }
});

// @route   DELETE /api/emergency-orders/:id
// @desc    Delete a rush order (a job it was converted to stays)
// @access  Private (Emergency Orders: Create & Edit)
router.delete('/:id', protect, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const emergencyOrder = await EmergencyOrder.findOneAndDelete({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!emergencyOrder) return notFound(res);

    log(req, emergencyOrder, 'Emergency Order Deleted', 'delete', `Rush order ${emergencyOrder.orderId} for ${emergencyOrder.customerName} was deleted`, 'high');

    res.status(200).json({ status: 'success', message: 'Rush order deleted' });
  } catch (error) {
    console.error('Delete emergency order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting rush order' });
  }
});

// Which status an order can move to from each status. Converting goes through /convert.
const NEXT = {
  pending: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  converted: [],
  cancelled: []
};

// @route   PUT /api/emergency-orders/:id/status
// @desc    Start, complete or cancel a rush order
// @access  Private (Emergency Orders: Create & Edit)
router.put('/:id/status', protect, [
  body('status').isIn(['in_progress', 'completed', 'cancelled']).withMessage('Choose a valid status'),
  body('reason').optional({ values: 'null' }).trim().isLength({ max: 300 }).withMessage('The reason is too long'),
  body('notes').optional({ values: 'null' }).trim().isLength({ max: 1000 }).withMessage('Notes are too long')
], validate, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const emergencyOrder = await EmergencyOrder.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!emergencyOrder) return notFound(res);

    const { status } = req.body;
    const from = emergencyOrder.status;
    if (!NEXT[from].includes(status)) {
      return fail(res, 409, from === status ? `This rush order is already ${STATUS_LABEL[status]}` : `A rush order that is ${STATUS_LABEL[from]} can't be marked ${STATUS_LABEL[status]}`);
    }

    const now = new Date();
    if (status === 'in_progress') emergencyOrder.startedAt = now;
    if (status === 'completed') {
      emergencyOrder.actualCompletion = now;
      if (!emergencyOrder.startedAt) emergencyOrder.startedAt = now;
    }
    if (status === 'cancelled') {
      emergencyOrder.cancelledAt = now;
      emergencyOrder.cancelReason = clean(req.body.reason) || undefined;
    }
    if (clean(req.body.notes)) emergencyOrder.notes = clean(req.body.notes);
    emergencyOrder.status = status;
    await emergencyOrder.save();
    await emergencyOrder.populate(POPULATE);

    log(
      req,
      emergencyOrder,
      'Emergency Order Status Updated',
      status === 'completed' ? 'complete' : status === 'cancelled' ? 'cancel' : 'start',
      `Rush order ${emergencyOrder.orderId} is ${STATUS_LABEL[status]}`,
      'medium'
    );

    res.status(200).json({ status: 'success', message: 'Rush order updated', data: { emergencyOrder } });
  } catch (error) {
    console.error('Update emergency order status error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating rush order status' });
  }
});

// @route   POST /api/emergency-orders/:id/convert
// @desc    Link the job a rush order became (created through POST /api/jobs) and close the order
// @access  Private (Emergency Orders: Create & Edit)
router.post('/:id/convert', protect, [
  body('jobId').isMongoId().withMessage('Choose the job this order became'),
  body('conversionNotes').optional({ values: 'null' }).trim().isLength({ max: 500 }).withMessage('Notes are too long')
], validate, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const emergencyOrder = await EmergencyOrder.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!emergencyOrder) return notFound(res);
    if (emergencyOrder.status === 'converted' || emergencyOrder.jobId) {
      return fail(res, 409, 'This rush order is already converted to a job');
    }
    if (emergencyOrder.status === 'cancelled') return fail(res, 409, "A cancelled rush order can't be converted");

    const job = await Job.findOne({ _id: req.body.jobId, ...orgScope(req.user) }).select('title customerId');
    if (!job) return fail(res, 404, 'Job not found');

    emergencyOrder.set({
      jobId: job._id,
      customerId: job.customerId || emergencyOrder.customerId,
      status: 'converted',
      convertedAt: new Date(),
      conversionNotes: clean(req.body.conversionNotes) || undefined
    });
    await emergencyOrder.save();
    await emergencyOrder.populate(POPULATE);

    log(req, emergencyOrder, 'Emergency Order Converted', 'update', `Rush order ${emergencyOrder.orderId} was converted to job "${job.title}"`, 'medium');

    res.status(200).json({ status: 'success', message: 'Rush order converted to a job', data: { emergencyOrder } });
  } catch (error) {
    console.error('Convert emergency order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while converting rush order' });
  }
});

module.exports = router;
