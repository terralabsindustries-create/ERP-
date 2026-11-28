const mongoose = require('mongoose');
require('./NumberSequence');

const invoiceItemSchema = new mongoose.Schema({
  // How the rate was decided (services/pricingService.js); never changes after the line is stored.
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed },
  itemName: {
    type: String,
    required: [true, 'Item name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [0.01, 'Quantity must be greater than 0']
  },
  unit: {
    type: String,
    enum: ['pieces', 'nos', 'kg', 'grams', 'meters', 'rft', 'sqft', 'sqm', 'liters', 'hours', 'days', 'sets', 'reams', 'rolls', 'sheets', 'boxes'],
    default: 'pieces'
  },
  unitPrice: {
    type: Number,
    required: [true, 'Unit price is required'],
    min: [0, 'Unit price cannot be negative']
  },
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0, 'Total amount cannot be negative']
  },
  hsnCode: {
    type: String,
    required: false,  // Made optional to support both HSN codes and SAC codes
    trim: true,
    uppercase: true
  },
  hsnDescription: {
    type: String,
    trim: true
  },
  // GST on this line (utils/billing.js gstTotals): the rate, the line's value
  // after its share of the invoice discount, and the tax on that value — split
  // into CGST + SGST within the state, or IGST between states. Lines saved
  // while invoices carried no GST (Oct–Nov 2026) have 0 in all of them.
  taxableValue: {
    type: Number,
    min: [0, 'Taxable value cannot be negative']
  },
  gstRate: {
    type: Number,
    default: 0,
    min: [0, 'GST Rate cannot be negative'],
    max: [100, 'GST Rate cannot exceed 100%']
  },
  cgstAmount: {
    type: Number,
    default: 0,
    min: [0, 'CGST amount cannot be negative']
  },
  sgstAmount: {
    type: Number,
    default: 0,
    min: [0, 'SGST amount cannot be negative']
  },
  igstAmount: {
    type: Number,
    default: 0,
    min: [0, 'IGST amount cannot be negative']
  },
  gstAmount: {
    type: Number,
    default: 0,
    min: [0, 'GST Amount cannot be negative']
  },
  itemTotal: {
    type: Number,
    required: [true, 'Item total is required'],
    min: [0, 'Item total cannot be negative']
  },
  // Area-priced lines ("Square Feet", in sq ft or sq m — see `unit`): length
  // and width of one piece, its area, and the line's total area (area per
  // piece × quantity), which is what the rate is charged on. See
  // utils/billing.js priceLine. Older lines may have a total area and no
  // dimensions, or dimensions with a quantity that was not multiplied in.
  itemType: {
    type: String,
    enum: ['Numbers', 'Square Feet'],
    default: 'Numbers'
  },
  length: {
    type: Number,
    default: 0
  },
  width: {
    type: Number,
    default: 0
  },
  areaPerPiece: {
    type: Number,
    default: 0
  },
  totalSquareFeet: {
    type: Number,
    default: 0
  },
  // What the rate was multiplied by: the total area, or the quantity.
  itemQuantity: {
    type: Number,
    default: 0
  }
});

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: {
    type: String,
    required: [true, 'Invoice number is required'],
    trim: true
    // Uniqueness is enforced per-tenant below, not globally — see the
    // dataScope/userId compound indexes. A bare `unique: true` here would make
    // it a single shared numbering sequence across every business on Terralabs ERP.
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
  customerGstNumber: {
    type: String,
    trim: true
  },
  customerAddress: {
    type: String,
    trim: true
  },
  customerState: {
    type: String,
    trim: true
  },
  customerStateCode: {
    type: String,
    trim: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  jobTitle: {
    type: String,
    trim: true
  },
  // For standalone invoices without a job or counter job. Linked work takes
  // its delivery state from the job and dispatch records instead.
  fulfillmentStatus: { type: String, enum: ['untracked', 'not_delivered', 'delivered'], default: 'untracked' },
  fulfilledAt: Date,
  fulfilledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fulfilledByName: String,
  invoiceDate: {
    type: Date,
    required: [true, 'Invoice date is required'],
    default: Date.now
  },
  dueDate: {
    type: Date,
    required: [true, 'Due date is required']
  },
  items: [invoiceItemSchema],
  // Sum of the line amounts.
  subtotal: {
    type: Number,
    required: [true, 'Subtotal is required'],
    min: [0, 'Subtotal cannot be negative']
  },
  // Design & pre-press work, billed as its own line in the totals. Older
  // invoices may instead carry it as an item named "Design Charge".
  designCharge: {
    type: Number,
    default: 0,
    min: [0, 'Design charge cannot be negative']
  },
  // The design charge's own GST, worked out like a line's (see items above).
  designChargeGstRate: { type: Number, default: 0, min: [0, 'GST Rate cannot be negative'], max: [100, 'GST Rate cannot exceed 100%'] },
  designChargeTaxableValue: { type: Number, default: 0, min: 0 },
  designChargeGstAmount: { type: Number, default: 0, min: 0 },
  designChargeCgstAmount: { type: Number, default: 0, min: 0 },
  designChargeSgstAmount: { type: Number, default: 0, min: 0 },
  designChargeIgstAmount: { type: Number, default: 0, min: 0 },
  discountAmount: {
    type: Number,
    default: 0,
    min: [0, 'Discount amount cannot be negative']
  },
  discountPercentage: {
    type: Number,
    default: 0,
    min: [0, 'Discount percentage cannot be negative'],
    max: [100, 'Discount percentage cannot exceed 100%']
  },
  // Lines + design charge − discount: the value GST is charged on, and the
  // invoice's net value (what Cost & Profit counts).
  taxableAmount: {
    type: Number,
    required: [true, 'Taxable amount is required'],
    min: [0, 'Taxable amount cannot be negative']
  },
  totalCgstAmount: {
    type: Number,
    default: 0,
    min: [0, 'Total CGST amount cannot be negative']
  },
  totalSgstAmount: {
    type: Number,
    default: 0,
    min: [0, 'Total SGST amount cannot be negative']
  },
  totalIgstAmount: {
    type: Number,
    default: 0,
    min: [0, 'Total IGST amount cannot be negative']
  },
  totalGstAmount: {
    type: Number,
    default: 0,
    min: [0, 'Total GST amount cannot be negative']
  },
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0, 'Total amount cannot be negative']
  },
  amountInWords: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'refunded'],
    default: 'draft'
  },
  /*
    Financial document lifecycle. A draft carries a DRAFT-##### identifier, not
    an official number: the official invoice number (INV-YYYYMM-####) is given
    when the invoice is issued (services/invoiceIssue.js), so abandoned drafts
    leave no gaps in the issued series. Issued invoices keep their number for
    ever; their amounts are corrected with a credit or debit note, or the
    invoice is cancelled (number kept, never reused).
  */
  issuedAt: { type: Date },
  /** The DRAFT-##### identifier the invoice had before it was issued. */
  draftNumber: { type: String, trim: true },
  /** Set while an issue is in progress (claim), cleared when it finishes. */
  issuingAt: { type: Date },
  // Cancellation keeps the invoice and its number; who, when and why are recorded.
  // (Before these fields existed the route set them but they were never stored.)
  cancelledAt: { type: Date },
  cancellationReason: { type: String, trim: true, maxlength: 500 },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  /*
    Issued credit and debit notes against this invoice (services/creditNotes.js).
    creditNoteApplied is the part of credit notes taken off what is still owed;
    credit beyond the outstanding balance stays on the note as the customer's
    credit (refund or later use) so the invoice never shows less than was paid.
  */
  creditNoteApplied: { type: Number, default: 0 },
  debitNoteTotal: { type: Number, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['pending', 'partial', 'paid', 'overdue'],
    default: 'pending'
  },
  paidAmount: {
    type: Number,
    default: 0,
    min: [0, 'Paid amount cannot be negative']
  },
  balanceAmount: {
    type: Number,
    default: 0,
    min: [0, 'Balance amount cannot be negative']
  },
  // The part of paidAmount recorded straight on the invoice rather than as
  // payments (money received before Carbon, or the old "Mark paid"). Changed
  // only by a balance correction (PATCH /invoices/:id/payment-status). Older
  // invoices lack it: there, whatever part of paidAmount no payment covers.
  manualPaidAmount: {
    type: Number,
    min: [0, 'Manual paid amount cannot be negative']
  },
  paymentTerms: {
    type: String,
    trim: true,
    default: 'Due on receipt'
  },
  notes: {
    type: String,
    trim: true
  },
  termsAndConditions: {
    type: String,
    trim: true
  },
  // isInterState: the supply is to another state, so GST is IGST rather than
  // CGST + SGST. noGst marked an older "No GST" bill; those stay visible only
  // to logins with "Invoicing (View No GST)", and new invoices never set it.
  isInterState: {
    type: Boolean,
    default: false
  },
  noGst: {
    type: Boolean,
    default: false
  },
  /**
   * Place of supply: the GST state code (e.g. "32" Kerala). Set on create from
   * what was chosen, else the customer's GSTIN, else the business's own state
   * for an intra-state supply. Read by GST reports (GSTR-1 B2CL/B2CS, 3.2).
   */
  placeOfSupply: { type: String, trim: true, match: /^\d{2}$/ },
  /** Reverse charge applies (recipient pays the tax). Shown on the invoice and in GSTR-1. */
  reverseCharge: { type: Boolean, default: false },
  companyDetails: {
    name: String,
    address: String,
    gstNumber: String,
    state: String,
    stateCode: String,
    phone: String,
    email: String,
    website: String
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true,
    description: 'Data scope for multi-tenant isolation. Optional during migration.'
  }
}, {
  timestamps: true
});

