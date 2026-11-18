const express = require('express');
const { body, query } = require('express-validator');
const AccountTransaction = require('../models/AccountTransaction');
const Cheque = require('../models/Cheque');
const Customer = require('../models/Customer');
const Vendor = require('../models/Vendor');
const Job = require('../models/Job');
const Invoice = require('../models/Invoice');
const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { orgUserFilter, orgScope } = require('../utils/accessScope');
const { accountScope } = require('../utils/accountScope');
const PaymentAccount = require('../models/PaymentAccount');
const { paymentAccountScope } = require('../utils/paymentAccounts');

const router = express.Router();
router.use('/reconciliation', require('./bankReconciliation'));

// The ledger belongs to the business. Deriving the displayed balance from
// completed entries also repairs balances that older per-login snapshots missed.
async function currentBalances(scope) {
  const rows = await AccountTransaction.getAccountBalances(scope);
  const balanceOf = (type) => rows.find((row) => row.accountType === type)?.balance || 0;
  return { balances: rows, currentBalances: {
    cashBalance: balanceOf('cash'), bankBalance: balanceOf('bank'),
    creditCardBalance: balanceOf('credit_card'), loanBalance: balanceOf('loan'),
    investmentBalance: balanceOf('investment')
  } };
}

const TRANSACTION_TYPES = ['income', 'expense', 'transfer', 'opening_balance', 'adjustment'];
const ACCOUNT_TYPES = ['cash', 'bank', 'credit_card', 'loan', 'investment'];
const isTransfer = (value, { req }) => req.body.transactionType === 'transfer';

// Validation rules
const transactionValidation = [
  body('transactionType').isIn(TRANSACTION_TYPES)
    .withMessage('Invalid transaction type'),
  body('category').notEmpty().withMessage('Category is required').trim(),
  body('amount').isFloat({ gt: 0 }).withMessage('Enter an amount above 0'),
  body('description').notEmpty().withMessage('Description is required').trim(),
  body('paymentMethod').isIn(['cash', 'bank_transfer', 'cheque', 'card', 'upi', 'wallet', 'other'])
    .withMessage('Invalid payment method'),
  body('accountType').isIn(['cash', 'bank', 'credit_card', 'loan', 'investment'])
    .withMessage('Account type is required (cash, bank, credit_card, loan or investment)'),
  body('accountName').notEmpty().withMessage('Account name is required').trim(),
  body('postedAt').optional().isISO8601().withMessage('Invalid transaction date'),
  // A transfer names both accounts: the source above and this destination.
  body('transferDetails.toAccountType').if(isTransfer).isIn(ACCOUNT_TYPES)
    .withMessage('Choose the account the transfer goes to'),
  body('transferDetails.toAccount').if(isTransfer).isString().withMessage('Enter the account the transfer goes to')
    .bail().trim().notEmpty().withMessage('Enter the account the transfer goes to')
];

