const mongoose = require('mongoose');

const quotationItemSchema = new mongoose.Schema({
  item_name: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  quantity: { type: Number, required: true, min: [0.01, 'Quantity must be greater than 0'] },
  unit_price: { type: Number, required: true, min: [0, 'Unit price cannot be negative'] },
  unit: {
    type: String,
    enum: ['pieces', 'boxes', 'reams', 'kg', 'grams', 'liters', 'meters', 'sqft', 'sqm', 'rolls', 'sheets'],
    default: 'pieces'
  },
  // Area pricing (unit sqft/sqm): one piece is length × width, and the rate is
  // charged on area_per_piece × quantity = total_area. See utils/billing.js.
  // An older sq ft line has no dimensions; its quantity is the area.
  length: { type: Number, default: 0, min: 0 },
  width: { type: Number, default: 0, min: 0 },
  area_per_piece: { type: Number, default: 0 },
  total_area: { type: Number, default: 0 },
  // GST is no longer charged; kept for quotations written with it (0 on new ones).
  tax_rate: { type: Number, default: 0, min: 0, max: 100 },
  tax_amount: { type: Number, default: 0 },
  // The line amount: quantity (or total area) × unit price.
  total_amount: { type: Number, required: true, min: 0 }
});

const quotationSchema = new mongoose.Schema({
  quotationNumber: {
    type: String,
    required: true,
    trim: true
    // Uniqueness is enforced per-tenant below, not globally — see the
    // dataScope/userId compound indexes. A bare `unique: true` here would make
    // it a single shared numbering sequence across every business on Terralabs ERP.
  },
  customer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: [true, 'Customer is required']
  },
  // Quotations written before GST was removed say whether they carried it.
  // New ones are always 'non_gst'.
  gst_type: {
    type: String,
    enum: ['gst', 'non_gst'],
    default: 'non_gst'
  },
  is_interstate: {
    type: Boolean,
    default: false
  },
  valid_until: {
    type: Date
  },
  items: [quotationItemSchema],
  // Sum of the line amounts.
  subtotal: { type: Number, default: 0 },
  // Design & pre-press work, shown as its own line in the totals. Carried onto
  // the invoice unchanged when the quotation is converted.
  design_charge: { type: Number, default: 0, min: [0, 'Design charge cannot be negative'] },
  tax_amount: { type: Number, default: 0 },
  // subtotal + design_charge (+ tax_amount on older GST quotations).
  total_amount: { type: Number, default: 0 },
  status: {
    type: String,
    // draft/sent/approved/rejected are the working lifecycle.
    // expired  - validity date passed without a decision
    // converted- an invoice was raised from this quotation (terminal)
    // closed   - manually closed off, no further action (terminal)
    enum: ['draft', 'sent', 'approved', 'rejected', 'expired', 'converted', 'closed'],
    default: 'draft'
  },

  // Set when the quotation is turned into an invoice.
  convertedInvoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  convertedInvoiceNumber: { type: String, trim: true },
  convertedAt: { type: Date },

  payment_link: { type: String, trim: true },
  terms_conditions: { type: String, trim: true },
  notes: { type: String, trim: true },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true
  }
}, { timestamps: true });

quotationSchema.index({ userId: 1, status: 1 });

// quotationNumber only needs to be unique within one tenant, not across all of
// them — two businesses each having their own "QUO-202608-0001" is correct,
// not a collision. Split by whether dataScope is the modern per-tenant string
// or absent (pre-dataScope accounts, scoped by userId instead).
quotationSchema.index(
  { dataScope: 1, quotationNumber: 1 },
  { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } }
);
quotationSchema.index(
  { userId: 1, quotationNumber: 1 },
  { unique: true, partialFilterExpression: { dataScope: null } }
);

quotationSchema.statics.generateQuotationNumber = async function(userId, dataScope) {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  const startOfMonth = new Date(year, today.getMonth(), 1);
  const endOfMonth = new Date(year, today.getMonth() + 1, 0);

  const countQuery = dataScope
    ? { dataScope, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }
    : { userId, createdAt: { $gte: startOfMonth, $lte: endOfMonth } };

  const count = await this.countDocuments(countQuery);
  let seq = count + 1;
  let quotationNumber = `QUO-${year}${month}-${String(seq).padStart(4, '0')}`;

  // Rebuild the query each pass — reusing one object would keep testing the
  // first number forever and spin here indefinitely.
  const scope = dataScope ? { dataScope } : { userId };
  const MAX_ATTEMPTS = 10000;
  let attempts = 0;

  while (await this.findOne({ ...scope, quotationNumber })) {
    seq++;
    quotationNumber = `QUO-${year}${month}-${String(seq).padStart(4, '0')}`;
    if (++attempts >= MAX_ATTEMPTS) {
      throw new Error(`Could not allocate a unique quotation number after ${MAX_ATTEMPTS} attempts`);
    }
  }

  return quotationNumber;
};

module.exports = mongoose.model('Quotation', quotationSchema);
