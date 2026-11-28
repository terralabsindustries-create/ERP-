const mongoose = require('mongoose');
const { UNITS } = require('../utils/productPricing');

/*
  Product Rate Master: a material product with its GST and, for each audience,
  a ladder of quantity/area slabs. Validated and normalised by
  utils/productPricing.js (routes/productRates.js) before it is saved, so what is
  stored is always consistent: non-overlapping slabs, both GST sides filled, no
  duplicate rules.
*/
const slabSchema = new mongoose.Schema({
  from: { type: Number, required: true, min: 0 },
  to: { type: Number, default: null, min: 0 }, // null = no upper limit
  exclusiveRate: { type: Number, required: true, min: 0 },
  inclusiveRate: { type: Number, required: true, min: 0 },
  rateBasis: { type: String, enum: ['exclusive', 'inclusive'], default: 'exclusive' },
  // Shown as in the reference software; does not change any calculation until
  // the business confirms what it means (see utils/productPricing.js).
  isMinimum: { type: Boolean, default: false },
  unit: String
}, { _id: false });

const ruleSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  partyType: { type: String, enum: ['Walk-in', 'Agency', 'Individual', 'Business', 'Corporate'] },
  salesType: { type: String, trim: true, maxlength: 40 },
  slabs: { type: [slabSchema], default: [] },
  minimumQuantity: { type: Number, min: 0 },
  minimumAmount: { type: Number, min: 0 }
}, { _id: false });

const productRateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dataScope: { type: String },
  materialType: { type: String, required: [true, 'Material type is required'], trim: true, maxlength: 60 },
  productName: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 120 },
  productCode: { type: String, trim: true, uppercase: true, maxlength: 30 },
  unit: { type: String, enum: UNITS, default: 'pieces' },
  hsnCode: { type: String, trim: true },
  gstRate: { type: Number, min: 0, max: 100, default: 18 },
  taxExempt: { type: Boolean, default: false },
  cessRate: { type: Number, min: 0, max: 100, default: 0 },
  isActive: { type: Boolean, default: true },
  rules: { type: [ruleSchema], default: [] },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

productRateSchema.index({ dataScope: 1, productCode: 1 }, { unique: true, partialFilterExpression: { productCode: { $type: 'string' } } });
productRateSchema.index({ dataScope: 1, materialType: 1, productName: 1 });
productRateSchema.index({ userId: 1, materialType: 1 });

module.exports = mongoose.model('ProductRate', productRateSchema);
