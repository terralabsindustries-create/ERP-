const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const Delivery = require('../models/Delivery');
const Job = require('../models/Job');
const Customer = require('../models/Customer');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { userCan } = require('../middleware/requirePermission');
const { orgMemberIds, orgScope } = require('../utils/accessScope');

const router = express.Router();

const DAY = 864e5;
const { STATUSES, PRIORITIES, TIME_SLOTS } = Delivery;
const VIEWS = ['today', 'upcoming', 'in_transit', 'delivered', 'failed', 'all'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const STATUS_LABEL = { scheduled: 'scheduled', in_transit: 'in transit', delivered: 'delivered', failed: 'failed', cancelled: 'cancelled' };
const POPULATE = [
  { path: 'jobId', select: 'title status customerId' },
  { path: 'customerId', select: 'name phone email address company' }
];

/**
 * Deliveries of the caller's business: tagged with its dataScope, or created by
 * one of its logins (records from before deliveries carried a dataScope).
 */
async function businessFilter(user) {
  const byMember = { userId: { $in: await orgMemberIds(user) } };
  return user.dataScope ? { $or: [{ dataScope: user.dataScope }, byMember] } : byMember;
}

const isId = (id) => mongoose.isValidObjectId(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "2026-10-13" (or an ISO string) → midnight UTC of that calendar date. */
const dayOf = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00.000Z`);
const todayOf = (req) => dayOf(req.query.today || req.body?.today || new Date().toISOString());
const digits = (v) => String(v || '').replace(/\D/g, '');
const validPhone = (v) => {
  const d = digits(v);
  return d.length >= 10 && d.length <= 13;
};
const clean = (v) => (typeof v === 'string' ? v.trim() : v);
/** A nested part of a saved document (contactInfo, driverInfo…) as a plain object. */
const partOf = (doc, path) => ({ ...(doc.toObject()[path] || {}) });

const notFound = (res) => res.status(404).json({ status: 'error', message: 'Delivery not found' });
const fail = (res, code, message) => res.status(code).json({ status: 'error', message });

const log = (req, delivery, action, actionType, description, severity = 'low') =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'delivery',
    entityId: delivery._id,
    entityName: delivery.deliveryId,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

// What the delivery editor sends, for both create and edit.
const deliveryRules = [
  body('jobId').isMongoId().withMessage('Choose the job this delivery is for'),
  body('customerId').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid customer'),
  body('deliveryAddress.street').trim().notEmpty().withMessage('Enter the street address').isLength({ max: 300 }),
  body('deliveryAddress.city').trim().notEmpty().withMessage('Enter the city').isLength({ max: 100 }),
  body('deliveryAddress.state').trim().notEmpty().withMessage('Enter the state').isLength({ max: 100 }),
  body('deliveryAddress.pincode').trim().matches(/^\d{6}$/).withMessage('Pincode must be 6 digits'),
  body('deliveryAddress.landmark').optional({ values: 'null' }).trim().isLength({ max: 200 }),
  body('contactInfo.name').optional({ values: 'null' }).trim().isLength({ max: 100 }),
  body('contactInfo.phone').custom(validPhone).withMessage('Enter a valid contact phone number'),
  body('deliveryDate').matches(DATE_RE).withMessage('Choose the delivery date').bail().isISO8601().withMessage('Choose the delivery date'),
  body('deliveryTimeSlot').optional().isIn(TIME_SLOTS).withMessage('Choose a time slot from the list'),
  body('priority').optional().isIn(PRIORITIES).withMessage('Choose a priority from the list'),
  body('items').isArray({ min: 1, max: 50 }).withMessage('Add at least one package'),
  body('items.*.description').trim().notEmpty().withMessage('Describe each package').isLength({ max: 200 }),
  body('items.*.quantity').isInt({ min: 1, max: 1000000 }).withMessage('Each package needs a quantity of at least 1'),
  body('driverInfo.name').optional({ values: 'null' }).trim().isLength({ max: 100 }),
  body('driverInfo.phone').optional({ values: 'falsy' }).custom(validPhone).withMessage("Enter a valid driver's phone number"),
  body('driverInfo.vehicleNumber').optional({ values: 'null' }).trim().isLength({ max: 20 }),
  body('charges.deliveryFee').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Delivery charge cannot be negative'),
  body('paymentMethod').optional().isIn(['Prepaid', 'COD']).withMessage('Payment must be prepaid or cash on delivery'),
  body('codAmount')
    .if(body('paymentMethod').equals('COD'))
    .isFloat({ gt: 0 })
    .withMessage('Enter the amount to collect on delivery'),
  body('deliveryNotes').optional({ values: 'null' }).trim().isLength({ max: 1000 }).withMessage('Notes are too long'),
  body('trackingNumber').optional({ values: 'null' }).trim().isLength({ max: 60 })
];

/** The fields a person may set on a delivery, taken from the request body. */
function detailsFrom(b) {
  const cod = b.paymentMethod === 'COD';
  return {
    deliveryAddress: {
      street: clean(b.deliveryAddress.street),
      city: clean(b.deliveryAddress.city),
      state: clean(b.deliveryAddress.state),
      pincode: clean(b.deliveryAddress.pincode),
      landmark: clean(b.deliveryAddress.landmark) || undefined,
      instructions: clean(b.deliveryAddress.instructions) || undefined
    },
    contactInfo: {
      name: clean(b.contactInfo?.name) || undefined,
      phone: clean(b.contactInfo.phone)
    },
    deliveryDate: dayOf(b.deliveryDate),
    deliveryTimeSlot: b.deliveryTimeSlot || 'Flexible',
    priority: b.priority || 'medium',
    items: b.items.map((i) => ({ description: clean(i.description), quantity: Number(i.quantity) })),
    driverInfo: {
      name: clean(b.driverInfo?.name) || undefined,
      phone: clean(b.driverInfo?.phone) || undefined,
      vehicleNumber: clean(b.driverInfo?.vehicleNumber) || undefined
    },
    charges: { deliveryFee: Number(b.charges?.deliveryFee) || 0, codCharges: 0 },
    paymentMethod: cod ? 'COD' : 'Prepaid',
    codAmount: cod ? Number(b.codAmount) || 0 : 0,
    deliveryNotes: clean(b.deliveryNotes) || undefined,
    trackingNumber: clean(b.trackingNumber) || undefined
  };
}

/** The job (and its customer) a delivery is for, if both are in the caller's business. */
async function jobAndCustomer(user, jobId) {
  const job = await Job.findOne({ _id: jobId, ...orgScope(user) }).select('title customerId');
  if (!job) return { error: 'Job not found' };
  const customer = await Customer.findOne({ _id: job.customerId, ...orgScope(user) }).select('name');
  if (!customer) return { error: "This job's customer was not found" };
  return { job, customer };
}

const historyEntry = (req, status, note) => ({ status, at: new Date(), byId: req.user._id, byName: req.user.fullName, note: note || undefined });

// @route   GET /api/deliveries
// @desc    Deliveries of the business, by view, with the counts behind the page's views
// @access  Private (Delivery)
router.get('/', protect, [
  query('view').optional().isIn(VIEWS),
  query('status').optional().isIn([...STATUSES, 'all']),
  query('priority').optional().isIn([...PRIORITIES, 'all']),
  query('search').optional().trim().isLength({ max: 100 }),
  query('customerId').optional().isMongoId(),
  query('jobId').optional().isMongoId(),
  query('today').optional().matches(DATE_RE).bail().isISO8601(),
  query('weekStart').optional().isISO8601(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const { view = 'all', status, priority, search, customerId, jobId } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;
    const today = todayOf(req);
    const tomorrow = new Date(today.getTime() + DAY);
    const weekStart = req.query.weekStart ? new Date(req.query.weekStart) : new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);

    const and = [await businessFilter(req.user)];
    if (priority && priority !== 'all') and.push({ priority });
    if (customerId) and.push({ customerId: new mongoose.Types.ObjectId(customerId) });
    if (jobId) and.push({ jobId: new mongoose.Types.ObjectId(jobId) });
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      and.push({
        $or: ['deliveryId', 'customerName', 'jobTitle', 'contactInfo.name', 'contactInfo.phone', 'driverInfo.name', 'driverInfo.vehicleNumber', 'deliveryAddress.city', 'deliveryAddress.pincode', 'trackingNumber'].map((f) => ({ [f]: rx }))
      });
    }
    const base = { $and: and };

    const OPEN = { $in: ['scheduled', 'in_transit'] };
    const viewFilter = {
      today: { status: OPEN, deliveryDate: { $lt: tomorrow } },
      upcoming: { status: 'scheduled', deliveryDate: { $gte: tomorrow } },
      in_transit: { status: 'in_transit' },
      delivered: { status: 'delivered' },
      failed: { status: { $in: ['failed', 'cancelled'] } },
      all: {}
    };
    const viewSort = {
      today: { deliveryDate: 1, createdAt: 1 },
      upcoming: { deliveryDate: 1, createdAt: 1 },
      in_transit: { dispatchedAt: 1, deliveryDate: 1 },
      delivered: { 'deliveryProof.deliveredAt': -1, updatedAt: -1 },
      failed: { updatedAt: -1 },
      all: { deliveryDate: -1, createdAt: -1 }
    };

    const listFilter = { $and: [...and, viewFilter[view]] };
    if (status && status !== 'all') listFilter.$and.push({ status });

    const count = (extra) => [{ $match: extra }, { $count: 'n' }];
    const [deliveries, total, facets] = await Promise.all([
      Delivery.find(listFilter).populate(POPULATE).sort(viewSort[view]).skip((page - 1) * limit).limit(limit),
      Delivery.countDocuments(listFilter),
      Delivery.aggregate([
        { $match: base },
        {
          $facet: {
            all: count({}),
            today: count(viewFilter.today),
            overdue: count({ status: OPEN, deliveryDate: { $lt: today } }),
            upcoming: count(viewFilter.upcoming),
            in_transit: count(viewFilter.in_transit),
            delivered: count(viewFilter.delivered),
            deliveredThisWeek: count({ status: 'delivered', 'deliveryProof.deliveredAt': { $gte: weekStart } }),
            failed: count({ status: 'failed' }),
            cancelled: count({ status: 'cancelled' })
          }
        }
      ])
    ]);

    const summary = Object.fromEntries(Object.entries(facets[0] || {}).map(([k, v]) => [k, v[0]?.n || 0]));

    res.status(200).json({
      status: 'success',
      data: {
        deliveries,
        summary,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: deliveries.length,
          totalDeliveries: total
        }
      }
    });
  } catch (error) {
    console.error('Get deliveries error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching deliveries' });
  }
});

// @route   GET /api/deliveries/stats/summary
// @desc    Delivery counts for the business
// @access  Private (Delivery)
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = await businessFilter(req.user);
    const today = dayOf(new Date().toISOString());
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

    const [totalDeliveries, todayDeliveries, monthlyDeliveries, statusStats, driverStats] = await Promise.all([
      Delivery.countDocuments(scope),
      Delivery.countDocuments({ $and: [scope, { deliveryDate: { $gte: today, $lt: new Date(today.getTime() + DAY) } }] }),
      Delivery.countDocuments({ $and: [scope, { deliveryDate: { $gte: monthStart } }] }),
      Delivery.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Delivery.aggregate([
        { $match: { $and: [scope, { 'driverInfo.name': { $nin: [null, ''] } }] } },
        { $group: { _id: '$driverInfo.name', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ])
    ]);

    res.status(200).json({
      status: 'success',
      data: { stats: { totalDeliveries, todayDeliveries, monthlyDeliveries, statusStats, driverStats } }
    });
  } catch (error) {
    console.error('Get delivery stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching delivery statistics' });
  }
});

// @route   GET /api/deliveries/:id
// @desc    One delivery, with its job and customer
// @access  Private (Delivery)
router.get('/:id', protect, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const delivery = await Delivery.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] }).populate(POPULATE);
    if (!delivery) return notFound(res);
    res.status(200).json({ status: 'success', data: { delivery } });
  } catch (error) {
    console.error('Get delivery error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching delivery' });
  }
});

// @route   POST /api/deliveries
// @desc    Schedule a delivery for a job
// @access  Private (Delivery: Create & Edit)
router.post('/', protect, deliveryRules, validate, async (req, res) => {
  try {
    const { job, customer, error } = await jobAndCustomer(req.user, req.body.jobId);
    if (error) return fail(res, 404, error);

    const delivery = await Delivery.createNumbered({
      ...detailsFrom(req.body),
      jobId: job._id,
      jobTitle: job.title,
      customerId: customer._id,
      customerName: customer.name,
      status: 'scheduled',
      history: [historyEntry(req, 'scheduled', 'Scheduled')],
      userId: req.user._id,
      dataScope: req.user.dataScope
    });
    await delivery.populate(POPULATE);

    log(req, delivery, 'Delivery Created', 'create', `Delivery ${delivery.deliveryId} was scheduled for ${delivery.customerName}`);

    res.status(201).json({ status: 'success', message: 'Delivery scheduled', data: { delivery } });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return fail(res, 400, Object.values(error.errors)[0]?.message || 'Invalid delivery');
    }
    if (error.code === 11000 && error.keyPattern?.trackingNumber) {
      return fail(res, 409, 'Another delivery already has this tracking number');
    }
    console.error('Create delivery error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating delivery' });
  }
});

// @route   PUT /api/deliveries/:id
// @desc    Edit a delivery's details (not its status)
// @access  Private (Delivery: Create & Edit)
router.put('/:id', protect, deliveryRules, validate, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const delivery = await Delivery.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!delivery) return notFound(res);
    if (delivery.status === 'delivered' || delivery.status === 'cancelled') {
      return fail(res, 409, `A ${STATUS_LABEL[delivery.status]} delivery can't be edited`);
    }

    if (String(delivery.jobId) !== String(req.body.jobId)) {
      const { job, customer, error } = await jobAndCustomer(req.user, req.body.jobId);
      if (error) return fail(res, 404, error);
      delivery.set({ jobId: job._id, jobTitle: job.title, customerId: customer._id, customerName: customer.name });
    }

    const details = detailsFrom(req.body);
    // Keep fields the editor doesn't show (alternate phone, licence number…).
    details.contactInfo = { ...partOf(delivery, 'contactInfo'), ...details.contactInfo };
    details.driverInfo = { ...partOf(delivery, 'driverInfo'), ...details.driverInfo };
    delivery.set(details);
    if (!details.trackingNumber) delivery.trackingNumber = undefined;
    await delivery.save();
    await delivery.populate(POPULATE);

    log(req, delivery, 'Delivery Updated', 'update', `Delivery ${delivery.deliveryId} was updated`);

    res.status(200).json({ status: 'success', message: 'Delivery updated', data: { delivery } });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return fail(res, 400, Object.values(error.errors)[0]?.message || 'Invalid delivery');
    }
    if (error.code === 11000 && error.keyPattern?.trackingNumber) {
      return fail(res, 409, 'Another delivery already has this tracking number');
    }
    console.error('Update delivery error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating delivery' });
  }
});

