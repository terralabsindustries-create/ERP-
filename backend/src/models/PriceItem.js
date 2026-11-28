const mongoose = require('mongoose');

/**
 * Item master for priced products: digital, flex, offset and general items.
 * Prices come from quantity slabs (the whole line takes the rate of the
 * highest minimum quantity not above the order quantity) or a default rate.
 * See services/pricingService.js for the single pricing implementation.
 */
const slabSchema = new mongoose.Schema({
  minQty: { type: Number, required: true, min: [0.001, 'Minimum quantity must be above 0'] },
  rate: { type: Number, required: true, min: [0, 'Rate cannot be negative'] }
}, { _id: false });

const priceItemSchema = new mongoose.Schema({
  type: { type: String, enum: ['digital', 'flex', 'offset', 'general'], required: true },
  name: { type: String, required: [true, 'Item name is required'], trim: true, maxlength: 160 },
  mediaName: { type: String, trim: true, maxlength: 160 },
  paperType: { type: String, trim: true, maxlength: 80 },
  gsm: { type: Number, min: 0 },
  printSize: { type: String, trim: true, maxlength: 60 },
  sides: { type: String, enum: ['simplex', 'duplex', null] },
  hsnCode: { type: String, trim: true, uppercase: true },
  gstRate: { type: Number, min: 0, max: 100, default: 18 },
  // true: the rates below already include GST; false: GST is added on top.
  taxInclusive: { type: Boolean, default: false },
  unit: { type: String, trim: true, default: 'pieces' },
  // Optional link to the general stock item this product consumes.
  inventoryItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
  defaultRate: { type: Number, min: 0, default: null },
  slabs: { type: [slabSchema], default: [] },
  isActive: { type: Boolean, default: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dataScope: { type: String }
}, { timestamps: true });

priceItemSchema.index({ dataScope: 1, type: 1, isActive: 1 });
priceItemSchema.index({ dataScope: 1, name: 1 });
priceItemSchema.index({ userId: 1, type: 1 });

module.exports = mongoose.model('PriceItem', priceItemSchema);