// Account names are typed by hand; "HDFC bank " and "hdfc Bank" are one account.
const sameAccountName = (a, b) => String(a || '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();

function transferProblem(body) {
  if (body.transactionType !== 'transfer') return null;
  const to = body.transferDetails || {};
  if (to.toAccountType === body.accountType && sameAccountName(to.toAccount, body.accountName)) {
    return 'A transfer must go to a different account';
  }
  return null;
}

function validationFailure(req, res) {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  const list = errors.array().map((err) => ({ field: err.path || err.param, message: err.msg }));
  const transfer = transferProblem(req.body);
  if (transfer) list.push({ field: 'transferDetails.toAccount', message: transfer });
  if (!list.length) return false;
  res.status(400).json({ status: 'error', message: list[0].message || 'Validation failed', errors: list });
  return true;
}

// Account entries may refer to business records, but never to another
// business's customer, supplier, job or invoice. The IDs are optional.
async function validRelatedRecords(user, body) {
  const related = [
    ['customerId', Customer, orgScope(user)],
    ['vendorId', Vendor, await orgUserFilter(user)],
    ['jobId', Job, orgScope(user)],
    ['invoiceId', Invoice, orgScope(user)]
  ];
  for (const [field, Model, scope] of related) {
    const id = body[field];
    if (!id) continue;
    if (!mongoose.isValidObjectId(id) || !(await Model.exists({ _id: id, ...scope }))) return field;
  }
  return null;
}

// Ownership, numbering, approval and reconciliation fields belong to the
// server. An account editor can change only the actual entry fields.
const ENTRY_FIELDS = [
  'transactionType', 'category', 'subCategory', 'amount', 'description',
  'postedAt', 'paymentMethod', 'accountType', 'accountName', 'reference',
  'referenceNumber', 'customerId', 'vendorId', 'jobId', 'invoiceId',
  'chequeDetails', 'transferDetails', 'taxDetails', 'status', 'attachments',
  'notes', 'internalNotes'
];
function entryFields(body) {
  const fields = Object.fromEntries(ENTRY_FIELDS.filter((key) => body[key] !== undefined && key !== 'transferDetails').map((key) => [key, body[key]]));
  if (body.paymentAccountId) fields.paymentAccountId = body.paymentAccountId;
  if (body.transactionType === 'transfer') {
    fields.transferDetails = {
      fromAccount: body.accountName,
      toAccountType: body.transferDetails.toAccountType,
      toAccount: body.transferDetails.toAccount,
      ...(body.transferDetails.toPaymentAccountId ? { toPaymentAccountId: body.transferDetails.toPaymentAccountId } : {}),
      transferFee: 0
    };
  }
  return fields;
}

/*
  An entry may name payment accounts (models/PaymentAccount.js): the account
  money came out of or went into (paymentAccountId) and, for a transfer, the
  one it arrived in (transferDetails.toPaymentAccountId). Their column and
  name are then taken from the account, so the per-account balances and the
  Accounts page agree. A new link needs an active account of this business.
  Returns an error message, or null after filling req.body in.
*/
async function linkPaymentAccounts(user, body, existing = null) {
  const resolve = async (id, current) => {
    if (!mongoose.isValidObjectId(String(id))) return { error: 'Choose a valid payment account' };
    const account = await PaymentAccount.findOne({ _id: id, ...paymentAccountScope(user) }).lean();
    if (!account) return { error: 'Payment account not found' };
    if (!account.isActive && String(current || '') !== String(account._id)) return { error: `${account.nickname} is inactive` };
    return { account };
  };
  if (body.paymentAccountId) {
    const { account, error } = await resolve(body.paymentAccountId, existing?.paymentAccountId);
    if (error) return error;
    body.paymentAccountId = account._id;
    body.accountType = PaymentAccount.ledgerType(account.kind);
    body.accountName = account.nickname;
  } else {
    delete body.paymentAccountId;
  }
  const to = body.transactionType === 'transfer' ? body.transferDetails : null;
  if (to?.toPaymentAccountId) {
    const { account, error } = await resolve(to.toPaymentAccountId, existing?.transferDetails?.toPaymentAccountId);
    if (error) return error;
    to.toPaymentAccountId = account._id;
    to.toAccountType = PaymentAccount.ledgerType(account.kind);
    to.toAccount = account.nickname;
    if (body.paymentAccountId && String(body.paymentAccountId) === String(account._id)) return 'A transfer must go to a different account';
  } else if (to) {
    delete to.toPaymentAccountId;
  }
  return null;
}
const accountReferences = async (user) => [
  { path: 'customerId', select: 'name email phone', match: orgScope(user) },
  { path: 'vendorId', select: 'name email phone', match: await orgUserFilter(user) },
  { path: 'jobId', select: 'title status', match: orgScope(user) },
  { path: 'invoiceId', select: 'invoiceNumber totalAmount', match: orgScope(user) }
];

// @route   GET /api/accounts/transactions
// @desc    Get all account transactions for the authenticated user
// @access  Private
router.get('/transactions', protect, [
  // One type, or several separated by commas (e.g. transfer,opening_balance,adjustment).
  query('transactionType').optional().custom((value) => value === 'all' || String(value).split(',').every((type) => TRANSACTION_TYPES.includes(type.trim())))
    .withMessage('Invalid transaction type'),
  query('accountType').optional().isIn(['cash', 'bank', 'credit_card', 'loan', 'investment']),
  query('paymentMethod').optional().isIn(['cash', 'bank_transfer', 'cheque', 'card', 'upi', 'wallet', 'other']),
  query('status').optional().isIn(['pending', 'completed', 'cancelled', 'reversed']),
  query('search').optional().trim(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  const { validationResult } = require('express-validator');
  const invalid = validationResult(req);
  if (!invalid.isEmpty()) return res.status(400).json({ status: 'error', message: invalid.array()[0].msg, errors: invalid.array() });
  try {
    const {
      transactionType,
      accountType,
      paymentMethod,
      status,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    
    // Every filter runs in the database, before pagination, so the count and
    // pages cover exactly the matching entries.
    const conditions = [await accountScope(req.user)];
    const query = { $and: conditions };
    
    if (transactionType && transactionType !== 'all') {
      const types = [...new Set(String(transactionType).split(',').map((type) => type.trim()))];
      conditions.push({ transactionType: types.length === 1 ? types[0] : { $in: types } });
    }
    
    // A transfer belongs to both accounts it touches.
    if (accountType && accountType !== 'all') {
      conditions.push({ $or: [{ accountType }, { transactionType: 'transfer', 'transferDetails.toAccountType': accountType }] });
    }

    if (paymentMethod && paymentMethod !== 'all') {
      conditions.push({ paymentMethod });
    }
    
    if (status && status !== 'all') {
      conditions.push({ status });
    }
    
    if (search) {
      const pattern = { $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      conditions.push({ $or: [
        { transactionNumber: pattern },
        { description: pattern },
        { category: pattern },
        { accountName: pattern },
        { 'transferDetails.toAccount': pattern },
        { reference: pattern }
      ] });
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    sort._id = sort[sortBy]; // a stable order, so no entry is skipped or repeated across pages
    
    // Execute query
    const [transactions, totalTransactions] = await Promise.all([
      AccountTransaction.find(query)
        .populate(await accountReferences(req.user))
        .sort(sort)
        .skip(skip)
        .limit(limit),
      AccountTransaction.countDocuments(query)
    ]);
    
    res.status(200).json({
      status: 'success',
      data: {
        transactions,
        pagination: {
          current: page,
          total: Math.ceil(totalTransactions / limit),
          count: transactions.length,
          totalTransactions
        }
      }
    });
    
  } catch (error) {
    console.error('Get account transactions error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching account transactions'
    });
  }
});

// @route   GET /api/accounts/balances
// @desc    Get account balances for the authenticated user
// @access  Private
router.get('/balances', protect, async (req, res) => {
  try {
    const data = await currentBalances(await accountScope(req.user));
    
    res.status(200).json({
      status: 'success',
      data
    });
    
  } catch (error) {
    console.error('Get account balances error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching account balances'
    });
  }
});

// @route   GET /api/accounts/cheques
// @desc    Get all cheques for the authenticated user
// @access  Private
router.get('/cheques', protect, [
  query('status').optional().isIn(['issued', 'deposited', 'cleared', 'bounced', 'cancelled']),
  query('search').optional().trim(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const {
      status,
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    // Build query (always scoped to authenticated user)
    const query = { userId: req.user._id };
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (search) {
      query.$or = [
        { chequeNumber: { $regex: search, $options: 'i' } },
        { bankName: { $regex: search, $options: 'i' } },
        { branchName: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    // Execute query
    const cheques = await Cheque.find(query)
      .populate('vendorId', 'name email phone')
      .populate('customerId', 'name email phone')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    // Get total count
    const totalCheques = await Cheque.countDocuments(query);
    
    res.status(200).json({
      status: 'success',
      data: {
        cheques,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalCheques / limit),
          count: cheques.length,
          totalCheques
        }
      }
    });
    
  } catch (error) {
    console.error('Get cheques error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching cheques'
    });
  }
});

// @route   POST /api/accounts/transactions
// @desc    Create new account transaction
// @access  Private
router.post('/transactions', protect, requirePermission('Accounts: Create & Edit'), transactionValidation, async (req, res) => {
  try {
    const linkProblem = await linkPaymentAccounts(req.user, req.body);
    if (linkProblem) return res.status(400).json({ status: 'error', message: linkProblem });
    if (validationFailure(req, res)) return;

    const invalidRelated = await validRelatedRecords(req.user, req.body);
    if (invalidRelated) return res.status(400).json({ status: 'error', message: `${invalidRelated} must belong to this business` });

    console.log('📝 Creating transaction with data:', req.body);
    console.log('👤 User ID:', req.user._id);

    const transactionData = {
      ...entryFields(req.body),
      userId: req.user._id,
      dataScope: req.user.dataScope
    };

    console.log('💾 Transaction data to save:', transactionData);

    const transaction = await AccountTransaction.createWithUniqueNumber(transactionData);
    console.log('✅ Transaction created:', transaction._id);


    // Populate the created transaction
    const populatedTransaction = await AccountTransaction.findById(transaction._id)
      .populate(await accountReferences(req.user));

    ActivityLog.logActivity({
      action: 'Account Transaction Created',
      description: `Account transaction ${transaction.transactionNumber} was created`,
      entityType: 'account_transaction',
      entityId: transaction._id,
      entityName: transaction.transactionNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create account transaction) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Account transaction created successfully',
      data: {
        transaction: populatedTransaction
      }
    });

  } catch (error) {
    console.error('❌ Create account transaction error:', error);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error message:', error.message);

    if (error.stack) {
      console.error('❌ Error stack:', error.stack);
    }

    // Handle specific mongoose errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        status: 'error',
        message: 'Validation error',
        errors: Object.values(error.errors).map(err => ({
          field: err.path,
          message: err.message
        }))
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        status: 'error',
        message: 'Duplicate transaction number. Please try again.'
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Server error while creating account transaction',
      error: error.message
    });
  }
});

// @route   PUT /api/accounts/transactions/:id
// @desc    Update account transaction
// @access  Private
router.put('/transactions/:id', protect, requirePermission('Accounts: Create & Edit'), transactionValidation, async (req, res) => {
  try {
    const scope = await accountScope(req.user);
    const existing = await AccountTransaction.findOne({ _id: req.params.id, ...scope }).select('reconciled transferInReconciled sourcePaymentId sourceRefundPaymentId sourcePayrollId transactionNumber paymentAccountId transferDetails');
    const linkProblem = await linkPaymentAccounts(req.user, req.body, existing);
    if (linkProblem) return res.status(400).json({ status: 'error', message: linkProblem });
    if (validationFailure(req, res)) return;
    const invalidRelated = await validRelatedRecords(req.user, req.body);
    if (invalidRelated) return res.status(400).json({ status: 'error', message: `${invalidRelated} must belong to this business` });
    if (existing?.sourcePaymentId || existing?.sourceRefundPaymentId) return res.status(409).json({ status: 'error', message: 'This entry belongs to a customer payment. Change it in Payments.' });
    if (existing?.transactionNumber?.startsWith('TXN-OPN-')) return res.status(409).json({ status: 'error', message: 'This is a payment account\'s opening balance. Change it on the payment account.' });
    if (existing?.sourcePayrollId) return res.status(409).json({ status: 'error', message: 'This entry is a paid payslip\'s salary. It is kept in step with the payslip in Payroll.' });
    if (existing?.reconciled || existing?.transferInReconciled) return res.status(409).json({ status: 'error', message: 'A reconciled entry cannot be edited.' });
    const changes = entryFields(req.body);
    const transaction = await AccountTransaction.findOneAndUpdate(
      { _id: req.params.id, ...scope, reconciled: { $ne: true }, transferInReconciled: { $ne: true }, sourcePaymentId: { $exists: false }, sourceRefundPaymentId: { $exists: false }, sourcePayrollId: { $exists: false } },
      // An entry that stops being a transfer no longer names a destination,
      // and one that no longer names a payment account drops the link.
      { $set: changes, ...(() => {
        const unset = { ...(changes.transferDetails ? {} : { transferDetails: '' }), ...(changes.paymentAccountId ? {} : { paymentAccountId: '' }) };
        return Object.keys(unset).length ? { $unset: unset } : {};
      })() },
      { new: true, runValidators: true }
    ).populate(await accountReferences(req.user));
    
    if (!transaction) {
      return res.status(404).json({
        status: 'error',
        message: 'Account transaction not found'
      });
    }
    

    ActivityLog.logActivity({
      action: 'Account Transaction Updated',
      description: `Account transaction ${transaction.transactionNumber} was updated`,
      entityType: 'account_transaction',
      entityId: transaction._id,
      entityName: transaction.transactionNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update account transaction) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Account transaction updated successfully',
      data: {
        transaction
      }
    });
    
  } catch (error) {
    console.error('Update account transaction error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating account transaction'
    });
  }
});