// Indexes
invoiceSchema.index({ userId: 1, customerId: 1 });
invoiceSchema.index({ userId: 1, invoiceDate: -1 });
invoiceSchema.index({ userId: 1, status: 1 });
invoiceSchema.index({ userId: 1, paymentStatus: 1 });
invoiceSchema.index({ dataScope: 1, status: 1 });
invoiceSchema.index({ dataScope: 1, paymentStatus: 1 });
// Scoped list by date, per-customer lookups (customer list totals, statements)
// and the overdue/due-soon counts; see scripts/perf/explain.js.
invoiceSchema.index({ dataScope: 1, invoiceDate: -1 });
invoiceSchema.index({ dataScope: 1, createdAt: -1 });
invoiceSchema.index({ dataScope: 1, customerId: 1, invoiceDate: -1 });
invoiceSchema.index({ dataScope: 1, dueDate: 1 });
// Job.invoices is a virtual populated by jobId (the job list, job detail).
invoiceSchema.index({ jobId: 1 });

// invoiceNumber only needs to be unique within one tenant, not across all of
// them — two businesses each having their own "INV-202608-0001" is correct,
// not a collision. Split by whether dataScope is the modern per-tenant string
// or absent (pre-dataScope accounts, scoped by userId instead).
invoiceSchema.index(
  { dataScope: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } }
);
invoiceSchema.index(
  { userId: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { dataScope: null } }
);

