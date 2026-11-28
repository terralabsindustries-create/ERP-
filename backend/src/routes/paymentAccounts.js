const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const PaymentAccount = require('../models/PaymentAccount');
const AccountTransaction = require('../models/AccountTransaction');
const BankReconciliation = require('../models/BankReconciliation');
const Payment = require('../models/Payment');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const { validate } = require('../middleware/validate');
const { accountScope } = require('../utils/accountScope');
const { orgUserFilter } = require('../utils/accessScope');
const { paymentAccountScope } = require('../utils/paymentAccounts');
const { inTransaction } = require('../utils/transactions');

/*
  Payment receiving accounts (Cash, Paytm, bank accounts), their balances and
  the daily closing report.

  Balances are never stored: they are worked out from completed ledger
  entries linked to the account (AccountTransaction.paymentAccountActivity) —
  the opening balance entry, payments received, refunds and other money paid
  out, transfers and balance adjustments.

  Days are calendar days in India (IST), like bank statements.
*/
const router = express.Router();
router.use(protect);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
/** Midnight IST at the start of a YYYY-MM-DD day. */
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS);
const istToday = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

const KIND_LABEL = { cash: 'Cash', bank: 'Bank', wallet: 'Wallet / UPI' };

/** An account as the API returns it: the account number masked unless `reveal`. */
function present(account, { reveal = false, balance } = {}) {
  const { accountNumber, nicknameKey, openingEntryId, __v, ...rest } = account;
  return {
    ...rest,
    accountNumberMasked: PaymentAccount.mask(accountNumber),
    ...(reveal ? { accountNumber: accountNumber || '' } : {}),
    ...(balance !== undefined ? { balance: round2(balance) } : {})
  };
}

const log = (req, account, action, description, actionType, extra = {}) =>
  ActivityLog.logActivity({
    action, description, entityType: 'account_transaction', entityId: account._id, entityName: account.nickname,
    performedBy: req.user._id, performedByName: req.user.fullName, actionType, severity: 'medium',
    userId: req.user._id, dataScope: req.user.dataScope, ...extra
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

const findAccount = async (req, id) =>
  mongoose.isValidObjectId(id) ? PaymentAccount.findOne({ _id: id, ...paymentAccountScope(req.user) }).lean() : null;

/** Current balance of each account id, from the ledger. */
async function balancesOf(user, ids) {
  const far = new Date(8.64e15);
  const rows = await AccountTransaction.paymentAccountActivity(await accountScope(user), far, far);
  const byId = new Map(rows.map((r) => [String(r._id), r.before]));
  return new Map(ids.map((id) => [String(id), round2(byId.get(String(id)) || 0)]));
}

/** The opening balance entry an account's opening balance is posted as. */
const openingEntry = (account, user) => ({
  transactionType: 'opening_balance',
  category: 'opening_balance',
  amount: round2(account.openingBalance),
  description: `Opening balance of ${account.nickname}`,
  postedAt: account.openingDate,
  paymentMethod: account.kind === 'cash' ? 'cash' : 'bank_transfer',
  accountType: PaymentAccount.ledgerType(account.kind),
  accountName: account.nickname,
  paymentAccountId: account._id,
  status: 'completed',
  userId: user._id,
  dataScope: user.dataScope
});

const accountRules = (isNew) => [
  ...(isNew ? [body('kind').isIn(PaymentAccount.KINDS).withMessage('Choose cash, bank or wallet')] : [body('kind').optional().isIn(PaymentAccount.KINDS)]),
  body('nickname')[isNew ? 'exists' : 'optional']().isString().trim().isLength({ min: 1, max: 60 }).withMessage('Give the account a name (up to 60 characters)'),
  body('bankName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  body('accountHolderName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  body('accountNumber').optional({ values: 'falsy' }).isString().trim().matches(/^[0-9A-Za-z]{4,34}$/).withMessage('Enter the account number without spaces (4–34 letters or digits)'),
  body('ifscCode').optional({ values: 'falsy' }).isString().trim().matches(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/).withMessage('Enter a valid 11-character IFSC code'),
  body('provider').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
  body('walletId').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  body('openingBalance').optional({ values: 'null' }).isFloat({ min: -1e12, max: 1e12 }).withMessage('Opening balance must be a number'),
  body('openingDate').optional({ values: 'falsy' }).custom(isDay).withMessage('Choose a valid opening date'),
  body('isActive').optional().isBoolean(),
  body('notes').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 })
];

const FIELDS = ['nickname', 'bankName', 'accountHolderName', 'accountNumber', 'ifscCode', 'provider', 'walletId', 'notes'];
const pick = (b) => Object.fromEntries(FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, typeof b[k] === 'string' ? b[k].trim() : b[k]]));

