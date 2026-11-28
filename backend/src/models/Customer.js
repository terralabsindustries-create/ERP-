const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true
  },
  company: {
    type: String,
    trim: true
  },
  // Walk-in and Agency are the two kinds a print shop books jobs for; the
  // others are older ways of describing a direct customer.
  customerType: {
    type: String,
    enum: ['Walk-in', 'Agency', 'Individual', 'Business', 'Corporate'],
    default: 'Individual'
  },
  gstNumber: {
    type: String,
    trim: true
  },
  // State (for GST: decides CGST+SGST or IGST). Stored as the official name.
  state: {
    type: String,
    trim: true
  },
  gstVerified: {
    type: Boolean,
    default: false
  },
  gstVerificationDate: {
    type: Date
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'blacklisted'],
    default: 'active'
  },
  isBlacklisted: {
    type: Boolean,
    default: false
  },
  blacklistReason: {
    type: String,
    trim: true
  },
  creditLimit: {
    type: Number,
    default: 0
  },
  outstandingBalance: {
    type: Number,
    default: 0
  },
  paymentStatus: {
    type: String,
    enum: ['current', 'overdue', 'bad_debt'],
    default: 'current'
  },
  lastOrderDate: {
    type: Date
  },
  lastPaymentDate: {
    type: Date
  },
  lastPaymentAmount: {
    type: Number,
    default: 0
  },
  totalOrders: {
    type: Number,
    default: 0
  },
  totalRevenue: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  // Sum of Job.estimatedCost for non-cancelled jobs. A production estimate, not revenue.
  estimatedJobValue: {
    type: Number,
    default: 0
  },
  cancelledInvoiceTotal: {
    type: Number,
    default: 0
  },
  revenueSegment: {
    type: String,
    enum: ['low', 'medium', 'high', 'premium'],
    default: 'medium'
  },
  preferredJobTypes: [{
    type: String,
    trim: true
  }],
  tags: [{
    type: String,
    trim: true
  }],
  notes: {
    type: String,
    trim: true
  },
  whatsappConsent: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true,
    description: 'Data scope for multi-tenant isolation. All users with same dataScope share this data. Optional during migration.'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
customerSchema.index({ email: 1 });
customerSchema.index({ phone: 1 });
customerSchema.index({ name: 'text', company: 'text' });
customerSchema.index({ userId: 1, status: 1 });
customerSchema.index({ dataScope: 1, status: 1 });
// Scoped list sorts (newest, by name) and search; see scripts/perf/explain.js.
customerSchema.index({ dataScope: 1, createdAt: -1 });
customerSchema.index({ dataScope: 1, name: 1 });
// Case-insensitive name order for the paged Customers list (queries use the same collation).
customerSchema.index({ dataScope: 1, name: 1 }, { name: 'customer_name_ci', collation: { locale: 'en', strength: 2 } });

// Methods
// Metrics come from services/customerFinancials.js (one definition for the
// record, list, reports and dashboard). totalRevenue is invoiced revenue (GST
// included, net of credit/debit notes, never drafts or cancelled invoices),
// NOT Job.estimatedCost; that is estimatedJobValue. totalSpent is payments
// actually received.
customerSchema.methods.updateStats = async function() {
  const { financialsOne } = require('../services/customerFinancials');
  const scope = this.dataScope ? { dataScope: this.dataScope } : { userId: this.userId };
  const f = await financialsOne(this._id, scope);

  this.totalOrders = f.totalOrders;
  this.estimatedJobValue = f.estimatedJobValue;
  this.totalRevenue = f.invoicedRevenue;
  this.totalSpent = f.paymentsReceived;
  this.cancelledInvoiceTotal = f.cancelledInvoiced;
  this.lastOrderDate = f.lastOrderDate;
  this.lastPaymentAmount = f.lastPaymentAmount;
  this.lastPaymentDate = f.lastPaymentDate;
  this.outstandingBalance = f.outstanding;

  return this.save();
};

module.exports = mongoose.model('Customer', customerSchema);