// Virtual for invoice status display
invoiceSchema.virtual('statusDisplay').get(function() {
  const statusMap = {
    'draft': 'Draft',
    'sent': 'Sent',
    'paid': 'Paid',
    'overdue': 'Overdue',
    'cancelled': 'Cancelled',
    'refunded': 'Refunded'
  };
  return statusMap[this.status] || this.status;
});

// Virtual for payment status display
invoiceSchema.virtual('paymentStatusDisplay').get(function() {
  const statusMap = {
    'pending': 'Pending',
    'partial': 'Partially Paid',
    'paid': 'Paid',
    'overdue': 'Overdue'
  };
  return statusMap[this.paymentStatus] || this.paymentStatus;
});

// Virtual for amountPaid (alias for paidAmount for frontend compatibility)
invoiceSchema.virtual('amountPaid').get(function() {
  return this.paidAmount;
});

// Virtual for balanceDue (alias for balanceAmount for frontend compatibility)
invoiceSchema.virtual('balanceDue').get(function() {
  return this.balanceAmount;
});

// Enable virtuals in JSON output
invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.set('toObject', { virtuals: true });

// Pre-save middleware to calculate totals
invoiceSchema.pre('save', function(next) {
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // Calculate subtotal from items. Rounded at every step: repeated float sums
  // otherwise store values like 299.96999999999997 that leak into reports.
  this.subtotal = round2(this.items.reduce((sum, item) => sum + item.totalAmount, 0));
  this.designCharge = round2(this.designCharge || 0);

  this.taxableAmount = round2(this.subtotal + this.designCharge - (this.discountAmount || 0));

  if (this.noGst) {
    // No-GST invoice: zero out every tax figure and total the taxable amount.
    this.totalCgstAmount = 0;
    this.totalSgstAmount = 0;
    this.totalIgstAmount = 0;
    this.totalGstAmount = 0;
    this.totalAmount = this.taxableAmount;
  } else {
    // Roll the tax worked out for each line and the design charge (routes
    // price them through utils/billing.js) up to the header. Recording a
    // payment re-saves the invoice, so this must keep the tax it was billed
    // with. Interstate invoices carry IGST only; intrastate CGST + SGST.
    const sum = (field) => this.items.reduce((t, item) => t + (item[field] || 0), 0);

    this.totalCgstAmount = round2(sum('cgstAmount') + (this.designChargeCgstAmount || 0));
    this.totalSgstAmount = round2(sum('sgstAmount') + (this.designChargeSgstAmount || 0));
    this.totalIgstAmount = round2(sum('igstAmount') + (this.designChargeIgstAmount || 0));
    this.totalGstAmount = round2(
      this.totalCgstAmount + this.totalSgstAmount + this.totalIgstAmount
    );
    this.totalAmount = round2(this.taxableAmount + this.totalGstAmount);
  }

  // Calculate balance amount. Rounded so a fully settled invoice reads exactly
  // 0 instead of a float residue like -0.19999999999999998.
  // The payment state always follows the money: an invoice is never saved as
  // paid while something is still due, nor left unpaid once it is settled.
  // What is owed includes issued credit notes (less) and debit notes (more).
  const { paymentStatus, status, balanceAmount } = invoiceSchema.statics.paymentStateFor(this, this.paidAmount);
  this.balanceAmount = balanceAmount;
  this.paymentStatus = paymentStatus;
  this.status = status;

  next();
});

