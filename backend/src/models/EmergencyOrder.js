const mongoose = require('mongoose');

const STATUSES = ['pending', 'in_progress', 'completed', 'converted', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** A rush (emergency) order: urgent work taken on the spot, before or instead of a full job. */
const emergencyOrderSchema = new mongoose.Schema({
  // Generated in pre('validate'): RO-2026-00001.
  orderId: {
    type: String,
    unique: true,
    required: [true, 'Order ID is required'],
    trim: true
  },
  // The customer record it was taken for, when one was picked (or created on conversion).
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  customerName: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true
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
  orderDetails: {
    type: String,
    required: [true, 'Order details are required'],
    trim: true
  },
  estimatedAmount: {
    type: Number,
    required: [true, 'Estimated amount is required'],
    min: [0, 'Estimated amount cannot be negative']
  },
  // Money taken up front.
  advancePaid: {
    type: Number,
    min: [0, 'Advance cannot be negative'],
    default: 0
  },
  priority: {
    type: String,
    enum: PRIORITIES,
    default: 'high'
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'pending'
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // logins are the staff
  },
  notes: {
    type: String,
    trim: true
  },
  specialInstructions: {
    type: String,
    trim: true
  },
  deliveryRequired: {
    type: Boolean,
    default: false
  },
  deliveryAddress: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    landmark: String
  },
  paymentMethod: {
    type: String,
    enum: ['COD', 'Prepaid', 'Partial'],
    default: 'COD'
  },
  // When the customer needs it by (date and time).
  expectedCompletion: {
    type: Date
  },
  startedAt: {
    type: Date
  },
  actualCompletion: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  cancelReason: {
    type: String,
    trim: true
  },
  convertedAt: {
    type: Date
  },
  conversionNotes: {
    type: String,
    trim: true
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
  timestamps: true
});

// Indexes
emergencyOrderSchema.index({ userId: 1, status: 1 });
emergencyOrderSchema.index({ userId: 1, priority: 1 });
emergencyOrderSchema.index({ userId: 1, createdAt: -1 });
emergencyOrderSchema.index({ userId: 1, customerPhone: 1 });
emergencyOrderSchema.index({ dataScope: 1, status: 1, expectedCompletion: 1 });

// Virtual for full address
emergencyOrderSchema.virtual('fullAddress').get(function() {
  const addr = this.deliveryAddress;
  if (!addr) return '';

  const parts = [addr.street, addr.city, addr.state, addr.pincode].filter(Boolean);
  return parts.join(', ');
});

// Virtual for urgency color
emergencyOrderSchema.virtual('urgencyColor').get(function() {
  const urgencyColors = {
    low: 'green',
    medium: 'blue',
    high: 'orange',
    urgent: 'red'
  };
  return urgencyColors[this.priority] || 'blue';
});

// Virtual for is overdue: still open after its needed-by time.
emergencyOrderSchema.virtual('isOverdue').get(function() {
  if (!this.expectedCompletion || !['pending', 'in_progress'].includes(this.status)) return false;
  return new Date() > this.expectedCompletion;
});

/**
 * The next order number for this year: RO-2026-00001. The index on orderId is
 * unique across every business, so the sequence is global.
 */
emergencyOrderSchema.statics.nextOrderId = async function(date = new Date()) {
  const prefix = `RO-${date.getFullYear()}-`;
  const last = await this.findOne({ orderId: { $regex: `^${prefix}\\d+$` } })
    .sort({ orderId: -1 })
    .select('orderId')
    .lean();
  const n = last ? parseInt(last.orderId.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(n).padStart(5, '0')}`;
};

/** Saves a new order, trying once more with a fresh number if two were created at once. */
emergencyOrderSchema.statics.createNumbered = async function(data) {
  try {
    return await this.create(data);
  } catch (error) {
    if (error.code === 11000 && error.keyPattern && error.keyPattern.orderId && !data.orderId) {
      return this.create(data);
    }
    throw error;
  }
};

emergencyOrderSchema.pre('validate', async function() {
  if (!this.orderId) {
    this.orderId = await this.constructor.nextOrderId();
  }
});

// Static method to get orders by status
emergencyOrderSchema.statics.getOrdersByStatus = function(userId, status) {
  return this.find({ userId, status }).sort({ createdAt: -1 });
};

// Static method to get urgent orders
emergencyOrderSchema.statics.getUrgentOrders = function(userId) {
  return this.find({
    userId,
    priority: 'urgent',
    status: { $in: ['pending', 'in_progress'] }
  }).sort({ createdAt: -1 });
};

// Static method to get today's orders
emergencyOrderSchema.statics.getTodaysOrders = function(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return this.find({
    userId,
    createdAt: { $gte: today, $lt: tomorrow }
  }).sort({ createdAt: -1 });
};

// Static method to get order statistics
emergencyOrderSchema.statics.getOrderStats = function(userId) {
  return this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$estimatedAmount' }
      }
    }
  ]);
};

// Static method to get orders by priority
emergencyOrderSchema.statics.getOrdersByPriority = function(userId, priority) {
  return this.find({ userId, priority }).sort({ createdAt: -1 });
};

emergencyOrderSchema.statics.STATUSES = STATUSES;
emergencyOrderSchema.statics.PRIORITIES = PRIORITIES;

module.exports = mongoose.model('EmergencyOrder', emergencyOrderSchema);
