const mongoose = require('mongoose');

const bankReconciliationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accountName: { type: String, required: true, trim: true },
  statementDate: { type: Date, required: true },
  openingBalance: { type: Number, required: true },
  closingBalance: { type: Number, required: true },
  clearedTotal: { type: Number, required: true },
  transactionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AccountTransaction' }],
  reconciledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

bankReconciliationSchema.index({ userId: 1, accountName: 1, statementDate: 1 }, { unique: true });

module.exports = mongoose.model('BankReconciliation', bankReconciliationSchema);