/**
 * Payment status and invoice status that follow from a paid amount — the one
 * rule every write uses (this model's pre-save hook and services/paymentLedger).
 *
 * - paid: the total is more than 0 and the paid amount covers it. A ₹0 invoice
 *   is never "paid" by itself: nothing was received.
 * - partial: something was received, but not all of it.
 * - pending: nothing received; "overdue" set by payment reminders is kept.
 *
 * Draft, cancelled and refunded invoices keep their status; otherwise the
 * status reads "paid" exactly while the payment status does.
 */
/**
 * What the customer owes on an invoice before payments: its total, less issued
 * credit notes, plus issued debit notes (services/creditNotes.js). Never below 0.
 */
invoiceSchema.statics.receivableOf = function (invoice) {
  const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
  return Math.max(0, round2(Number(invoice.totalAmount || 0) + Number(invoice.debitNoteTotal || 0) - Number(invoice.creditNoteApplied || 0)));
};

invoiceSchema.statics.paymentStateFor = function (invoice, paidAmount) {
  const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
  const total = invoiceSchema.statics.receivableOf(invoice);
  const paid = round2(paidAmount);
  const paymentStatus = total > 0 && paid >= total - 0.005
    ? 'paid'
    : paid >= 0.005 ? 'partial' : invoice.paymentStatus === 'overdue' ? 'overdue' : 'pending';
  const fixed = ['draft', 'cancelled', 'refunded'].includes(invoice.status);
  const status = fixed ? invoice.status
    : paymentStatus === 'paid' ? 'paid'
      : invoice.status === 'paid' ? 'sent' : invoice.status;
  return { paidAmount: paid, balanceAmount: round2(total - paid), paymentStatus, status };
};

/**
 * The next invoice number of a business: INV-YYYYMM-####, counting up within
 * the month.
 *
 * Numbers come from an atomic counter (NumberSequence), so concurrent requests
 * each get their own. The counter is kept at or above the highest number
 * already used this month — invoices written before the counter existed, or
 * by older code, are never numbered over.
 *
 * Pass `session` to allocate inside a transaction: if it aborts, the number
 * goes back unused.
 */