// @route   DELETE /api/accounts/transactions/:id
// @desc    Delete account transaction
// @access  Private
router.delete('/transactions/:id', protect, requirePermission('Accounts: Delete'), async (req, res) => {
  try {
    const scope = await accountScope(req.user);
    const existing = await AccountTransaction.findOne({ _id: req.params.id, ...scope }).select('reconciled transferInReconciled sourcePaymentId sourceRefundPaymentId sourcePayrollId transactionNumber');
    if (existing?.sourcePaymentId || existing?.sourceRefundPaymentId) return res.status(409).json({ status: 'error', message: 'This entry belongs to a customer payment. Delete or reverse it in Payments.' });
    if (existing?.transactionNumber?.startsWith('TXN-OPN-')) return res.status(409).json({ status: 'error', message: 'This is a payment account\'s opening balance. Change it on the payment account.' });
    if (existing?.sourcePayrollId) return res.status(409).json({ status: 'error', message: 'This entry is a paid payslip\'s salary, so it cannot be deleted on its own.' });
    if (existing?.reconciled || existing?.transferInReconciled) return res.status(409).json({ status: 'error', message: 'A reconciled entry cannot be deleted.' });
    const transaction = await AccountTransaction.findOneAndDelete({
      _id: req.params.id,
      ...scope,
      reconciled: { $ne: true },
      transferInReconciled: { $ne: true },
      sourcePaymentId: { $exists: false },
      sourceRefundPaymentId: { $exists: false },
      sourcePayrollId: { $exists: false }
    });
    
    if (!transaction) {
      return res.status(404).json({
        status: 'error',
        message: 'Account transaction not found'
      });
    }
    

    ActivityLog.logActivity({
      action: 'Account Transaction Deleted',
      description: `Account transaction ${transaction.transactionNumber} was deleted`,
      entityType: 'account_transaction',
      entityId: transaction._id,
      entityName: transaction.transactionNumber,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (delete account transaction) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Account transaction deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete account transaction error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting account transaction'
    });
  }
});

