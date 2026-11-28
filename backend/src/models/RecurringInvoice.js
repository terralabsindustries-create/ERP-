const mongoose = require('mongoose');

/*
  A recurring invoice template: who is billed, what, and how often.
  services/recurringInvoices.js generates one invoice per scheduled date.
  Generated invoices are DRAFTS (they follow the normal draft → issue
  lifecycle) unless `issueAutomatically` was explicitly chosen by a login
  allowed to issue invoices; even then each one is issued through the normal
  issue service, getting its official number at that moment.

  RecurringInvoiceRun (below) records each scheduled date once — the unique
  (template, periodKey) index is what makes a date impossible to bill twice,
  across restarts, retries and several server instances.
*/
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

const lineSchema = new mongoose.Schema({
  itemName: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  hsnCode: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, default: 'pieces' },
  unitPrice: { type: Number, required: true, min: 0 },
  gstRate: { type: Number, required: true, min: 0, max: 100 }
}, { _id: false });

const recurringSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  items: { type: [lineSchema], validate: [(v) => v.length > 0, 'Add at least one line'] },
  isInterState: { type: Boolean, default: false },
  placeOfSupply: { type: String, match: /^\d{2}$/ },
  notes: { type: String, trim: true, maxlength: 2000 },
  termsAndConditions: { type: String, trim: true, maxlength: 4000 },
  dueInDays: { type: Number, default: 15, min: 0, max: 365 },

  frequency: { type: String, enum: FREQUENCIES, required: true },
  interval: { type: Number, default: 1, min: 1, max: 12 },
  startDate: { type: Date, required: true },
  endDate: { type: Date },
  nextRunDate: { type: Date, required: true },
  /** Day of the month a monthly/quarterly/yearly schedule aims for (kept when a month is shorter). */
  anchorDay: { type: Number, min: 1, max: 31 },
  issueAutomatically: { type: Boolean, default: false },

  status: { type: String, enum: ['active', 'paused', 'cancelled', 'completed'], default: 'active' },
  lastRunAt: { type: Date },
  lastError: { type: String },
  consecutiveFailures: { type: Number, default: 0 },
  retryAfter: { type: Date },
  generatedCount: { type: Number, default: 0 },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dataScope: { type: String, index: true }
}, { timestamps: true });

recurringSchema.index({ status: 1, nextRunDate: 1 });
recurringSchema.index({ dataScope: 1, status: 1, nextRunDate: 1 });
recurringSchema.statics.FREQUENCIES = FREQUENCIES;

const runSchema = new mongoose.Schema({
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringInvoice', required: true },
  /** The scheduled date this run bills, "YYYY-MM-DD" in India time. */
  periodKey: { type: String, required: true },
  scheduledFor: { type: Date, required: true },
  status: { type: String, enum: ['running', 'generated', 'failed'], default: 'running' },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  invoiceNumber: { type: String },
  issued: { type: Boolean, default: false },
  error: { type: String },
  attempts: { type: Number, default: 1 },
  trigger: { type: String, enum: ['scheduler', 'manual'], default: 'scheduler' },
  dataScope: { type: String }
}, { timestamps: true });
runSchema.index({ templateId: 1, periodKey: 1 }, { unique: true });
runSchema.index({ templateId: 1, createdAt: -1 });

module.exports = mongoose.model('RecurringInvoice', recurringSchema);
module.exports.RecurringInvoiceRun = mongoose.model('RecurringInvoiceRun', runSchema);
