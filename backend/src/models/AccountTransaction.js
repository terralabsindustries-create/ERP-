const mongoose = require('mongoose');
const NumberSequence = require('./NumberSequence');

const accountTransactionSchema = new mongoose.Schema({
  transactionNumber: {
    type: String,
    unique: true,
    trim: true,
    sparse: true  // Allow null/undefined values temporarily until pre-save hook generates it
  },
  transactionType: {
    type: String,
    required: [true, 'Transaction type is required'],
    enum: ['income', 'expense', 'transfer', 'opening_balance', 'adjustment'],
    default: 'expense'
  },
  category: {
    type: String,
    required: [true, 'Category is required'],
    trim: true
  },
  subCategory: {
    type: String,
    trim: true
  },
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    trim: true
  },
  // Date on the bank statement; older records fall back to their creation date.
  postedAt: Date,
  paymentMethod: {
    type: String,
    required: [true, 'Payment method is required'],
    enum: ['cash', 'bank_transfer', 'cheque', 'card', 'upi', 'wallet', 'other'],
    default: 'cash'
  },
  accountType: {
    type: String,
    required: [true, 'Account type is required'],
    enum: ['cash', 'bank', 'credit_card', 'loan', 'investment'],
    default: 'cash'
  },
  accountName: {
    type: String,
    required: [true, 'Account name is required'],
    trim: true
  },
  reference: {
    type: String,
    trim: true
  },
  referenceNumber: {
    type: String,
    trim: true
  },
  // Related entities
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vendor'
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  // Set only by the payment ledger. One customer receipt has one cash/bank
  // entry; account editors cannot change it independently.
  sourcePaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    unique: true,
    sparse: true
  },
  // The payment receiving account (models/PaymentAccount.js) the money went
  // into or came out of. accountType/accountName are filled from it.
  paymentAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PaymentAccount',
    index: true
  },
  // The refund of a customer payment: money paid back out, dated when it was
  // refunded. The receipt itself (sourcePaymentId) stays as received.
  sourceRefundPaymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    unique: true,
    sparse: true
  },
  // A balance adjustment entered to match an account to its real balance:
  // 'in' adds to the account, 'out' takes away. Older adjustments have no
  // direction and move no balance.
  adjustmentDirection: {
    type: String,
    enum: ['in', 'out']
  },
  // The payslip whose salary payout this expense is. One expense per payslip:
  // the unique index stops a retried or concurrent "mark paid" adding another.
  sourcePayrollId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payroll',
    unique: true,
    sparse: true
  },
  // Cheque details (if payment method is cheque)
  chequeDetails: {
    chequeNumber: String,
    bankName: String,
    branchName: String,
    issueDate: Date,
    depositDate: Date,
    clearanceDate: Date,
    status: {
      type: String,
      enum: ['issued', 'deposited', 'cleared', 'bounced', 'cancelled'],
      default: 'issued'
    }
  },
  // A transfer is one entry: it leaves accountType/accountName (the source)
  // and arrives in toAccountType/toAccount (the destination). The server
  // fills these from the validated request; fromAccount mirrors accountName.
  transferDetails: {
    fromAccount: String,
    toAccount: String,
    // The payment account the transfer arrives in, when it is one.
    toPaymentAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentAccount' },
    toAccountType: {
      type: String,
      enum: ['cash', 'bank', 'credit_card', 'loan', 'investment']
    },
    transferFee: {
      type: Number,
      default: 0
    }
  },
  // Tax details
  taxDetails: {
    gstAmount: {
      type: Number,
      default: 0
    },
    tdsAmount: {
      type: Number,
      default: 0
    },
    taxRate: {
      type: Number,
      default: 0
    }
  },
  // Status and workflow
  status: {
    type: String,
    enum: ['pending', 'completed', 'cancelled', 'reversed'],
    default: 'completed'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: Date,
  // Attachments
  attachments: [{
    fileName: String,
    fileUrl: String,
    fileType: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Notes and comments
  notes: {
    type: String,
    trim: true
  },
  internalNotes: {
    type: String,
    trim: true
  },
  // Reconciliation
  reconciled: {
    type: Boolean,
    default: false
  },
  reconciledAt: Date,
  reconciledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reconciliationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BankReconciliation'
  },
  // A transfer into a bank account is cleared on that account's statement
  // separately from the source side above.
  transferInReconciled: {
    type: Boolean,
    default: false
  },
  transferInReconciledAt: Date,
  transferInReconciledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  transferInReconciliationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BankReconciliation'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for efficient querying
accountTransactionSchema.index({ userId: 1, transactionDate: -1 });
accountTransactionSchema.index({ userId: 1, transactionType: 1 });
accountTransactionSchema.index({ userId: 1, accountType: 1 });
accountTransactionSchema.index({ userId: 1, category: 1 });
accountTransactionSchema.index({ userId: 1, status: 1 });

// Older entries use their creation date when no statement date was recorded.
accountTransactionSchema.virtual('transactionDate').get(function () {
  return this.postedAt || this.createdAt;
});

// Pre-save middleware to generate transaction number
accountTransactionSchema.pre('save', async function (next) {
  if (this.isNew && !this.transactionNumber) {
    const today = new Date();
    const year = today.getFullYear().toString().slice(-2);
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');

    // Find the last transaction number for today
    const prefix = `TXN${year}${month}${day}`;
    const lastTransaction = await this.constructor.findOne({
      transactionNumber: new RegExp(`^${prefix}`)
    }).sort({ transactionNumber: -1 });

    let previous = 0;
    if (lastTransaction) {
      const lastNumber = parseInt(lastTransaction.transactionNumber.split(prefix)[1]);
      if (!isNaN(lastNumber)) {
        previous = lastNumber;
      }
    }

    const counter = await NumberSequence.nextAfter(`account-transaction:${year}${month}${day}`, previous);
    this.transactionNumber = `${prefix}${counter.toString().padStart(4, '0')}`;
  }
  next();
});

/*
  Each completed entry moves money on one or two accounts ("legs"):
  income and opening balances credit their account, expenses debit it, and a
  transfer debits its source and credits its destination once each, so the
  business total does not change. A balance adjustment adds or takes away
  by its adjustmentDirection; older adjustments have none and move no
  balance. A transfer recorded before destinations existed
  has no toAccountType and debits only its source, as it always did.
*/
const legsBy = (own, destination) => ({
  $switch: {
    branches: [
      { case: { $in: ['$transactionType', ['income', 'opening_balance']] }, then: [{ account: own, credit: '$amount', debit: 0 }] },
      { case: { $eq: ['$transactionType', 'expense'] }, then: [{ account: own, credit: 0, debit: '$amount' }] },
      {
        case: { $eq: ['$transactionType', 'transfer'] },
        then: [
          { account: own, credit: 0, debit: '$amount' },
          { account: destination, credit: '$amount', debit: 0 }
        ]
      },
      { case: { $and: [{ $eq: ['$transactionType', 'adjustment'] }, { $eq: ['$adjustmentDirection', 'in'] }] }, then: [{ account: own, credit: '$amount', debit: 0 }] },
      { case: { $and: [{ $eq: ['$transactionType', 'adjustment'] }, { $eq: ['$adjustmentDirection', 'out'] }] }, then: [{ account: own, credit: 0, debit: '$amount' }] }
    ],
    default: []
  }
});
// Legs by Accounts page column (cash, bank…), and by payment account.
const BALANCE_LEGS = legsBy('$accountType', { $ifNull: ['$transferDetails.toAccountType', null] });
const PAYMENT_ACCOUNT_LEGS = legsBy({ $ifNull: ['$paymentAccountId', null] }, { $ifNull: ['$transferDetails.toPaymentAccountId', null] });

/**
 * Each payment account's money over [from, to): the balance before, opening
 * balances posted in the period, payments received, other money in
 * (transfers, adjustments, other income), money paid out, and the balance
 * after `to` — all from completed ledger entries by their effective date
 * (postedAt, else createdAt). Nothing is read from a stored running total.
 */
accountTransactionSchema.statics.paymentAccountActivity = async function (scope, from, to) {
  const inRange = { $and: [{ $gte: ['$date', from] }, { $lt: ['$date', to] }] };
  const net = { $subtract: ['$legs.credit', '$legs.debit'] };
  return this.aggregate([
    { $match: { $and: [scope, { status: 'completed' }, { $or: [{ paymentAccountId: { $exists: true } }, { 'transferDetails.toPaymentAccountId': { $exists: true } }] }] } },
    {
      $project: {
        date: { $ifNull: ['$postedAt', '$createdAt'] },
        receipt: { $cond: [{ $ifNull: ['$sourcePaymentId', false] }, true, false] },
        opening: { $eq: ['$transactionType', 'opening_balance'] },
        legs: PAYMENT_ACCOUNT_LEGS
      }
    },
    { $unwind: '$legs' },
    { $match: { 'legs.account': { $ne: null } } },
    {
      $group: {
        _id: '$legs.account',
        before: { $sum: { $cond: [{ $lt: ['$date', from] }, net, 0] } },
        openingInPeriod: { $sum: { $cond: [{ $and: [inRange, '$opening'] }, net, 0] } },
        received: { $sum: { $cond: [{ $and: [inRange, '$receipt'] }, '$legs.credit', 0] } },
        receivedCount: { $sum: { $cond: [{ $and: [inRange, '$receipt', { $gt: ['$legs.credit', 0] }] }, 1, 0] } },
        otherIn: { $sum: { $cond: [{ $and: [inRange, { $not: ['$receipt'] }, { $not: ['$opening'] }] }, '$legs.credit', 0] } },
        paidOut: { $sum: { $cond: [{ $and: [inRange, { $not: ['$opening'] }] }, '$legs.debit', 0] } },
        after: { $sum: { $cond: [{ $gte: ['$date', to] }, net, 0] } }
      }
    }
  ]);
};

accountTransactionSchema.statics.getAccountBalances = async function (scope) {
  return this.aggregate([
    { $match: { ...scope, status: 'completed' } },
    { $project: { legs: BALANCE_LEGS } },
    { $unwind: '$legs' },
    { $match: { 'legs.account': { $ne: null } } },
    { $group: { _id: '$legs.account', totalIncome: { $sum: '$legs.credit' }, totalExpense: { $sum: '$legs.debit' } } },
    {
      $project: {
        accountType: '$_id',
        balance: { $subtract: ['$totalIncome', '$totalExpense'] },
        totalIncome: 1,
        totalExpense: 1
      }
    }
  ]);
};

// Income and expense of completed entries whose effective date (postedAt,
// else createdAt) falls in [start, end). Transfers, opening balances and
// adjustments are not income or expense.
accountTransactionSchema.statics.periodTotals = async function (scope, start, end) {
  const rows = await this.aggregate([
    { $match: { ...scope, status: 'completed', transactionType: { $in: ['income', 'expense'] } } },
    { $addFields: { effectiveDate: { $ifNull: ['$postedAt', '$createdAt'] } } },
    { $match: { effectiveDate: { $gte: start, $lt: end } } },
    { $group: { _id: '$transactionType', total: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]);
  const of = (type) => rows.find((row) => row._id === type) || { total: 0, count: 0 };
  const income = of('income');
  const expense = of('expense');
  return {
    income: income.total,
    expense: expense.total,
    net: income.total - expense.total,
    entries: income.count + expense.count
  };
};

// Static method to get transaction statistics
accountTransactionSchema.statics.getTransactionStats = async function (scope) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [
    totalTransactions,
    todayTransactions,
    monthlyTransactions,
    totalIncome,
    totalExpense,
    categoryStats,
    paymentMethodStats
  ] = await Promise.all([
    this.countDocuments({ ...scope, status: 'completed' }),
    this.countDocuments({ ...scope, createdAt: { $gte: today }, status: 'completed' }),
    this.countDocuments({ ...scope, createdAt: { $gte: monthStart }, status: 'completed' }),
    this.aggregate([
      { $match: { ...scope, transactionType: 'income', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    this.aggregate([
      { $match: { ...scope, transactionType: 'expense', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    this.aggregate([
      { $match: { ...scope, status: 'completed' } },
      { $group: { _id: '$category', count: { $sum: 1 }, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
      { $limit: 10 }
    ]),
    this.aggregate([
      { $match: { ...scope, status: 'completed' } },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }
    ])
  ]);

  return {
    totalTransactions,
    todayTransactions,
    monthlyTransactions,
    totalIncome: totalIncome[0]?.total || 0,
    totalExpense: totalExpense[0]?.total || 0,
    netIncome: (totalIncome[0]?.total || 0) - (totalExpense[0]?.total || 0),
    categoryStats,
    paymentMethodStats
  };
};

// Another login may save the same daily number between the lookup and insert.
accountTransactionSchema.statics.createWithUniqueNumber = async function (data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await this.create(data);
    } catch (error) {
      if (error.code !== 11000 || !error.keyPattern?.transactionNumber || attempt === 4) throw error;
    }
  }
};

module.exports = mongoose.model('AccountTransaction', accountTransactionSchema);