// @route   GET /api/accounts/stats/summary
// @desc    Get account statistics
// @access  Private
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const stats = await AccountTransaction.getTransactionStats(await accountScope(req.user));
    
    res.status(200).json({
      status: 'success',
      data: {
        stats
      }
    });
    
  } catch (error) {
    console.error('Get account stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching account statistics'
    });
  }
});

// @route   GET /api/accounts/stats/period?startDate&endDate
// @desc    Income, expense and net of every completed entry whose effective
//          date (postedAt, else createdAt) is in [startDate, endDate). The
//          client sends its own month boundaries, so "this month" follows the
//          business's timezone. Without dates: the current calendar month.
// @access  Private
router.get('/stats/period', protect, [
  query('startDate').optional().isISO8601().withMessage('Invalid start date'),
  query('endDate').optional().isISO8601().withMessage('Invalid end date')
], async (req, res) => {
  const { validationResult } = require('express-validator');
  const invalid = validationResult(req);
  if (!invalid.isEmpty()) return res.status(400).json({ status: 'error', message: invalid.array()[0].msg });
  const now = new Date();
  const start = req.query.startDate ? new Date(req.query.startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = req.query.endDate ? new Date(req.query.endDate) : new Date(start.getFullYear(), start.getMonth() + 1, 1);
  if (!(end > start)) return res.status(400).json({ status: 'error', message: 'The end date must be after the start date' });
  if (end - start > 366 * 864e5) return res.status(400).json({ status: 'error', message: 'Choose a period of at most a year' });
  try {
    const totals = await AccountTransaction.periodTotals(await accountScope(req.user), start, end);
    res.status(200).json({ status: 'success', data: { startDate: start, endDate: end, ...totals } });
  } catch (error) {
    console.error('Get account period totals error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while totalling the period' });
  }
});

