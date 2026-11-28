const mongoose = require('mongoose');

/** A customer's own price for one PriceItem: a fixed rate and/or its own quantity slabs, with change history. */
const slabSchema = new mongoose.Schema({
  minQty: { type: Number, required: true, min: [0.001, 'Minimum quantity must be above 0'] },
  rate: { type: Number, required: true, min: [0, 'Rate cannot be negative'] }
}, { _id: false });

const schema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'PriceItem', required: true },
  fixedRate: { type: Number, min: 0, default: null },
  slabs: { type: [slabSchema], default: [] },
  isActive: { type: Boolean, default: true },
  history: [{
    at: { type: Date, default: Date.now },
    by: mongoose.Schema.Types.ObjectId,
    byName: String,
    action: String,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    reason: String
  }],
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dataScope: { type: String }
}, { timestamps: true });

schema.index({ dataScope: 1, customerId: 1, itemId: 1 }, { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } });
schema.index({ userId: 1, customerId: 1, itemId: 1 });
schema.index({ dataScope: 1, itemId: 1 });

module.exports = mongoose.model('CustomerItemRate', schema);
