const mongoose = require('mongoose');

/**
 * A proof: the artwork a customer must sign off before a job goes to press.
 *
 * Lifecycle: draft → sent (waiting for the customer) → approved, or
 * rejected (changes requested) → a new version is uploaded (revised, waiting
 * again) → approved. Every upload of a new version moves the current files
 * into `previousVersions`, so the history of what the customer saw is kept.
 */

const ACTIVE_STATUSES = ['sent', 'revised'];

const proofFileSchema = new mongoose.Schema({
  // The uploaded File record (routes/files.js); downloads go through it.
  fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File' },
  fileName: { type: String, required: true, trim: true },
  fileUrl: { type: String, required: true, trim: true },
  fileType: { type: String, required: true, trim: true },
  fileSize: { type: Number, required: true, min: 0 },
  mimeType: { type: String, trim: true },
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const proofSchema = new mongoose.Schema({
  proofNumber: {
    type: String,
    required: [true, 'Proof number is required'],
    unique: true,
    trim: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: [true, 'Job ID is required']
  },
  // Kept on the proof so search and the list work without a lookup.
  jobTitle: {
    type: String,
    trim: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: [true, 'Customer ID is required']
  },
  customerName: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true
  },
  customerEmail: {
    type: String,
    trim: true,
    lowercase: true
  },
  customerPhone: {
    type: String,
    trim: true
  },
  title: {
    type: String,
    required: [true, 'Proof title is required'],
    trim: true,
    maxlength: [200, 'Proof title is too long']
  },
  description: {
    type: String,
    trim: true
  },
  files: {
    type: [proofFileSchema],
    validate: {
      validator: (files) => Array.isArray(files) && files.length > 0,
      message: 'At least one file is required'
    }
  },
  specifications: {
    paperSize: { type: String, trim: true },
    paperType: { type: String, trim: true },
    colorMode: {
      type: String,
      enum: ['black_white', 'color'],
      default: 'color'
    },
    quantity: { type: Number, min: 1 },
    finishing: [{ type: String, trim: true }],
    specialInstructions: { type: String, trim: true }
  },
  status: {
    type: String,
    enum: ['draft', 'sent', 'approved', 'rejected', 'revised', 'expired'],
    default: 'draft'
  },
  version: {
    type: Number,
    default: 1,
    min: 1
  },
  // What changed in the current version (set when a new version is uploaded).
  versionNotes: {
    type: String,
    trim: true
  },
  previousVersions: [{
    version: Number,
    files: [{
      fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File' },
      fileName: String,
      fileUrl: String,
      fileType: String,
      fileSize: Number,
      mimeType: String
    }],
    uploadedAt: Date,
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    notes: String,
    // How that version ended: usually "rejected" with the customer's reason.
    status: String,
    sentAt: Date,
    rejectionReason: String,
    rejectedAt: Date
  }],
  approval: {
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired'],
      default: 'pending'
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer'
    },
    // Who at the customer signed off, and how it reached us.
    approvedByName: { type: String, trim: true },
    channel: {
      type: String,
      enum: ['whatsapp', 'email', 'phone', 'in_person', 'other']
    },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
    approvedAt: Date,
    rejectedAt: Date,
    rejectionReason: String,
    approvalNotes: String,
    // Reply-by date, set when the proof is sent (sent date + expiryDays).
    expiresAt: Date
  },
  feedback: {
    comments: [{
      comment: { type: String, trim: true },
      commentedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      commentedByName: { type: String, trim: true },
      commentedAt: {
        type: Date,
        default: Date.now
      },
      isInternal: {
        type: Boolean,
        default: true
      }
    }],
    revisions: [{
      revisionNumber: Number,
      requestedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer'
      },
      requestedAt: Date,
      description: String,
      status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed'],
        default: 'pending'
      }
    }]
  },
  notifications: {
    sentAt: Date,
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentByName: { type: String, trim: true },
    sentVia: { type: String, enum: ['whatsapp', 'email', 'in_person', 'other'] },
    reminderSentAt: Date,
    expiryReminderSentAt: Date,
    whatsappSent: {
      type: Boolean,
      default: false
    },
    emailSent: {
      type: Boolean,
      default: false
    }
  },
  settings: {
    autoExpire: {
      type: Boolean,
      default: true
    },
    expiryDays: {
      type: Number,
      default: 7,
      min: 1,
      max: 90
    },
    allowComments: {
      type: Boolean,
      default: true
    },
    requireApproval: {
      type: Boolean,
      default: true
    }
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true,
    description: 'Data scope for multi-tenant isolation. All users with same dataScope share this data.'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
proofSchema.index({ dataScope: 1, status: 1, updatedAt: -1 });
proofSchema.index({ dataScope: 1, jobId: 1 });
proofSchema.index({ dataScope: 1, 'approval.expiresAt': 1 });
proofSchema.index({ userId: 1, status: 1 });

/** Waiting for the customer and past the reply-by date. */
proofSchema.virtual('isOverdue').get(function () {
  return ACTIVE_STATUSES.includes(this.status) &&
    !!this.approval?.expiresAt &&
    new Date() > this.approval.expiresAt;
});

// Kept for older clients: same meaning as isOverdue.
proofSchema.virtual('isExpired').get(function () {
  if (!this.approval?.expiresAt) return false;
  return new Date() > this.approval.expiresAt && this.approval.status === 'pending' && ACTIVE_STATUSES.includes(this.status);
});

proofSchema.virtual('daysUntilExpiry').get(function () {
  if (!this.approval?.expiresAt || !ACTIVE_STATUSES.includes(this.status)) return null;
  return Math.ceil((this.approval.expiresAt - new Date()) / (1000 * 60 * 60 * 24));
});

const pad = (n, len = 2) => String(n).padStart(len, '0');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The next free proof number for the day, "PRF<yymmdd><nnn>". The unique index
 * covers every business, so the counter looks at every business too.
 */
proofSchema.statics.nextProofNumber = async function (date = new Date()) {
  const prefix = `PRF${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const [last] = await this.aggregate([
    { $match: { proofNumber: { $regex: `^${escapeRegex(prefix)}\\d+$` } } },
    { $project: { n: { $toInt: { $substrCP: ['$proofNumber', prefix.length, 12] } } } },
    { $sort: { n: -1 } },
    { $limit: 1 }
  ]);
  return `${prefix}${pad((last?.n || 0) + 1, 3)}`;
};

// Numbers are assigned before validation, so `required` sees them.
proofSchema.pre('validate', async function () {
  if (this.isNew && !this.proofNumber) {
    this.proofNumber = await this.constructor.nextProofNumber();
  }
});

/**
 * Create a proof, picking a fresh number again if another request took the
 * same one between the lookup and the insert.
 */
proofSchema.statics.createNumbered = async function (docOrData, attempts = 3) {
  const doc = docOrData instanceof this ? docOrData : new this(docOrData);
  for (let i = 0; ; i++) {
    try {
      return await doc.save();
    } catch (err) {
      const dupNumber = err && err.code === 11000 && (err.keyPattern?.proofNumber || /proofNumber/.test(err.message || ''));
      if (!dupNumber || i >= attempts - 1) throw err;
      doc.proofNumber = undefined; // the pre('validate') hook picks the next one
    }
  }
};

/** Mark the current version as sent to the customer and start the reply-by clock. */
proofSchema.methods.markSent = function (user, via) {
  const now = new Date();
  this.status = this.version > 1 ? 'revised' : 'sent';
  this.approval.status = 'pending';
  this.notifications.sentAt = now;
  this.notifications.sentBy = user?._id;
  this.notifications.sentByName = user?.fullName;
  if (via) this.notifications.sentVia = via;
  if (via === 'whatsapp') this.notifications.whatsappSent = true;
  if (via === 'email') this.notifications.emailSent = true;
  if (this.settings?.autoExpire !== false) {
    const days = this.settings?.expiryDays || 7;
    this.approval.expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  } else {
    this.approval.expiresAt = undefined;
  }
};

/**
 * Counts for the summary strip. `filter` is the caller's business scope.
 * "Waiting" means sent (or a revised version sent) and not yet answered.
 */
proofSchema.statics.getProofStats = async function (filter = {}) {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const and = (extra) => ({ $and: [filter, extra] });

  const [total, draft, waiting, rejected, approved, approvedThisMonth, overdue, todayProofs, monthlyProofs] = await Promise.all([
    this.countDocuments(filter),
    this.countDocuments(and({ status: 'draft' })),
    this.countDocuments(and({ status: { $in: ACTIVE_STATUSES } })),
    this.countDocuments(and({ status: 'rejected' })),
    this.countDocuments(and({ status: 'approved' })),
    this.countDocuments(and({ status: 'approved', 'approval.approvedAt': { $gte: monthStart } })),
    this.countDocuments(and({ status: { $in: ACTIVE_STATUSES }, 'approval.expiresAt': { $lt: now } })),
    this.countDocuments(and({ createdAt: { $gte: today } })),
    this.countDocuments(and({ createdAt: { $gte: monthStart } }))
  ]);

  return {
    total,
    draft,
    waiting,
    rejected,
    approved,
    approvedThisMonth,
    overdue,
    // Older names, kept for existing callers.
    totalProofs: total,
    todayProofs,
    monthlyProofs,
    pendingProofs: waiting,
    approvedProofs: approved,
    rejectedProofs: rejected,
    expiredProofs: overdue
  };
};

proofSchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;

module.exports = mongoose.model('Proof', proofSchema);