// @route   GET /api/accounts/reports/summary
// @desc    Profit & loss for a period (income, expenses, net) + current balances
// @access  Private — the admin (business owner) only, whatever else a login may see
router.get('/reports/summary', protect, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Only the owner can see the profit & loss report.', code: 'PERMISSION_DENIED' });
  }
  try {
    const period = req.query.period || 'month';
    const now = new Date();
    let start;
    switch (period) {
      case 'week': {
        start = new Date(now);
        const day = start.getDay();          // 0 = Sunday
        const diff = day === 0 ? 6 : day - 1; // back to Monday
        start.setDate(start.getDate() - diff);
        start.setHours(0, 0, 0, 0);
        break;
      }
      case 'quarter': {
        const q = Math.floor(now.getMonth() / 3);
        start = new Date(now.getFullYear(), q * 3, 1);
        break;
      }
      case 'year':
        start = new Date(now.getFullYear(), 0, 1);
        break;
      case 'month':
      default:
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
    }

    // Use the statement/transaction date when supplied. A backdated entry
    // belongs to that period, not the month someone typed it into the ERP.
    // The report is for the whole business: entries are not attributed to
    // the login that typed them, so there is no per-user profit.
    const { income: totalIncome, expense: totalExpenses, net: netProfit } =
      await AccountTransaction.periodTotals(await accountScope(req.user), start, new Date(now.getTime() + 1));

    // Current balances (point-in-time, not period-bound)
    const { currentBalances: balance } = await currentBalances(await accountScope(req.user));
    const cashBalance = balance.cashBalance;
    const bankBalance = balance.bankBalance;

    res.status(200).json({
      status: 'success',
      data: {
        report: {
          period,
          startDate: start,
          totalIncome,
          totalExpenses,
          netProfit,
          cashFlow: netProfit, // operating cash flow ≈ net for this model
          cashBalance,
          bankBalance
        }
      }
    });
  } catch (error) {
    console.error('Get account report summary error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while generating report summary'
    });
  }
});

