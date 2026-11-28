const mongoose = require('mongoose');

/*
  A GST credit note or debit note issued against one of the business's
  invoices (CGST Act s.34; CGST Rules r.53 for the particulars a note carries).

  - credit: reduces the value or tax of the original supply (goods returned,
    price reduced after issue, deficiency in service, excess charged).
  - debit: increases it (price raised after issue, short-charged tax).

  Each line refers to a line of the original invoice (or its design charge)
  and carries the taxable value being adjusted and the GST on it at the
  original line's rate, split CGST/SGST or IGST as on the invoice.

  Numbering: a draft carries DRAFT-CN-#####/DRAFT-DN-#####; the official
  number (CN-<FY>-####, DN-<FY>-####, e.g. CN-2627-0001 for FY 2026-27) is
  given on issue, from its own series per business and financial year, so it
  never shares or consumes invoice numbers. Issued notes are never edited or
  deleted, only cancelled (number kept). services/creditNotes.js owns every
  state change.
*/
const REASONS = ['sales_return', 'post_sale_discount', 'price_revision', 'deficiency_in_service', 'excess_charged', 'short_charged', 'correction', 'other'];
const STATUSES = ['draft', 'issued', 'cancelled'];

const lineSchema = new mongoose.Schema({
  /** The original invoice line's _id, or 'design' for its design charge. */
  invoiceLineRef: { type: String, required: true },
  itemName: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  hsnCode: { type: String, trim: true },
  sacCode: { type: String, trim: true },
  unit: { type: String, trim: true },
  /** Quantity returned or re-priced; 0 for a value-only adjustment. */
  quantity: { type: Number, default: 0, min: 0 },
  taxableValue: { type: Number, required: true, min: 0 },
  gstRate: { type: Number, default: 0, min: 0, max: 100 },
  cgstAmount: { type: Number, default: 0 },
  sgstAmount: { type: Number, default: 0 },
  igstAmount: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  total: { type: Number, default: 0 }
}, { _id: true });

const creditNoteSchema = new mongoose.Schema({
  noteType: { type: String, enum: ['credit', 'debit'], required: true },
  noteNumber: { type: String, required: true, trim: true },
  draftNumber: { type: String, trim: true },
  financialYear: { type: String },
  noteDate: { type: Date, required: true, default: Date.now },
  status: { type: String, enum: STATUSES, default: 'draft' },

  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  invoiceNumber: { type: String, required: true },
  invoiceDate: { type: Date },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerName: { type: String, required: true },
  customerGstNumber: { type: String, trim: true },
  customerAddress: { type: String, trim: true },
  isInterState: { type: Boolean, default: false },

  reason: { type: String, enum: REASONS, required: true },
  reasonText: { type: String, trim: true, maxlength: 500 },
  notes: { type: String, trim: true, maxlength: 2000 },

  items: { type: [lineSchema], validate: [(v) => v.length > 0, 'A note needs at least one line'] },
  taxableAmount: { type: Number, default: 0 },
  totalCgstAmount: { type: Number, default: 0 },
  totalSgstAmount: { type: Number, default: 0 },
  totalIgstAmount: { type: Number, default: 0 },
  totalGstAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },

  /** Credit notes: how much came off the invoice's outstanding balance on issue; the rest is customer credit. */
  appliedToInvoice: { type: Number, default: 0 },
  unappliedAmount: { type: Number, default: 0 },

  issuedAt: { type: Date },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  issuingAt: { type: Date },
  cancelledAt: { type: Date },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancellationReason: { type: String, trim: true },

  /** Client-supplied key so a double-submitted create makes one note. */
  idempotencyKey: { type: String, trim: true },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dataScope: { type: String, index: true }
}, { timestamps: true });

creditNoteSchema.index({ dataScope: 1, noteNumber: 1 }, { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } });
creditNoteSchema.index({ userId: 1, noteNumber: 1 }, { unique: true, partialFilterExpression: { dataScope: null } });
creditNoteSchema.index({ dataScope: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
creditNoteSchema.index({ dataScope: 1, invoiceId: 1, status: 1 });
creditNoteSchema.index({ dataScope: 1, customerId: 1, noteDate: -1 });
creditNoteSchema.index({ dataScope: 1, noteDate: -1 });

creditNoteSchema.statics.REASONS = REASONS;
creditNoteSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('CreditNote', creditNoteSchema);
