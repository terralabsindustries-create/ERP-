const mongoose = require('mongoose');

const STATUSES = ['scheduled', 'in_transit', 'delivered', 'failed', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const TIME_SLOTS = ['Morning (9AM-12PM)', 'Afternoon (12PM-3PM)', 'Evening (3PM-6PM)', 'Flexible'];
const PAYMENT_METHODS = ['Prepaid', 'COD', 'Partial'];

/** One step in a delivery's life: scheduled, dispatched, delivered, failed… */
const historySchema = new mongoose.Schema({
  status: { type: String, enum: STATUSES, required: true },
  at: { type: Date, default: Date.now },
  byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
  note: String
}, { _id: false });

const deliverySchema = new mongoose.Schema({
  // Also the delivery challan number. Generated in pre('validate').
  deliveryId: {
    type: String,
    unique: true,
    required: [true, 'Delivery ID is required'],
    trim: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: [true, 'Job ID is required']
  },
  // Kept with the delivery so the list, search and challan still read well if
  // the job is renamed or deleted later.
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
  deliveryAddress: {
    street: {
      type: String,
      required: [true, 'Street address is required'],
      trim: true
    },
    city: {
      type: String,
      required: [true, 'City is required'],
      trim: true
    },
    state: {
      type: String,
      required: [true, 'State is required'],
      trim: true
    },
    pincode: {
      type: String,
      required: [true, 'Pincode is required'],
      trim: true,
      match: [/^\d{6}$/, 'Pincode must be 6 digits']
    },
    landmark: { type: String, trim: true },
    instructions: { type: String, trim: true }
  },
  contactInfo: {
    name: { type: String, trim: true },
    phone: {
      type: String,
      required: [true, 'Contact phone is required'],
      trim: true
    },
    alternatePhone: { type: String, trim: true },
    email: { type: String, trim: true }
  },
  // A calendar date, stored as midnight UTC of that date (time of day is the slot).
  deliveryDate: {
    type: Date,
    required: [true, 'Delivery date is required']
  },
  deliveryTimeSlot: {
    type: String,
    enum: TIME_SLOTS,
    default: 'Flexible'
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'scheduled'
  },
  priority: {
    type: String,
    enum: PRIORITIES,
    default: 'medium'
  },
  driverInfo: {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    vehicleNumber: { type: String, trim: true, uppercase: true },
    licenseNumber: { type: String, trim: true }
  },
  items: [{
    description: { type: String, trim: true, required: [true, 'Describe each package'] },
    quantity: {
      type: Number,
      min: [1, 'Quantity must be at least 1'],
      default: 1
    },
    weight: Number,
    dimensions: {
      length: Number,
      width: Number,
      height: Number
    }
  }],
  // A courier's tracking / AWB number, when it goes by courier.
  trackingNumber: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },
  deliveryNotes: {
    type: String,
    trim: true
  },
  dispatchedAt: Date,
  deliveryProof: {
    signature: String,
    photo: String,
    deliveredBy: String,
    receivedBy: { type: String, trim: true },
    deliveredAt: Date,
    note: { type: String, trim: true }
  },
  failureReason: { type: String, trim: true },
  cancelledAt: Date,
  cancelReason: { type: String, trim: true },
  charges: {
    deliveryFee: {
      type: Number,
      min: [0, 'Delivery fee cannot be negative'],
      default: 0
    },
    codCharges: {
      type: Number,
      min: [0, 'COD charges cannot be negative'],
      default: 0
    },
    totalCharges: {
      type: Number,
      min: [0, 'Total charges cannot be negative'],
      default: 0
    }
  },
  paymentMethod: {
    type: String,
    enum: PAYMENT_METHODS,
    default: 'Prepaid'
  },
  // Amount the driver collects on delivery (COD only).
  codAmount: {
    type: Number,
    min: [0, 'COD amount cannot be negative'],
    default: 0
  },
  // Times the delivery was rescheduled after a failed attempt.
  attempts: {
    type: Number,
    min: [0, 'Attempts cannot be negative'],
    default: 0
  },
  lastAttemptDate: Date,
  rescheduleReason: String,
  history: [historySchema],
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
  timestamps: true
});

