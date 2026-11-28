const mongoose = require('mongoose');

/*
  E-invoice (IRN) and e-way bill state, kept apart from the invoice itself.

  ComplianceSettings  one per business: whether e-invoicing / e-way bills are
                      switched on, which authorised provider (GSP) is used, the
                      environment, and the e-way bill value limit the business
                      has confirmed. Credentials are NEVER stored here: they come
                      from server environment variables named by the provider.
  EInvoiceRecord      one per invoice (unique): status, IRN, acknowledgement,
                      signed QR, every request/response summary, cancellation.
  EwayBillRecord      one active per invoice: transport details, EWB number,
                      validity, status history.

  Nothing here is ever filled with made-up government values: IRN, Ack No,
  signed QR and EWB numbers are stored only as returned by the provider.
*/
const settingsSchema = new mongoose.Schema({
  dataScope: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  eInvoiceEnabled: { type: Boolean, default: false },
  eWayBillEnabled: { type: Boolean, default: false },
  provider: { type: String, enum: ['none', 'custom_gsp'], default: 'none' },
  environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
  /** Consignment value (₹) from which an e-way bill is required, as confirmed by the business for its state. */
  eWayBillThreshold: { type: Number, min: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
settingsSchema.index({ dataScope: 1 }, { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } });

const eventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  action: String,
  outcome: String,
  message: String,
  requestHash: String,
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const eInvoiceSchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, unique: true },
  invoiceNumber: String,
  dataScope: { type: String, index: true },
  status: { type: String, enum: ['pending', 'generated', 'failed', 'cancelled'], default: 'pending' },
  inFlightAt: Date,
  provider: String,
  environment: String,
  irn: String,
  ackNo: String,
  ackDate: Date,
  signedQrCode: String,
  signedInvoice: String,
  cancelledAt: Date,
  cancelReasonCode: String,
  cancelRemark: String,
  attempts: { type: Number, default: 0 },
  lastError: String,
  events: { type: [eventSchema], default: [] }
}, { timestamps: true });

const ewbSchema = new mongoose.Schema({
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
  invoiceNumber: String,
  dataScope: { type: String, index: true },
  status: { type: String, enum: ['pending', 'generated', 'failed', 'cancelled'], default: 'pending' },
  inFlightAt: Date,
  transportMode: { type: String, enum: ['road', 'rail', 'air', 'ship'] },
  vehicleNumber: String,
  vehicleType: { type: String, enum: ['regular', 'over_dimensional'], default: 'regular' },
  transporterId: String,
  transporterName: String,
  transportDocNumber: String,
  transportDocDate: Date,
  distanceKm: Number,
  fromPincode: String,
  toPincode: String,
  ewbNumber: String,
  ewbDate: Date,
  validUntil: Date,
  cancelledAt: Date,
  cancelReasonCode: String,
  attempts: { type: Number, default: 0 },
  lastError: String,
  events: { type: [eventSchema], default: [] }
}, { timestamps: true });
ewbSchema.index({ invoiceId: 1, status: 1 });
ewbSchema.index({ invoiceId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['pending', 'generated'] } }, name: 'one_active_ewb_per_invoice' });

module.exports = {
  ComplianceSettings: mongoose.models.ComplianceSettings || mongoose.model('ComplianceSettings', settingsSchema),
  EInvoiceRecord: mongoose.models.EInvoiceRecord || mongoose.model('EInvoiceRecord', eInvoiceSchema),
  EwayBillRecord: mongoose.models.EwayBillRecord || mongoose.model('EwayBillRecord', ewbSchema)
};
