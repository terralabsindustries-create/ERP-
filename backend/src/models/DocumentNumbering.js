const mongoose = require('mongoose');

/*
  Document numbering per business (Settings → Document numbering).

  Invoices: prefix + period + running number, e.g.
    monthly         INV-202611-0001   (the original series; the default)
    financial_year  INV-2627-0001     (one running series per April–March year)
  GST invoice numbers must be unique within a financial year, at most 16
  characters, and use only letters, digits, "-" and "/" (CGST Rule 46(b)); the
  settings refuse a prefix that could break that. Changing the series never
  renumbers issued invoices; the next issued invoice continues in the new one.

  Stock items: the prefix of automatically made item codes (SKUs). Existing
  codes are never changed.
*/
const numberingSchema = new mongoose.Schema({
  dataScope: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invoice: {
    prefix: { type: String, default: 'INV-', trim: true, maxlength: 8 },
    reset: { type: String, enum: ['monthly', 'financial_year'], default: 'monthly' },
    padding: { type: Number, default: 4, min: 3, max: 6 }
  },
  stockItemPrefix: { type: String, default: 'STK-', trim: true, maxlength: 8 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
numberingSchema.index({ dataScope: 1 }, { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } });
numberingSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { dataScope: null } });

module.exports = mongoose.models.DocumentNumbering || mongoose.model('DocumentNumbering', numberingSchema);