// @route   GET /api/accounts/ledger
// @desc    Get account ledger entries
// @access  Private
router.get('/ledger', protect, [
  query('accountType').optional().isIn(['cash', 'bank', 'credit_card', 'loan', 'investment']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const {
      accountType,
      startDate,
      endDate,
      page = 1,
      limit = 50
    } = req.query;
    
    // Build query - scoped per admin
    const query = { status: 'completed', ...(await accountScope(req.user)) };
    
    if (accountType && accountType !== 'all') {
      query.accountType = accountType;
    }
    
    if (startDate || endDate) {
      const date = { $ifNull: ['$postedAt', '$createdAt'] };
      const conditions = [];
      if (startDate) conditions.push({ $gte: [date, new Date(startDate)] });
      if (endDate) conditions.push({ $lte: [date, new Date(endDate)] });
      query.$expr = conditions.length === 1 ? conditions[0] : { $and: conditions };
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Execute query
    const transactions = await AccountTransaction.find(query)
      .populate(await accountReferences(req.user))
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    // Get total count
    const totalTransactions = await AccountTransaction.countDocuments(query);
    
    res.status(200).json({
      status: 'success',
      data: {
        transactions,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalTransactions / limit),
          count: transactions.length,
          totalTransactions
        }
      }
    });
    
  } catch (error) {
    console.error('Get account ledger error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching account ledger'
    });
  }
});

const TYPE_LABEL = { income: 'Income', expense: 'Expense', transfer: 'Transfer', opening_balance: 'Opening balance', adjustment: 'Adjustment' };
const exportDate = (date) => new Date(date).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });

