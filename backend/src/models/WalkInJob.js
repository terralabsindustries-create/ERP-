const mongoose = require('mongoose');

/**
 * A counter job: a customer walks in, the job is taken at the front desk, made
 * while they wait or the same day, billed and collected.
 *
 *   waiting → in_progress → quality_check → ready → collected
 *                    └──────────────────────┘ (quality check can be skipped)
 *   any open job → cancelled (and back to waiting to reopen it)
 */
const STATUSES = ['waiting', 'in_progress', 'quality_check', 'ready', 'collected', 'cancelled'];
/** Taken and not finished yet: the production queue. */
const QUEUE_STATUSES = ['waiting', 'in_progress', 'quality_check'];
const JOB_TYPES = ['printing', 'photocopy', 'large_format', 'design', 'binding', 'lamination', 'cutting', 'scanning', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const COLOR_MODES = ['black_white', 'color'];
const SIDES = ['single', 'double'];
const FINISHING = ['lamination', 'cutting', 'folding', 'creasing', 'stapling', 'spiral_binding', 'binding', 'perforation'];
/** Methods an advance can be taken in; the same values the payments API accepts. */
const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque'];

/**
 * Where a job may go next through the status endpoint. Quality check results
 * (pass → ready, fail → back to in progress) go through the quality check
 * endpoint so the result and its note are always recorded.
 */
const TRANSITIONS = {
  waiting: ['in_progress', 'cancelled'],
  in_progress: ['waiting', 'quality_check', 'ready', 'cancelled'],
  quality_check: ['in_progress', 'cancelled'],
  ready: ['collected', 'in_progress', 'cancelled'],
  collected: ['ready'],
  cancelled: ['waiting']
};

const walkInJobSchema = new mongoose.Schema({
  jobNumber: {
    type: String,
    required: [true, 'Job number is required'],
    unique: true,
    trim: true
  },
  // Set when the job is taken for a customer already in Customers, or once it
  // is billed (billing finds or creates the customer by phone).
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true,
    maxlength: [120, 'Customer name is too long']
  },
  customerPhone: {
    type: String,
    required: [true, 'Customer phone is required'],
    trim: true
  },
  customerEmail: {
    type: String,
    trim: true,
    lowercase: true
  },
  jobType: {
    type: String,
    required: [true, 'Job type is required'],
    enum: JOB_TYPES,
    default: 'printing'
  },
  description: {
    type: String,
    required: [true, 'Job description is required'],
    trim: true,
    maxlength: [500, 'Description is too long']
  },
  specifications: {
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1']
    },
    copies: {
      type: Number,
      default: 1,
      min: [1, 'Copies must be at least 1']
    },
    paperSize: { type: String, trim: true },
    paperType: { type: String, trim: true },
    colorMode: { type: String, enum: COLOR_MODES, default: 'black_white' },
    sides: { type: String, enum: SIDES, default: 'single' },
    finishing: [{ type: String, enum: FINISHING }],
    specialInstructions: { type: String, trim: true }
  },
  pricing: {
    // The price quoted at the counter, before GST. The invoice adds the tax.
    estimatedCost: { type: Number, default: 0, min: [0, 'Price cannot be negative'] },
    // Taken when the job was booked. It is recorded as a payment against the
    // invoice when the job is billed.
    advancePaid: { type: Number, default: 0, min: [0, 'Advance cannot be negative'] },
    advanceMethod: { type: String, enum: PAYMENT_METHODS, default: 'cash' }
  },
  timeline: {
    // The time the customer was told the job would be ready.
    estimatedCompletion: {
      type: Date,
      required: [true, 'Promised time is required']
    },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    startedAt: Date,
    qualityCheckAt: Date,
    // When the job first became ready for pickup — turnaround is measured to here.
    readyAt: Date,
    collectedAt: Date,
    cancelledAt: Date
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'waiting'
  },
  cancelReason: { type: String, trim: true },
  assignedTo: {
    operator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    operatorName: String,
    assignedAt: Date
  },
  qualityCheck: {
    checked: { type: Boolean, default: false },
    approved: { type: Boolean, default: false },
    checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checkedByName: String,
    checkedAt: Date,
    notes: { type: String, trim: true }
  },
  billing: {
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    invoiceNumber: String,
    // The invoice total (with GST) when it was linked.
    amount: Number,
    billedAt: Date,
    billedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    billedByName: String
  },
  // What happened to the job, newest last.
  history: [{
    _id: false,
    status: { type: String, enum: STATUSES },
    event: String,
    note: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String
  }],
  notes: {
    type: String,
    trim: true,
    maxlength: [1000, 'Notes are too long']
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

walkInJobSchema.index({ dataScope: 1, status: 1 });
walkInJobSchema.index({ dataScope: 1, createdAt: -1 });
walkInJobSchema.index({ dataScope: 1, 'billing.billedAt': -1 });
walkInJobSchema.index({ userId: 1, status: 1 });
walkInJobSchema.index({ 'billing.invoice': 1 });

/** Promised time has passed and the job is still in the queue. */
walkInJobSchema.virtual('isOverdue').get(function () {
  return QUEUE_STATUSES.includes(this.status) && !!this.timeline?.estimatedCompletion && this.timeline.estimatedCompletion < new Date();
});

/** Minutes from taking the job to it being ready, once it has been. */
walkInJobSchema.virtual('turnaroundMinutes').get(function () {
  if (!this.timeline?.readyAt || !this.createdAt) return null;
  return Math.max(0, Math.round((this.timeline.readyAt - this.createdAt) / 60000));
});

const pad = (n, len = 2) => String(n).padStart(len, '0');

/**
 * The next free number for the day, e.g. WI261013-004. Job numbers are unique
 * across every business (the index is global), so the sequence is too.
 */
walkInJobSchema.statics.nextJobNumber = async function (date = new Date()) {
  const prefix = `WI${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`;
  const taken = await this.distinct('jobNumber', { jobNumber: { $regex: `^${prefix}\\d+$` } });
  const last = taken.reduce((max, n) => Math.max(max, parseInt(n.slice(prefix.length), 10) || 0), 0);
  return `${prefix}${pad(last + 1, 3)}`;
};

// Numbered before validation: `jobNumber` is required, and validation runs
// before any pre('save') hook would get the chance to fill it in.
walkInJobSchema.pre('validate', async function () {
  if (this.isNew && !this.jobNumber) {
    this.jobNumber = await this.constructor.nextJobNumber();
  }
});

/**
 * The figures for the page's summary strip, over the jobs `scope` selects.
 * Turnaround is measured from taking the job to it being ready, over the last
 * 30 days.
 */
walkInJobSchema.statics.getCounterStats = async function (scope) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - 30 * 864e5);
  const where = (cond) => ({ $and: [scope, cond] });

  const [byStatus, todayJobs, collectedToday, overdue, unbilled, billed, turnaround] = await Promise.all([
    this.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    this.countDocuments(where({ createdAt: { $gte: today } })),
    this.countDocuments(where({ status: 'collected', 'timeline.collectedAt': { $gte: today } })),
    this.countDocuments(where({ status: { $in: QUEUE_STATUSES }, 'timeline.estimatedCompletion': { $lt: now } })),
    this.countDocuments(where({ status: { $in: ['ready', 'collected'] }, 'billing.invoice': null })),
    this.aggregate([
      { $match: where({ 'billing.billedAt': { $gte: today } }) },
      { $group: { _id: null, amount: { $sum: '$billing.amount' }, count: { $sum: 1 } } }
    ]),
    this.aggregate([
      { $match: where({ 'timeline.readyAt': { $gte: since } }) },
      { $project: { minutes: { $divide: [{ $subtract: ['$timeline.readyAt', '$createdAt'] }, 60000] } } },
      { $match: { minutes: { $gte: 0 } } },
      { $group: { _id: null, avg: { $avg: '$minutes' }, count: { $sum: 1 } } }
    ])
  ]);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of byStatus) if (row._id in counts) counts[row._id] = row.count;
  const all = Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    counts: { ...counts, all, queue: QUEUE_STATUSES.reduce((n, s) => n + counts[s], 0) },
    todayJobs,
    inQueue: QUEUE_STATUSES.reduce((n, s) => n + counts[s], 0),
    readyForPickup: counts.ready,
    collectedToday,
    overdue,
    unbilled,
    billedToday: Math.round((billed[0]?.amount || 0) * 100) / 100,
    billedTodayCount: billed[0]?.count || 0,
    avgTurnaroundMinutes: turnaround[0] ? Math.round(turnaround[0].avg) : null,
    turnaroundSample: turnaround[0]?.count || 0
  };
};

const WalkInJob = mongoose.model('WalkInJob', walkInJobSchema);

Object.assign(WalkInJob, { STATUSES, QUEUE_STATUSES, JOB_TYPES, PRIORITIES, COLOR_MODES, SIDES, FINISHING, PAYMENT_METHODS, TRANSITIONS });

module.exports = WalkInJob;