// Indexes
deliverySchema.index({ userId: 1, status: 1 });
deliverySchema.index({ userId: 1, deliveryDate: 1 });
deliverySchema.index({ userId: 1, customerId: 1 });
deliverySchema.index({ userId: 1, jobId: 1 });
deliverySchema.index({ userId: 1, priority: 1 });
deliverySchema.index({ dataScope: 1, status: 1, deliveryDate: 1 });
deliverySchema.index({ customerId: 1, deliveryDate: -1 });

// Virtual for full address
deliverySchema.virtual('fullAddress').get(function () {
  const addr = this.deliveryAddress || {};
  const parts = [addr.street, addr.city, addr.state, addr.pincode].filter(Boolean);
  return parts.join(', ');
});

// Virtual for delivery status color
deliverySchema.virtual('statusColor').get(function () {
  const statusColors = {
    scheduled: 'blue',
    in_transit: 'orange',
    delivered: 'green',
    failed: 'red',
    cancelled: 'gray'
  };
  return statusColors[this.status] || 'gray';
});

// Virtual for is overdue: still open after its delivery day has ended.
deliverySchema.virtual('isOverdue').get(function () {
  if (!['scheduled', 'in_transit'].includes(this.status) || !this.deliveryDate) return false;
  return Date.now() >= this.deliveryDate.getTime() + 864e5;
});

/**
 * The next challan number for this year: DLV-2026-00001. The index on
 * deliveryId is unique across every business, so the sequence is global.
 */
deliverySchema.statics.nextDeliveryId = async function (date = new Date()) {
  const prefix = `DLV-${date.getFullYear()}-`;
  const last = await this.findOne({ deliveryId: { $regex: `^${prefix}\\d+$` } })
    .sort({ deliveryId: -1 })
    .select('deliveryId')
    .lean();
  const n = last ? parseInt(last.deliveryId.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(5, '0')}`;
};

/** Saves a new delivery, trying once more with a fresh number if two were created at once. */
deliverySchema.statics.createNumbered = async function (data) {
  try {
    return await this.create(data);
  } catch (error) {
    if (error.code === 11000 && error.keyPattern && error.keyPattern.deliveryId && !data.deliveryId) {
      return this.create(data);
    }
    throw error;
  }
};

deliverySchema.pre('validate', async function () {
  if (this.charges) {
    this.charges.totalCharges = (this.charges.deliveryFee || 0) + (this.charges.codCharges || 0);
  }
  if (this.paymentMethod === 'Prepaid') this.codAmount = 0;
  if (!this.deliveryId) {
    this.deliveryId = await this.constructor.nextDeliveryId();
  }
});

// Static method to get deliveries by status
deliverySchema.statics.getDeliveriesByStatus = function (userId, status) {
  return this.find({ userId, status })
    .populate('jobId', 'title')
    .populate('customerId', 'name phone');
};

// Static method to get today's deliveries
deliverySchema.statics.getTodaysDeliveries = function (userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return this.find({
    userId,
    deliveryDate: { $gte: today, $lt: tomorrow }
  }).populate('jobId', 'title').populate('customerId', 'name phone');
};

// Static method to get overdue deliveries
deliverySchema.statics.getOverdueDeliveries = function (userId) {
  return this.find({
    userId,
    status: { $in: ['scheduled', 'in_transit'] },
    deliveryDate: { $lt: new Date() }
  }).populate('jobId', 'title').populate('customerId', 'name phone');
};

// Static method to get delivery statistics
deliverySchema.statics.getDeliveryStats = function (userId) {
  return this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalCharges: { $sum: '$charges.totalCharges' }
      }
    }
  ]);
};

deliverySchema.statics.STATUSES = STATUSES;
deliverySchema.statics.PRIORITIES = PRIORITIES;
deliverySchema.statics.TIME_SLOTS = TIME_SLOTS;
deliverySchema.statics.PAYMENT_METHODS = PAYMENT_METHODS;

module.exports = mongoose.model('Delivery', deliverySchema);