// @route   GET /api/accounts/reports/export
// @desc    Export account report to Excel with invoice data
// @access  Private
router.get('/reports/export', protect, [
  query('period').optional().isIn(['week', 'month', 'quarter', 'year']),
  query('format').optional().isIn(['pdf', 'excel']),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601()
], async (req, res) => {
  try {
    const {
      period = 'month',
      format = 'excel',
      startDate,
      endDate
    } = req.query;

    // Calculate date range based on period
    let start, end;
    const now = new Date();

    if (startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
      if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) end.setDate(end.getDate() + 1);
    } else {
      switch (period) {
        case 'week':
          start = new Date(now.setDate(now.getDate() - 7));
          end = new Date();
          break;
        case 'month':
          start = new Date(now.getFullYear(), now.getMonth(), 1);
          end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          break;
        case 'quarter':
          const quarter = Math.floor(now.getMonth() / 3);
          start = new Date(now.getFullYear(), quarter * 3, 1);
          end = new Date(now.getFullYear(), quarter * 3 + 3, 1);
          break;
        case 'year':
          start = new Date(now.getFullYear(), 0, 1);
          end = new Date(now.getFullYear() + 1, 0, 1);
          break;
      }
    }

    // Fetch account transactions for the period
    const effectiveDate = { $ifNull: ['$postedAt', '$createdAt'] };
    const transactionQuery = {
      $expr: { $and: [{ $gte: [effectiveDate, start] }, { $lt: [effectiveDate, end] }] },
      status: 'completed',
      ...(await accountScope(req.user))
    };

    const transactions = (await AccountTransaction.find(transactionQuery)
      .populate(await accountReferences(req.user))
      .populate('userId', 'fullName email'))
      .sort((a, b) => (b.postedAt || b.createdAt) - (a.postedAt || a.createdAt));

    // Generate Excel file
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Transactions Report');

    // Set column headers for transactions
    worksheet.columns = [
      { header: 'Transaction Date', key: 'transactionDate', width: 18 },
      { header: 'Transaction #', key: 'transactionNumber', width: 20 },
      { header: 'Description', key: 'description', width: 35 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Type', key: 'type', width: 16 },
      { header: 'Payment Method', key: 'paymentMethod', width: 18 },
      { header: 'Account Type', key: 'accountType', width: 20 },
      { header: 'Amount', key: 'amount', width: 15 },
      { header: 'Status', key: 'status', width: 12 }
    ];

    // Style the header row
    worksheet.getRow(1).font = { bold: true, size: 11 };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Add transaction data. The date is the effective one (statement date,
    // else when it was entered), as a calendar day in India.
    const accountLabel = (type) => (type ? type.replace('_', ' ').toUpperCase() : 'N/A');
    transactions.forEach(transaction => {
      const transfer = transaction.transactionType === 'transfer';
      worksheet.addRow({
        transactionDate: exportDate(transaction.postedAt || transaction.createdAt),
        transactionNumber: transaction.transactionNumber || 'N/A',
        description: transaction.description,
        category: transaction.category,
        type: TYPE_LABEL[transaction.transactionType] || transaction.transactionType,
        paymentMethod: transaction.paymentMethod ? transaction.paymentMethod.replace('_', ' ').toUpperCase() : 'N/A',
        accountType: transfer && transaction.transferDetails?.toAccountType
          ? `${accountLabel(transaction.accountType)} → ${accountLabel(transaction.transferDetails.toAccountType)}`
          : accountLabel(transaction.accountType),
        amount: transaction.amount,
        status: transaction.status ? transaction.status.toUpperCase() : 'COMPLETED'
      });
    });

    // Add number formatting for amount column
    worksheet.getColumn('amount').numFmt = '₹#,##0.00';
    worksheet.getColumn('amount').alignment = { horizontal: 'right' };

    // Center align some columns
    ['type', 'status', 'paymentMethod', 'accountType'].forEach(col => {
      worksheet.getColumn(col).alignment = { horizontal: 'center' };
    });

    // Set response headers for Excel download
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=transactions-report-${period}-${Date.now()}.xlsx`
    );

    // Write to response
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Export account report error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while exporting account report'
    });
  }
});

module.exports = router;