// @route   DELETE /api/deliveries/:id
// @desc    Delete a delivery
// @access  Private (Delivery: Create & Edit)
router.delete('/:id', protect, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const delivery = await Delivery.findOneAndDelete({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!delivery) return notFound(res);

    log(req, delivery, 'Delivery Deleted', 'delete', `Delivery ${delivery.deliveryId} for ${delivery.customerName} was deleted`, 'high');

    res.status(200).json({ status: 'success', message: 'Delivery deleted' });
  } catch (error) {
    console.error('Delete delivery error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting delivery' });
  }
});

// Which status a delivery can move to from each status.
const NEXT = {
  scheduled: ['in_transit', 'delivered', 'failed', 'cancelled'],
  in_transit: ['delivered', 'failed', 'cancelled'],
  failed: ['scheduled', 'cancelled'],
  cancelled: ['scheduled'],
  delivered: []
};

// @route   PUT /api/deliveries/:id/status
// @desc    Dispatch, mark delivered, mark failed, reschedule or cancel
// @access  Private (Delivery: Update Status; cancelling needs Delivery: Create & Edit)
router.put('/:id/status', protect, [
  body('status').isIn(STATUSES).withMessage('Choose a valid status'),
  body('note').optional({ values: 'null' }).trim().isLength({ max: 500 }).withMessage('The note is too long'),
  body('reason').optional({ values: 'null' }).trim().isLength({ max: 300 }).withMessage('The reason is too long'),
  body('receivedBy').optional({ values: 'null' }).trim().isLength({ max: 100 }),
  body('deliveredAt').optional({ values: 'falsy' }).isISO8601().withMessage('Enter when it was delivered'),
  body('deliveryDate').optional({ values: 'falsy' }).matches(DATE_RE).withMessage('Choose the new delivery date').bail().isISO8601().withMessage('Choose the new delivery date'),
  body('deliveryTimeSlot').optional({ values: 'falsy' }).isIn(TIME_SLOTS).withMessage('Choose a time slot from the list'),
  body('today').optional({ values: 'falsy' }).matches(DATE_RE).bail().isISO8601(),
  body('driverInfo.name').optional({ values: 'null' }).trim().isLength({ max: 100 }),
  body('driverInfo.phone').optional({ values: 'falsy' }).custom(validPhone).withMessage("Enter a valid driver's phone number"),
  body('driverInfo.vehicleNumber').optional({ values: 'null' }).trim().isLength({ max: 20 })
], validate, async (req, res) => {
  try {
    if (!isId(req.params.id)) return notFound(res);
    const delivery = await Delivery.findOne({ $and: [{ _id: req.params.id }, await businessFilter(req.user)] });
    if (!delivery) return notFound(res);

    const { status } = req.body;
    const from = delivery.status;
    if (!NEXT[from].includes(status)) {
      return fail(res, 409, from === status ? `This delivery is already ${STATUS_LABEL[status]}` : `A ${STATUS_LABEL[from]} delivery can't be marked ${STATUS_LABEL[status]}`);
    }

    const now = new Date();
    const note = clean(req.body.note) || undefined;
    let historyNote = note;

    if (status === 'in_transit') {
      const d = req.body.driverInfo || {};
      const driver = partOf(delivery, 'driverInfo');
      if (clean(d.name)) driver.name = clean(d.name);
      if (clean(d.phone)) driver.phone = clean(d.phone);
      if (clean(d.vehicleNumber)) driver.vehicleNumber = clean(d.vehicleNumber);
      if (!driver.name) return fail(res, 400, 'Add the driver before dispatching');
      delivery.driverInfo = driver;
      delivery.dispatchedAt = now;
      historyNote = historyNote || `Dispatched with ${driver.name}${driver.vehicleNumber ? ` (${driver.vehicleNumber.toUpperCase()})` : ''}`;
    }

    if (status === 'delivered') {
      const receivedBy = clean(req.body.receivedBy);
      if (!receivedBy) return fail(res, 400, 'Enter who received the delivery');
      const deliveredAt = req.body.deliveredAt ? new Date(req.body.deliveredAt) : now;
      if (deliveredAt.getTime() > now.getTime() + 5 * 60e3) return fail(res, 400, "The delivery time can't be in the future");
      delivery.deliveryProof = {
        ...partOf(delivery, 'deliveryProof'),
        receivedBy,
        deliveredAt,
        deliveredBy: delivery.driverInfo?.name || undefined,
        note
      };
      historyNote = `Received by ${receivedBy}${note ? ` — ${note}` : ''}`;
    }

    if (status === 'failed') {
      const reason = clean(req.body.reason);
      if (!reason) return fail(res, 400, 'Say why the delivery failed');
      delivery.failureReason = reason;
      delivery.lastAttemptDate = now;
      historyNote = reason;
    }

    if (status === 'scheduled') {
      if (!req.body.deliveryDate) return fail(res, 400, 'Choose the new delivery date');
      const newDate = dayOf(req.body.deliveryDate);
      if (newDate < todayOf(req)) return fail(res, 400, 'The new delivery date is in the past');
      if (from === 'failed') {
        delivery.attempts = (delivery.attempts || 0) + 1;
        delivery.rescheduleReason = delivery.failureReason;
      }
      delivery.deliveryDate = newDate;
      if (req.body.deliveryTimeSlot) delivery.deliveryTimeSlot = req.body.deliveryTimeSlot;
      delivery.failureReason = undefined;
      delivery.cancelledAt = undefined;
      delivery.cancelReason = undefined;
      delivery.dispatchedAt = undefined;
      historyNote = `Rescheduled to ${req.body.deliveryDate.slice(0, 10)}${note ? ` — ${note}` : ''}`;
    }

    if (status === 'cancelled') {
      if (!userCan(req.user, 'Delivery: Create & Edit')) {
        return res.status(403).json({ status: 'error', message: 'You do not have permission to do this.', code: 'PERMISSION_DENIED', required: 'Delivery: Create & Edit' });
      }
      delivery.cancelledAt = now;
      delivery.cancelReason = clean(req.body.reason) || undefined;
      historyNote = delivery.cancelReason || note;
    }

    delivery.status = status;
    delivery.history.push(historyEntry(req, status, historyNote));
    await delivery.save();
    await delivery.populate(POPULATE);

    log(
      req,
      delivery,
      'Delivery Status Changed',
      status === 'delivered' ? 'complete' : status === 'cancelled' ? 'cancel' : 'update',
      `Delivery ${delivery.deliveryId} ${status === 'scheduled' ? 'was rescheduled' : `is ${STATUS_LABEL[status]}`}`,
      'medium'
    );

    res.status(200).json({ status: 'success', message: 'Delivery status updated', data: { delivery } });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return fail(res, 400, Object.values(error.errors)[0]?.message || 'Invalid delivery');
    }
    console.error('Update delivery status error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating delivery status' });
  }
});

module.exports = router;