// GET /api/payment-accounts?active=true — the business's accounts. Balances
// are included for Accounts logins; others (recording a payment) get names.
router.get('/', [query('active').optional().isBoolean()], validate, async (req, res) => {
  try {
    const filter = { ...paymentAccountScope(req.user), ...(req.query.active === 'true' ? { isActive: true } : {}) };
    const accounts = await PaymentAccount.find(filter).sort({ isActive: -1, kind: 1, nickname: 1 }).lean();
    const withBalance = userCan(req.user, 'Accounts');
    const balances = withBalance ? await balancesOf(req.user, accounts.map((a) => a._id)) : null;
    res.json({ status: 'success', data: { accounts: accounts.map((a) => present(a, withBalance ? { balance: balances.get(String(a._id)) } : {})) } });
  } catch (error) {
    console.error('List payment accounts error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading payment accounts' });
  }
});

/*
  GET /api/payment-accounts/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=
  Daily closing (one day, the default today) or a period, per account:
  opening balance, payments received, other money in, money paid out and
  closing balance (= opening + received + other in − paid out), plus the
  current balance. Collections are this period's receipts; balances are what
  the account holds. Payments recorded without an account are shown apart.
*/
/*
  GET /api/payment-accounts/collections?from=&to=&accountId=<id|unassigned>&kind=cash|bank|wallet
      &paymentMethod=&search=&page=&limit=[&format=csv]
  The payments behind the collection figures above, one row per receipt: the
  same ledger entries (completed, from a payment, dated by when they were
  posted, India days), so the list's total equals the summary's "collected".
*/
const COLLECTION_METHODS = ['cash', 'cheque', 'bank_transfer', 'card', 'upi', 'wallet'];
router.get('/collections', requirePermission('Accounts'), [
  query('from').optional().custom(isDay).withMessage('Choose a valid start day'),
  query('to').optional().custom(isDay).withMessage('Choose a valid end day'),
  query('accountId').optional().custom((v) => v === 'unassigned' || mongoose.isValidObjectId(v)).withMessage('Choose a valid account'),
  query('kind').optional().isIn(PaymentAccount.KINDS).withMessage('Choose cash, bank or wallet'),
  query('paymentMethod').optional().isIn(COLLECTION_METHODS).withMessage('Choose a valid payment method'),
  query('search').optional().isString().trim().isLength({ max: 100 }),
  query('sort').optional().isIn(['date', '-date', 'amount', '-amount']),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
  query('format').optional().isIn(['csv'])
], validate, async (req, res) => {
  try {
    const fromDay = req.query.from || req.query.to || istToday();
    const toDay = req.query.to || fromDay;
    if (toDay < fromDay) return res.status(400).json({ status: 'error', message: 'The end day is before the start day' });
    const from = istStart(fromDay);
    const to = new Date(istStart(toDay).getTime() + DAY_MS);
    if (to - from > 370 * DAY_MS) return res.status(400).json({ status: 'error', message: 'Choose a period of at most a year' });

    const accounts = await PaymentAccount.find(paymentAccountScope(req.user)).select('nickname kind isActive').lean();
    const accountById = new Map(accounts.map((a) => [String(a._id), a]));
    const where = [await accountScope(req.user), { status: 'completed', sourcePaymentId: { $exists: true } }];
    const { accountId, kind } = req.query;
    if (accountId === 'unassigned') where.push({ paymentAccountId: { $exists: false } });
    else if (accountId) where.push({ paymentAccountId: new mongoose.Types.ObjectId(accountId) });
    if (kind) where.push({ paymentAccountId: { $in: accounts.filter((a) => a.kind === kind).map((a) => a._id) } });

    const after = [];
    if (req.query.paymentMethod) after.push({ $match: { method: req.query.paymentMethod } });
    if (req.query.search) {
      const rx = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      after.push({ $match: { $or: [
        { 'payment.paymentId': rx }, { 'payment.customerName': rx }, { 'payment.invoiceNumber': rx },
        { 'payment.allocations.invoiceNumber': rx }, { 'payment.referenceNumber': rx }, { referenceNumber: rx }
      ] } });
    }
    const [sortKey, sortDir] = (req.query.sort || '-date').startsWith('-') ? [req.query.sort?.slice(1) || 'date', -1] : [req.query.sort, 1];
    const csv = req.query.format === 'csv';
    const limit = csv ? 5000 : req.query.limit || 50;
    const page = csv ? 1 : req.query.page || 1;

    const [result] = await AccountTransaction.aggregate([
      { $match: { $and: where } },
      { $addFields: { date: { $ifNull: ['$postedAt', '$createdAt'] } } },
      { $match: { date: { $gte: from, $lt: to } } },
      {
        $lookup: {
          from: Payment.collection.name,
          localField: 'sourcePaymentId',
          foreignField: '_id',
          as: 'payment',
          pipeline: [{ $project: { paymentId: 1, customerName: 1, customerId: 1, invoiceNumber: 1, 'allocations.invoiceNumber': 1, paymentMethod: 1, referenceNumber: 1, collectedByName: 1, paymentDate: 1 } }]
        }
      },
      { $unwind: { path: '$payment', preserveNullAndEmptyArrays: true } },
      { $addFields: { method: { $ifNull: ['$payment.paymentMethod', '$paymentMethod'] } } },
      ...after,
      {
        $facet: {
          rows: [
            { $sort: { [sortKey === 'amount' ? 'amount' : 'date']: sortDir, _id: sortDir } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            { $project: { date: 1, amount: 1, method: 1, paymentAccountId: 1, referenceNumber: 1, payment: 1 } }
          ],
          totals: [{ $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } }],
          byMethod: [{ $group: { _id: '$method', count: { $sum: 1 }, amount: { $sum: '$amount' } } }, { $sort: { amount: -1 } }]
        }
      }
    ]);

    const rows = (result?.rows || []).map((r) => {
      const account = r.paymentAccountId ? accountById.get(String(r.paymentAccountId)) : null;
      const p = r.payment || {};
      const invoices = [...new Set([...(p.allocations || []).map((a) => a.invoiceNumber), p.invoiceNumber].filter(Boolean))];
      return {
        _id: r._id,
        date: r.date,
        amount: round2(r.amount),
        method: r.method || null,
        account: account ? { _id: account._id, nickname: account.nickname, kind: account.kind, kindLabel: KIND_LABEL[account.kind] } : null,
        payment: r.payment ? { _id: p._id, paymentId: p.paymentId, customerName: p.customerName || '', invoices, reference: p.referenceNumber || r.referenceNumber || '', collectedByName: p.collectedByName || '' } : null
      };
    });
    const totals = { count: result?.totals[0]?.count || 0, amount: round2(result?.totals[0]?.amount || 0) };

    if (csv) {
      const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const when = (d) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 16).replace('T', ' ');
      const lines = [
        ['Date (IST)', 'Payment no.', 'Customer', 'Invoices', 'Method', 'Received into', 'Reference', 'Amount'],
        ...rows.map((r) => [when(r.date), r.payment?.paymentId, r.payment?.customerName, r.payment?.invoices.join(' '), r.method, r.account ? r.account.nickname : 'Not in an account', r.payment?.reference, r.amount.toFixed(2)]),
        [],
        ['Total', '', '', '', '', '', `${totals.count} payments`, totals.amount.toFixed(2)]
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="payment-collections_${fromDay}_to_${toDay}.csv"`);
      return res.send(`﻿${lines.map((l) => l.map(cell).join(',')).join('\n')}`);
    }

    res.json({
      status: 'success',
      data: {
        from: fromDay,
        to: toDay,
        rows,
        totals,
        byMethod: (result?.byMethod || []).map((m) => ({ method: m._id, count: m.count, amount: round2(m.amount) })),
        accounts: accounts.map((a) => ({ _id: a._id, nickname: a.nickname, kind: a.kind, kindLabel: KIND_LABEL[a.kind], isActive: a.isActive })),
        pagination: { page, limit, total: totals.count }
      }
    });
  } catch (error) {
    console.error('Payment collections list error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while listing the collections' });
  }
});

router.get('/summary', requirePermission('Accounts'), [
  query('from').optional().custom(isDay).withMessage('Choose a valid start day'),
  query('to').optional().custom(isDay).withMessage('Choose a valid end day'),
  query('accountId').optional().isMongoId()
], validate, async (req, res) => {
  try {
    const fromDay = req.query.from || req.query.to || istToday();
    const toDay = req.query.to || fromDay;
    if (toDay < fromDay) return res.status(400).json({ status: 'error', message: 'The end day is before the start day' });
    const from = istStart(fromDay);
    const to = new Date(istStart(toDay).getTime() + DAY_MS);
    if (to - from > 370 * DAY_MS) return res.status(400).json({ status: 'error', message: 'Choose a period of at most a year' });

    const accounts = await PaymentAccount.find({ ...paymentAccountScope(req.user), ...(req.query.accountId ? { _id: req.query.accountId } : {}) })
      .sort({ isActive: -1, kind: 1, nickname: 1 }).lean();
    const scope = await accountScope(req.user);
    const [activity, unassigned] = await Promise.all([
      AccountTransaction.paymentAccountActivity(scope, from, to),
      req.query.accountId ? [] : AccountTransaction.aggregate([
        { $match: { $and: [scope, { status: 'completed', sourcePaymentId: { $exists: true }, paymentAccountId: { $exists: false } }] } },
        { $project: { amount: 1, date: { $ifNull: ['$postedAt', '$createdAt'] } } },
        { $match: { date: { $gte: from, $lt: to } } },
        { $group: { _id: null, received: { $sum: '$amount' }, count: { $sum: 1 } } }
      ])
    ]);
    const byId = new Map(activity.map((r) => [String(r._id), r]));
    const rows = accounts.map((a) => {
      const r = byId.get(String(a._id)) || {};
      const opening = round2((r.before || 0) + (r.openingInPeriod || 0));
      const received = round2(r.received || 0);
      const otherIn = round2(r.otherIn || 0);
      const paidOut = round2(r.paidOut || 0);
      const closing = round2(opening + received + otherIn - paidOut);
      return {
        _id: a._id, nickname: a.nickname, kind: a.kind, kindLabel: KIND_LABEL[a.kind], isActive: a.isActive,
        opening, received, receivedCount: r.receivedCount || 0, otherIn, paidOut, closing,
        currentBalance: round2(closing + (r.after || 0))
      };
    });
    const sum = (key, list = rows) => round2(list.reduce((s, r) => s + r[key], 0));
    const byKind = Object.fromEntries(PaymentAccount.KINDS.map((k) => {
      const list = rows.filter((r) => r.kind === k);
      return [k, { received: sum('received', list), closing: sum('closing', list), currentBalance: sum('currentBalance', list) }];
    }));
    const unassignedReceived = round2(unassigned[0]?.received || 0);
    res.json({
      status: 'success',
      data: {
        from: fromDay, to: toDay,
        accounts: rows,
        byKind,
        unassigned: { received: unassignedReceived, count: unassigned[0]?.count || 0 },
        totals: {
          opening: sum('opening'), received: sum('received'), otherIn: sum('otherIn'), paidOut: sum('paidOut'),
          closing: sum('closing'), currentBalance: sum('currentBalance'),
          // Everything collected in the period, including payments not yet put in an account.
          collected: round2(sum('received') + unassignedReceived)
        }
      }
    });
  } catch (error) {
    console.error('Payment account summary error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building the collection summary' });
  }
});

// GET /api/payment-accounts/:id?reveal=true — one account; the full account
// number only for logins that can edit accounts, and only when asked.
router.get('/:id', [query('reveal').optional().isBoolean()], validate, async (req, res) => {
  try {
    const account = await findAccount(req, req.params.id);
    if (!account) return res.status(404).json({ status: 'error', message: 'Payment account not found' });
    const reveal = req.query.reveal === 'true' && userCan(req.user, 'Accounts: Create & Edit');
    const balance = userCan(req.user, 'Accounts') ? (await balancesOf(req.user, [account._id])).get(String(account._id)) : undefined;
    res.json({ status: 'success', data: { account: present(account, { reveal, balance }) } });
  } catch (error) {
    console.error('Get payment account error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading the payment account' });
  }
});

/*
  GET /api/payment-accounts/:id/ledger?from&to&page&limit
  Every entry that moved money in or out of the account, newest first:
  payments received, refunds, transfers, adjustments and the opening balance.
*/
router.get('/:id/ledger', requirePermission('Accounts'), [
  query('from').optional().custom(isDay), query('to').optional().custom(isDay),
  query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const account = await findAccount(req, req.params.id);
    if (!account) return res.status(404).json({ status: 'error', message: 'Payment account not found' });
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const date = { $ifNull: ['$postedAt', '$createdAt'] };
    const range = [];
    if (req.query.from) range.push({ $gte: [date, istStart(req.query.from)] });
    if (req.query.to) range.push({ $lt: [date, new Date(istStart(req.query.to).getTime() + DAY_MS)] });
    const filter = {
      $and: [
        await accountScope(req.user),
        { $or: [{ paymentAccountId: account._id }, { 'transferDetails.toPaymentAccountId': account._id }] },
        ...(range.length ? [{ $expr: range.length === 1 ? range[0] : { $and: range } }] : [])
      ]
    };
    const [entries, total] = await Promise.all([
      AccountTransaction.find(filter).sort({ postedAt: -1, createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
        .populate('customerId', 'name').populate('invoiceId', 'invoiceNumber').lean(),
      AccountTransaction.countDocuments(filter)
    ]);
    const into = (e) => String(e.transferDetails?.toPaymentAccountId || '') === String(account._id) && String(e.paymentAccountId || '') !== String(account._id);
    const direction = (e) => {
      if (e.transactionType === 'transfer') return into(e) ? 'in' : 'out';
      if (e.transactionType === 'adjustment') return e.adjustmentDirection || null;
      return e.transactionType === 'expense' ? 'out' : 'in';
    };
    res.json({
      status: 'success',
      data: {
        account: present(account),
        entries: entries.map((e) => ({ ...e, direction: direction(e), date: e.postedAt || e.createdAt })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      }
    });
  } catch (error) {
    console.error('Payment account ledger error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading the account history' });
  }
});

// POST /api/payment-accounts — add an account (and its opening balance entry)
router.post('/', requirePermission('Accounts: Create & Edit'), accountRules(true), validate, async (req, res) => {
  try {
    const data = pick(req.body);
    const account = await inTransaction(async ({ session, onUndo }) => {
      const [created] = await PaymentAccount.create([{
        ...data,
        kind: req.body.kind,
        nicknameKey: PaymentAccount.nicknameKey(data.nickname),
        openingBalance: round2(req.body.openingBalance || 0),
        openingDate: istStart(req.body.openingDate || istToday()),
        isActive: req.body.isActive !== false,
        userId: req.user._id,
        dataScope: req.user.dataScope
      }], { session });
      onUndo(() => PaymentAccount.deleteOne({ _id: created._id }));
      if (created.openingBalance !== 0) {
        const [entry] = await AccountTransaction.create([{ ...openingEntry(created, req.user), transactionNumber: `TXN-OPN-${created._id}` }], { session });
        onUndo(() => AccountTransaction.deleteOne({ _id: entry._id }));
        await PaymentAccount.updateOne({ _id: created._id }, { $set: { openingEntryId: entry._id } }, { session });
      }
      return created;
    }, { label: 'Payment account' });
    log(req, account, 'Payment Account Added', `Payment account ${account.nickname} (${KIND_LABEL[account.kind]}) was added`, 'create');
    res.status(201).json({ status: 'success', data: { account: present((await PaymentAccount.findById(account._id).lean()) || account.toObject()) } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', message: 'There is already an account with that name' });
    console.error('Create payment account error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while adding the payment account' });
  }
});

/*
  PUT /api/payment-accounts/:id — edit details, rename, (de)activate, or
  change the opening balance. A rename carries over to the account's ledger
  entries and bank reconciliations, so its history stays together. An
  account with entries cannot change between cash and bank/wallet.
*/
router.put('/:id', requirePermission('Accounts: Create & Edit'), accountRules(false), validate, async (req, res) => {
  try {
    const account = await findAccount(req, req.params.id);
    if (!account) return res.status(404).json({ status: 'error', message: 'Payment account not found' });
    const set = pick(req.body);
    // A blank account number in an edit keeps the stored one (the form shows it masked).
    if (set.accountNumber === '') delete set.accountNumber;
    if (set.nickname !== undefined) set.nicknameKey = PaymentAccount.nicknameKey(set.nickname);
    if (req.body.isActive !== undefined) set.isActive = req.body.isActive === true || req.body.isActive === 'true';

    const ledgerFilter = { $or: [{ paymentAccountId: account._id }, { 'transferDetails.toPaymentAccountId': account._id }] };
    if (req.body.kind && req.body.kind !== account.kind) {
      const used = await AccountTransaction.exists({ ...ledgerFilter, _id: { $ne: account.openingEntryId } }) || await Payment.exists({ paymentAccountId: account._id });
      if (used && PaymentAccount.ledgerType(req.body.kind) !== PaymentAccount.ledgerType(account.kind)) {
        return res.status(409).json({ status: 'error', message: 'This account has transactions, so it cannot change between cash and bank. Add a new account instead.' });
      }
      set.kind = req.body.kind;
    }
    const openingChanged = req.body.openingBalance !== undefined || req.body.openingDate;
    const openingBalance = req.body.openingBalance !== undefined ? round2(req.body.openingBalance || 0) : account.openingBalance;
    const openingDate = req.body.openingDate ? istStart(req.body.openingDate) : account.openingDate;
    if (openingChanged) Object.assign(set, { openingBalance, openingDate });

    const opening = account.openingEntryId ? await AccountTransaction.findById(account.openingEntryId).lean() : null;
    if (openingChanged && opening?.reconciled && (round2(opening.amount) !== openingBalance || +opening.postedAt !== +openingDate)) {
      return res.status(409).json({ status: 'error', message: 'The opening balance is part of a bank reconciliation, so it cannot change.' });
    }

    const updated = await inTransaction(async ({ session, onUndo }) => {
      const after = await PaymentAccount.findOneAndUpdate({ _id: account._id }, { $set: set }, { new: true, runValidators: true, session }).lean();
      onUndo(() => PaymentAccount.replaceOne({ _id: account._id }, account));
      const kind = after.kind;
      const renamed = set.nickname !== undefined && set.nickname !== account.nickname;
      if (renamed || set.kind) {
        const before = await AccountTransaction.find(ledgerFilter).select('accountName accountType transferDetails paymentAccountId').session(session).lean();
        await AccountTransaction.updateMany({ paymentAccountId: account._id }, { $set: { accountName: after.nickname, accountType: PaymentAccount.ledgerType(kind) } }, { session });
        await AccountTransaction.updateMany({ 'transferDetails.toPaymentAccountId': account._id }, { $set: { 'transferDetails.toAccount': after.nickname, 'transferDetails.toAccountType': PaymentAccount.ledgerType(kind) } }, { session });
        onUndo(() => Promise.all(before.map((e) => AccountTransaction.updateOne({ _id: e._id }, { $set: { accountName: e.accountName, accountType: e.accountType, transferDetails: e.transferDetails } }))));
        if (renamed) {
          const recs = await BankReconciliation.find({ ...(await orgUserFilter(req.user)), accountName: account.nickname }).select('_id').session(session).lean();
          await BankReconciliation.updateMany({ _id: { $in: recs.map((r) => r._id) } }, { $set: { accountName: after.nickname } }, { session });
          onUndo(() => BankReconciliation.updateMany({ _id: { $in: recs.map((r) => r._id) } }, { $set: { accountName: account.nickname } }));
        }
      }
      if (openingChanged || renamed || set.kind) {
        const entry = openingEntry({ ...after, openingBalance, openingDate }, req.user);
        if (opening && openingBalance !== 0) {
          if (!opening.reconciled) {
            await AccountTransaction.updateOne({ _id: opening._id }, { $set: { amount: entry.amount, postedAt: entry.postedAt, accountName: entry.accountName, accountType: entry.accountType, description: entry.description, status: 'completed' } }, { session });
            onUndo(() => AccountTransaction.replaceOne({ _id: opening._id }, opening));
          }
        } else if (opening && openingBalance === 0) {
          await AccountTransaction.deleteOne({ _id: opening._id }, { session });
          await PaymentAccount.updateOne({ _id: account._id }, { $unset: { openingEntryId: '' } }, { session });
          onUndo(() => AccountTransaction.collection.insertOne(opening));
        } else if (!opening && openingBalance !== 0) {
          const [created] = await AccountTransaction.create([{ ...entry, userId: account.userId, dataScope: account.dataScope, transactionNumber: `TXN-OPN-${account._id}` }], { session });
          await PaymentAccount.updateOne({ _id: account._id }, { $set: { openingEntryId: created._id } }, { session });
          onUndo(() => AccountTransaction.deleteOne({ _id: created._id }));
        }
      }
      return after;
    }, { label: 'Payment account change' });

    log(req, updated, 'Payment Account Updated', `Payment account ${account.nickname}${updated.nickname !== account.nickname ? ` renamed to ${updated.nickname}` : ''} was updated`, 'update', {
      changes: { fields: Object.keys(set).filter((k) => k !== 'nicknameKey' && k !== 'accountNumber') }
    });
    res.json({ status: 'success', data: { account: present(await PaymentAccount.findById(updated._id).lean()) } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', message: 'There is already an account with that name' });
    console.error('Update payment account error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving the payment account' });
  }
});

/*
  POST /api/payment-accounts/:id/adjust { actualBalance, date, note }
  Matches the recorded balance to the real one (a bank statement, a cash
  count) at the end of `date`: the difference is posted as a balance
  adjustment in or out, so the reason is on record. No difference, no entry.
*/
router.post('/:id/adjust', requirePermission('Accounts: Create & Edit'), [
  body('actualBalance').isFloat({ min: -1e12, max: 1e12 }).withMessage('Enter the actual balance'),
  body('date').optional({ values: 'falsy' }).custom(isDay).withMessage('Choose a valid day'),
  body('note').isString().trim().isLength({ min: 3, max: 300 }).withMessage('Say why the balance differs (3–300 characters)')
], validate, async (req, res) => {
  try {
    const account = await findAccount(req, req.params.id);
    if (!account) return res.status(404).json({ status: 'error', message: 'Payment account not found' });
    const day = req.body.date || istToday();
    const dayEnd = new Date(istStart(day).getTime() + DAY_MS);
    const [row] = (await AccountTransaction.paymentAccountActivity(await accountScope(req.user), dayEnd, dayEnd))
      .filter((r) => String(r._id) === String(account._id));
    const recorded = round2(row?.before || 0);
    const difference = round2(Number(req.body.actualBalance) - recorded);
    if (Math.abs(difference) < 0.005) return res.json({ status: 'success', message: 'The recorded balance already matches', data: { recorded, difference: 0 } });
    const entry = await AccountTransaction.createWithUniqueNumber({
      transactionType: 'adjustment',
      adjustmentDirection: difference > 0 ? 'in' : 'out',
      category: 'Balance adjustment',
      amount: Math.abs(difference),
      description: `Balance adjustment for ${account.nickname}: ${req.body.note.trim()}`,
      notes: `Recorded ₹${recorded} at the end of ${day}; actual ₹${round2(req.body.actualBalance)}.`,
      // The last moment of that day, so the adjustment closes it.
      postedAt: new Date(dayEnd.getTime() - 1),
      paymentMethod: account.kind === 'cash' ? 'cash' : 'other',
      accountType: PaymentAccount.ledgerType(account.kind),
      accountName: account.nickname,
      paymentAccountId: account._id,
      status: 'completed',
      userId: req.user._id,
      dataScope: req.user.dataScope
    });
    log(req, account, 'Payment Account Adjusted', `${account.nickname}: recorded ₹${recorded}, actual ₹${round2(req.body.actualBalance)} on ${day} (${req.body.note.trim()})`, 'update', { severity: 'high' });
    res.status(201).json({ status: 'success', data: { recorded, difference, entry } });
  } catch (error) {
    console.error('Adjust payment account error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while adjusting the balance' });
  }
});

// DELETE /api/payment-accounts/:id — only an account nothing was recorded
// against; one with history is deactivated instead, so the history stays.
router.delete('/:id', requirePermission('Accounts: Delete'), async (req, res) => {
  try {
    const account = await findAccount(req, req.params.id);
    if (!account) return res.status(404).json({ status: 'error', message: 'Payment account not found' });
    const used = (await Payment.exists({ paymentAccountId: account._id })) ||
      (await AccountTransaction.exists({ $or: [{ paymentAccountId: account._id }, { 'transferDetails.toPaymentAccountId': account._id }], _id: { $ne: account.openingEntryId } }));
    if (used) return res.status(409).json({ status: 'error', message: `${account.nickname} has transactions. Mark it inactive instead, so its history is kept.` });
    const opening = account.openingEntryId ? await AccountTransaction.findById(account.openingEntryId).lean() : null;
    if (opening?.reconciled) return res.status(409).json({ status: 'error', message: 'Its opening balance is part of a bank reconciliation. Mark it inactive instead.' });
    if (opening) await AccountTransaction.deleteOne({ _id: opening._id });
    await PaymentAccount.deleteOne({ _id: account._id });
    log(req, account, 'Payment Account Deleted', `Payment account ${account.nickname} was deleted`, 'delete');
    res.json({ status: 'success', message: 'Payment account deleted' });
  } catch (error) {
    console.error('Delete payment account error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting the payment account' });
  }
});

module.exports = router;
