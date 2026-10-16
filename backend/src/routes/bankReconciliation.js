const express = require('express');
const mongoose = require('mongoose');
const AccountTransaction = require('../models/AccountTransaction');
const BankReconciliation = require('../models/BankReconciliation');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { orgUserFilter } = require('../utils/accessScope');
const { settingsOwnerId } = require('../utils/businessSettings');

const router = express.Router();
const TYPES = ['income', 'expense', 'transfer', 'opening_balance'];
const cents = (value) => Math.round(Number(value) * 100);
// Bank statement dates are calendar days in India, including all entries until midnight IST.
const dayEnd = (date) => new Date(date.getTime() + 18.5 * 60 * 60 * 1000);
const signedCents = (transaction) =>
  (transaction.transactionType === 'expense' || transaction.transactionType === 'transfer' ? -1 : 1) * cents(transaction.amount);

function statementDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

const eligible = (scope, accountName, date) => ({
  ...scope,
  accountType: 'bank',
  accountName,
  status: 'completed',
  transactionType: { $in: TYPES },
  reconciled: { $ne: true },
  $or: [
    { postedAt: { $lt: dayEnd(date) } },
    { postedAt: { $exists: false }, createdAt: { $lt: dayEnd(date) } }
  ]
});

router.get('/', protect, async (req, res) => {
  const date = statementDate(req.query.statementDate);
  if (req.query.statementDate && !date) return res.status(400).json({ status: 'error', message: 'Enter a valid statement date.' });
  const accountName = typeof req.query.accountName === 'string' ? req.query.accountName.trim() : '';
  try {
    const scope = await orgUserFilter(req.user);
    const [accounts, history] = await Promise.all([
      AccountTransaction.distinct('accountName', { ...scope, accountType: 'bank', status: 'completed' }),
      BankReconciliation.find({ ...scope, ...(accountName ? { accountName } : {}) }).sort({ statementDate: -1 }).limit(20).lean()
    ]);
    if (!accountName || !date) return res.json({ status: 'success', data: { accounts, history } });
    if (!accounts.includes(accountName)) return res.status(404).json({ status: 'error', message: 'Bank account not found.' });
    const [previous, transactions] = await Promise.all([
      BankReconciliation.findOne({ ...scope, accountName }).sort({ statementDate: -1 }).lean(),
      AccountTransaction.find(eligible(scope, accountName, date)).sort({ createdAt: 1, _id: 1 }).lean()
    ]);
    res.json({ status: 'success', data: {
      accounts, history, previous,
      openingBalance: previous ? previous.closingBalance : 0,
      transactions
    } });
  } catch (error) {
    console.error('Bank reconciliation preview error:', error);
    res.status(500).json({ status: 'error', message: 'Could not load bank reconciliation.' });
  }
});

router.get('/:id', protect, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: 'error', message: 'Invalid reconciliation ID.' });
  try {
    const scope = await orgUserFilter(req.user);
    const reconciliation = await BankReconciliation.findOne({ _id: req.params.id, ...scope }).lean();
    if (!reconciliation) return res.status(404).json({ status: 'error', message: 'Reconciliation not found.' });
    const transactions = await AccountTransaction.find({ _id: { $in: reconciliation.transactionIds }, ...scope }).sort({ createdAt: 1 }).lean();
    res.json({ status: 'success', data: { reconciliation, transactions } });
  } catch (error) {
    console.error('Bank reconciliation detail error:', error);
    res.status(500).json({ status: 'error', message: 'Could not load reconciliation.' });
  }
});

router.post('/', protect, requirePermission('Accounts: Create & Edit'), async (req, res) => {
  const accountName = typeof req.body.accountName === 'string' ? req.body.accountName.trim() : '';
  const date = statementDate(req.body.statementDate);
  const closingBalance = Number(req.body.closingBalance);
  const ids = req.body.transactionIds;
  if (!accountName || !date || req.body.closingBalance === '' || req.body.closingBalance == null ||
      !Number.isFinite(closingBalance) || Math.abs(cents(closingBalance) - closingBalance * 100) > 0.000001 ||
      !Array.isArray(ids) || ids.some((id) => !mongoose.isValidObjectId(id)) ||
      new Set(ids.map(String)).size !== ids.length) {
    return res.status(400).json({ status: 'error', message: 'Enter a bank account, valid statement date and closing balance, and unique transaction IDs.' });
  }
  try {
    const userId = req.user._id;
    const scope = await orgUserFilter(req.user);
    const ownerId = await settingsOwnerId(req.user);
    const accountExists = await AccountTransaction.exists({ ...scope, accountType: 'bank', accountName, status: 'completed' });
    if (!accountExists) return res.status(404).json({ status: 'error', message: 'Bank account not found.' });
    const previous = await BankReconciliation.findOne({ ...scope, accountName }).sort({ statementDate: -1 }).lean();
    if (previous && date <= previous.statementDate) {
      return res.status(409).json({ status: 'error', message: 'Use a statement date after the last reconciliation.' });
    }
    const matching = await AccountTransaction.find({ ...eligible(scope, accountName, date), _id: { $in: ids } }).lean();
    if (matching.length !== ids.length) {
      return res.status(409).json({ status: 'error', message: 'Some entries are unavailable or already reconciled. Refresh and try again.' });
    }
    const openingCents = cents(previous ? previous.closingBalance : 0);
    const clearedCents = matching.reduce((sum, transaction) => sum + signedCents(transaction), 0);
    if (openingCents + clearedCents !== cents(closingBalance)) {
      return res.status(400).json({ status: 'error', message: 'The selected entries do not match the statement closing balance.' });
    }
    const reconciliation = await BankReconciliation.create({
      userId: ownerId, accountName, statementDate: date,
      openingBalance: openingCents / 100, closingBalance,
      clearedTotal: clearedCents / 100, transactionIds: ids,
      reconciledBy: userId
    });
    try {
      const result = await AccountTransaction.updateMany(
        { ...eligible(scope, accountName, date), _id: { $in: ids } },
        { $set: { reconciled: true, reconciledAt: new Date(), reconciledBy: userId, reconciliationId: reconciliation._id } }
      );
      if (result.modifiedCount !== ids.length) throw new Error('Entries changed during reconciliation');
    } catch (error) {
      await AccountTransaction.updateMany({ reconciliationId: reconciliation._id, ...scope },
        { $set: { reconciled: false }, $unset: { reconciledAt: '', reconciledBy: '', reconciliationId: '' } });
      await BankReconciliation.deleteOne({ _id: reconciliation._id });
      return res.status(409).json({ status: 'error', message: 'Entries changed during reconciliation. Refresh and try again.' });
    }
    res.status(201).json({ status: 'success', data: { reconciliation } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', message: 'This statement date has already been reconciled.' });
    console.error('Bank reconciliation save error:', error);
    res.status(500).json({ status: 'error', message: 'Could not save bank reconciliation.' });
  }
});

module.exports = router;