invoiceSchema.statics.generateInvoiceNumber = async function (userId, dataScope, { session, date = new Date() } = {}) {
  const today = new Date(date);
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const scope = dataScope ? { dataScope } : { userId };

  // The business's series (models/DocumentNumbering.js); none set = INV-YYYYMM-####.
  const numbering = await mongoose.model('DocumentNumbering').findOne(dataScope ? { dataScope } : { userId }).session(session || null).lean().catch(() => null);
  const cfg = { prefix: 'INV-', reset: 'monthly', padding: 4, ...(numbering?.invoice || {}) };
  const { financialYearOf } = require('../utils/financialYear');
  const period = cfg.reset === 'financial_year' ? financialYearOf(today).code : `${year}${month}`;
  const prefix = `${cfg.prefix}${period}-`;
  const legacy = cfg.prefix === 'INV-' && cfg.reset === 'monthly';

  const [highest] = await this.aggregate([
    { $match: { ...scope, invoiceNumber: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\d+$` } } },
    { $group: { _id: null, max: { $max: { $toLong: { $substrCP: ['$invoiceNumber', prefix.length, 12] } } } } }
  ]).session(session || null);

  const NumberSequence = mongoose.model('NumberSequence');
  // The original series keeps its original counter key, so existing counters continue.
  const key = legacy ? `invoice:${dataScope || userId}:${year}${month}` : `invoice:${dataScope || userId}:${prefix}`;
  const sequence = await NumberSequence.nextAfter(key, Number(highest?.max) || 0, { session });
  return `${prefix}${String(sequence).padStart(cfg.padding || 4, '0')}`;
};

/** True when an insert failed because its invoice number is already used in the business. */
invoiceSchema.statics.isNumberTaken = (error) =>
  error?.code === 11000 && Boolean(error.keyPattern?.invoiceNumber || /invoiceNumber/.test(error.message || ''));

/**
 * Creates an invoice under the next free number of its business. If another
 * request took that number first (a unique-index collision), it numbers the
 * invoice again and retries, instead of failing.
 *
 * Inside a transaction it does not retry — the transaction is over once an
 * insert fails — and the caller starts a new transaction instead.
 */
/** True for the DRAFT-##### identifier a draft carries before it is issued. */
invoiceSchema.statics.isDraftNumber = (number) => /^DRAFT-\d+$/.test(String(number || ''));

/**
 * The next draft identifier of a business: DRAFT-#####. A separate sequence
 * from issued invoice numbers, so drafts never consume an official number.
 */
invoiceSchema.statics.generateDraftNumber = async function (userId, dataScope, { session } = {}) {
  const NumberSequence = mongoose.model('NumberSequence');
  const sequence = await NumberSequence.nextAfter(`invoice-draft:${dataScope || userId}`, 0, { session });
  return `DRAFT-${String(sequence).padStart(5, '0')}`;
};

invoiceSchema.statics.createNumbered = async function (data, { session, attempts = 5 } = {}) {
  const isDraft = (data.status || 'draft') === 'draft';
  for (let attempt = 1; ; attempt += 1) {
    const invoiceNumber = isDraft
      ? await this.generateDraftNumber(data.userId, data.dataScope, { session })
      : await this.generateInvoiceNumber(data.userId, data.dataScope, { session });
    try {
      const [invoice] = await this.create([{ ...data, invoiceNumber, ...(isDraft ? {} : { issuedAt: data.issuedAt || new Date() }) }], session ? { session } : {});
      return invoice;
    } catch (error) {
      if (!this.isNumberTaken(error) || session || attempt >= attempts) throw error;
    }
  }
};

// Static method to get invoice statistics. matchQuery decides whose invoices
// are counted — see staffScopeQuery in utils/dataScopeHelper.js.
invoiceSchema.statics.getInvoiceStats = function(matchQuery) {
  return this.aggregate([
    { $match: matchQuery },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        totalAmount: { $sum: '$totalAmount' },
        paidAmount: { $sum: '$paidAmount' },
        pendingAmount: { $sum: '$balanceAmount' },
        avgInvoiceValue: { $avg: '$totalAmount' }
      }
    }
  ]);
};

require('./DocumentNumbering');
module.exports = mongoose.model('Invoice', invoiceSchema);
