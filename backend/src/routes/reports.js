const express = require('express');
const mongoose = require('mongoose');
const { query, body, validationResult } = require('express-validator');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const PurchaseBill = require('../models/PurchaseBill');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const { staffScopeQuery, canViewAllStaffData } = require('../utils/dataScopeHelper');
const { orgUserFilter } = require('../utils/accessScope');
// Called through the module so tests can stand in for the SMTP transport.
const mailer = require('../utils/mailer');

const router = express.Router();

/*
  Monthly sales summary, built from the invoices themselves.

  Which invoices count: issued invoices dated in the month, i.e. not drafts,
  not cancelled or refunded, and not older "No GST" bills (those are reported
  separately so the totals can be reconciled). The caller sees the invoices
  their invoice permissions cover: their own, or the whole business for the
  admin and "view all staff data" logins.

  Each line and the design charge carry their own GST rate. Invoices raised
  while invoicing carried no GST (Oct–Nov 2026) simply report 0 tax.

  Figures:
    totalRevenue     sum of invoice totals (including GST)
    taxableAmount    sum of taxable values (lines + design charge − discount)
    totalDiscounts   sum of invoice-level discounts
    totalTaxPayable  sum of CGST + SGST + IGST
    gstBreakdown     per GST rate: invoices containing that rate, taxable
                     value and tax, from the lines and the design charge
*/

const STANDARD_RATES = [0, 5, 12, 18, 28, 40];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const monthRange = (month) => {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1), label: new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }) };
};

async function buildMonthlyReport(user, month) {
  const { start, end, label } = monthRange(month);
  const base = {
    ...staffScopeQuery(user),
    invoiceDate: { $gte: start, $lt: end },
    status: { $nin: ['draft', 'cancelled', 'refunded'] }
  };

  const [totals, slabs, noGst] = await Promise.all([
    Invoice.aggregate([
      { $match: { ...base, noGst: { $ne: true } } },
      {
        $group: {
          _id: null,
          totalInvoices: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' },
          totalDiscounts: { $sum: { $ifNull: ['$discountAmount', 0] } },
          taxableAmount: { $sum: '$taxableAmount' },
          cgstAmount: { $sum: { $ifNull: ['$totalCgstAmount', 0] } },
          sgstAmount: { $sum: { $ifNull: ['$totalSgstAmount', 0] } },
          igstAmount: { $sum: { $ifNull: ['$totalIgstAmount', 0] } },
          totalTaxPayable: { $sum: { $ifNull: ['$totalGstAmount', 0] } }
        }
      }
    ]),
    Invoice.aggregate([
      { $match: { ...base, noGst: { $ne: true } } },
      // The design charge is taxed like a line, at its own rate.
      {
        $project: {
          parts: {
            $concatArrays: [
              '$items',
              {
                $cond: [
                  { $gt: [{ $ifNull: ['$designCharge', 0] }, 0] },
                  [{
                    gstRate: { $ifNull: ['$designChargeGstRate', 0] },
                    taxableValue: { $ifNull: ['$designChargeTaxableValue', '$designCharge'] },
                    cgstAmount: '$designChargeCgstAmount',
                    sgstAmount: '$designChargeSgstAmount',
                    igstAmount: '$designChargeIgstAmount'
                  }],
                  []
                ]
              }
            ]
          }
        }
      },
      { $unwind: '$parts' },
      {
        $group: {
          _id: { rate: { $ifNull: ['$parts.gstRate', 0] }, invoice: '$_id' },
          // A line's value after its share of the discount; older lines only
          // have their value before it.
          amount: { $sum: { $ifNull: ['$parts.taxableValue', '$parts.totalAmount'] } },
          tax: { $sum: { $add: [{ $ifNull: ['$parts.cgstAmount', 0] }, { $ifNull: ['$parts.sgstAmount', 0] }, { $ifNull: ['$parts.igstAmount', 0] }] } }
        }
      },
      { $group: { _id: '$_id.rate', count: { $sum: 1 }, amount: { $sum: '$amount' }, tax: { $sum: '$tax' } } }
    ]),
    Invoice.aggregate([
      { $match: { ...base, noGst: true } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }
    ])
  ]);

  const t = totals[0] || {};
  const gstBreakdown = {};
  for (const rate of STANDARD_RATES) gstBreakdown[`gst${rate}`] = { count: 0, amount: 0, tax: 0 };
  for (const s of slabs.sort((a, b) => a._id - b._id)) {
    gstBreakdown[`gst${s._id}`] = { count: s.count, amount: round2(s.amount), tax: round2(s.tax) };
  }

  return {
    month: label,
    period: month,
    generatedAt: new Date().toISOString(),
    totalInvoices: t.totalInvoices || 0,
    totalRevenue: round2(t.totalRevenue || 0),
    totalDiscounts: round2(t.totalDiscounts || 0),
    taxableAmount: round2(t.taxableAmount || 0),
    totalTaxPayable: round2(t.totalTaxPayable || 0),
    cgstAmount: round2(t.cgstAmount || 0),
    sgstAmount: round2(t.sgstAmount || 0),
    igstAmount: round2(t.igstAmount || 0),
    gstBreakdown,
    excludedNoGst: { count: noGst[0]?.count || 0, amount: round2(noGst[0]?.amount || 0) }
  };
}

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The same report as a CSV the accountant can open in a spreadsheet. */
function reportCsv(report, notes) {
  const hasGst = report.totalTaxPayable > 0;
  const rows = [
    ['Monthly report', report.month],
    ['Generated', new Date(report.generatedAt).toLocaleString('en-IN')],
    [],
    ['Summary'],
    ['Invoices', report.totalInvoices],
    ['Taxable value', report.taxableAmount],
    ['Discounts', report.totalDiscounts],
    ...(hasGst ? [['GST', report.totalTaxPayable]] : []),
    ['Total invoiced', report.totalRevenue],
    ...(hasGst
      ? [
          [],
          ['GST rate', 'Invoices', 'Taxable value', 'GST'],
          ...Object.entries(report.gstBreakdown).map(([k, s]) => [`${k.replace('gst', '')}%`, s.count, s.amount, s.tax]),
          [],
          ['CGST', report.cgstAmount],
          ['SGST', report.sgstAmount],
          ['IGST', report.igstAmount]
        ]
      : []),
    [],
    ['Older No GST bills (not included above)', report.excludedNoGst.count, report.excludedNoGst.amount],
    [],
    ['Notes', notes || '']
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

/*
  Design charges by month and year, from saved records.

  Two sources, reported side by side and never added together:
    invoiced  issued invoices (not drafts, cancelled or refunded), by invoice
              date. This is the design-charge revenue. It counts the invoice's
              design charge, plus any line named "Design Charge" — how older
              invoices carried it before it had its own field.
    quoted    quotations, by the date they were written. A quotation that was
              converted to an invoice also shows up under invoiced once that
              invoice is issued, so `converted` says how much of the quoted
              figure that is.
  Invoices follow the caller's invoice visibility (their own, or the business
  for view-all logins; older No GST bills only with that permission).
  Quotations are business-wide, as on the Quotations page.
*/
const REPORT_TZ = process.env.REPORT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const legacyDesignLines = {
  $sum: {
    $map: {
      input: {
        $filter: {
          input: { $ifNull: ['$items', []] },
          as: 'i',
          cond: { $in: [{ $toLower: { $trim: { input: { $ifNull: ['$$i.itemName', ''] } } } }, ['design charge', 'design charges']] }
        }
      },
      as: 'i',
      in: { $ifNull: ['$$i.totalAmount', 0] }
    }
  }
};

const invoiceDesignScope = (user) => ({
  $and: [
    staffScopeQuery(user),
    userCan(user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } },
    { status: { $nin: ['draft', 'cancelled', 'refunded'] } }
  ]
});
const quotationScope = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/** [{ _id: { year, month }, amount, count, ... }] for invoices with a design charge. */
const invoiceDesignByMonth = (user, range) =>
  Invoice.aggregate([
    { $match: { ...invoiceDesignScope(user), ...(range ? { invoiceDate: range } : {}) } },
    { $project: { invoiceDate: 1, amount: { $add: [{ $ifNull: ['$designCharge', 0] }, legacyDesignLines] } } },
    { $match: { amount: { $gt: 0 } } },
    {
      $group: {
        _id: { year: { $year: { date: '$invoiceDate', timezone: REPORT_TZ } }, month: { $month: { date: '$invoiceDate', timezone: REPORT_TZ } } },
        amount: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);

const quotationDesignByMonth = (user, range) =>
  Quotation.aggregate([
    { $match: { ...quotationScope(user), design_charge: { $gt: 0 }, ...(range ? { createdAt: range } : {}) } },
    {
      $group: {
        _id: { year: { $year: { date: '$createdAt', timezone: REPORT_TZ } }, month: { $month: { date: '$createdAt', timezone: REPORT_TZ } } },
        amount: { $sum: '$design_charge' },
        count: { $sum: 1 },
        convertedAmount: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, '$design_charge', 0] } },
        convertedCount: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } }
      }
    }
  ]);

async function buildDesignChargeReport(user, year) {
  // Year boundaries in the report's time zone, matching how the months are bucketed.
  const range = { $gte: new Date(year - 1, 11, 31), $lt: new Date(year + 1, 0, 2) };
  const [invoiced, quoted, invoicedAll, quotedAll] = await Promise.all([
    invoiceDesignByMonth(user, range),
    quotationDesignByMonth(user, range),
    invoiceDesignByMonth(user, null),
    quotationDesignByMonth(user, null)
  ]);

  const blank = () => ({ amount: 0, count: 0 });
  const months = MONTHS.map((label, i) => ({
    month: i + 1,
    label: `${label} ${year}`,
    invoiced: blank(),
    quoted: blank(),
    convertedQuotes: blank()
  }));
  for (const r of invoiced) {
    if (r._id.year !== year) continue;
    months[r._id.month - 1].invoiced = { amount: round2(r.amount), count: r.count };
  }
  for (const r of quoted) {
    if (r._id.year !== year) continue;
    const m = months[r._id.month - 1];
    m.quoted = { amount: round2(r.amount), count: r.count };
    m.convertedQuotes = { amount: round2(r.convertedAmount), count: r.convertedCount };
  }
  const sum = (key) => ({
    amount: round2(months.reduce((s, m) => s + m[key].amount, 0)),
    count: months.reduce((s, m) => s + m[key].count, 0)
  });

  const years = new Map();
  const yearRow = (y) => {
    if (!years.has(y)) years.set(y, { year: y, invoiced: blank(), quoted: blank() });
    return years.get(y);
  };
  for (const r of invoicedAll) {
    const row = yearRow(r._id.year);
    row.invoiced = { amount: round2(row.invoiced.amount + r.amount), count: row.invoiced.count + r.count };
  }
  for (const r of quotedAll) {
    const row = yearRow(r._id.year);
    row.quoted = { amount: round2(row.quoted.amount + r.amount), count: row.quoted.count + r.count };
  }

  return {
    year,
    timezone: REPORT_TZ,
    months,
    totals: { invoiced: sum('invoiced'), quoted: sum('quoted'), convertedQuotes: sum('convertedQuotes') },
    years: [...years.values()].sort((a, b) => b.year - a.year),
    sources: {
      invoiced: 'Issued invoices (not drafts, cancelled or refunded), by invoice date. This is the design-charge revenue.',
      quoted: 'Quotations, by the date they were written. Shown for reference and never added to invoiced: a converted quotation is counted under invoiced once its invoice is issued.'
    }
  };
}

const validMonth = (field) => field.matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('Month must look like 2026-10');

// Kept for older clients; real figures live under /api/dashboard/stats.
router.get('/dashboard', protect, (req, res) => {
  res.status(410).json({ status: 'error', message: 'Use /api/dashboard/stats for dashboard figures.' });
});

// @route   GET /api/reports/revenue?month=YYYY-MM
// @desc    Monthly sales summary for the caller's invoices
// @access  Private (Reports)
router.get('/revenue', protect, requirePermission('Reports'), [validMonth(query('month').optional())], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    const now = new Date();
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    res.status(200).json({ status: 'success', data: await buildMonthlyReport(req.user, month) });
  } catch (error) {
    console.error('Monthly report error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building the report' });
  }
});

// @route   GET /api/reports/customers?month=YYYY-MM
// @desc    Customer-wise issued totals, with drafts shown separately
// @access  Private (Reports)
router.get('/customers', protect, requirePermission('Reports'), [validMonth(query('month').optional())], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    const now = new Date();
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { start, end, label } = monthRange(month);
    const match = {
      ...staffScopeQuery(req.user),
      invoiceDate: { $gte: start, $lt: end },
      status: { $nin: ['cancelled', 'refunded'] },
      noGst: { $ne: true }
    };
    const issued = { $ne: ['$status', 'draft'] };
    const grouped = await Invoice.aggregate([
      { $match: match },
      { $sort: { invoiceDate: -1, _id: -1 } },
      { $group: {
        _id: '$customerId',
        customerName: { $first: '$customerName' },
        invoiceCount: { $sum: { $cond: [issued, 1, 0] } },
        draftCount: { $sum: { $cond: [issued, 0, 1] } },
        totalInvoiced: { $sum: { $cond: [issued, '$totalAmount', 0] } },
        paidToDate: { $sum: { $cond: [issued, { $ifNull: ['$paidAmount', 0] }, 0] } },
        outstanding: { $sum: { $cond: [issued, { $ifNull: ['$balanceAmount', 0] }, 0] } }
      } },
      { $sort: { totalInvoiced: -1, customerName: 1 } }
    ]);
    const customers = grouped.map((row) => ({
      customerId: String(row._id),
      customerName: row.customerName || 'Unnamed customer',
      invoiceCount: row.invoiceCount,
      draftCount: row.draftCount,
      totalInvoiced: round2(row.totalInvoiced),
      paidToDate: round2(row.paidToDate),
      outstanding: round2(row.outstanding)
    }));
    const totals = customers.reduce((sum, row) => ({
      invoiceCount: sum.invoiceCount + row.invoiceCount,
      draftCount: sum.draftCount + row.draftCount,
      totalInvoiced: round2(sum.totalInvoiced + row.totalInvoiced),
      paidToDate: round2(sum.paidToDate + row.paidToDate),
      outstanding: round2(sum.outstanding + row.outstanding)
    }), { invoiceCount: 0, draftCount: 0, totalInvoiced: 0, paidToDate: 0, outstanding: 0 });
    res.json({ status: 'success', data: { month: label, period: month, customers, totals, draftCount: totals.draftCount } });
  } catch (error) {
    console.error('Customer report error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building the customer report' });
  }
});

// @route   GET /api/reports/customers/:customerId/invoices?month=YYYY-MM&page=N
// @desc    Issued and draft invoices behind one row of the customer report
// @access  Private (Reports)
router.get('/customers/:customerId/invoices', protect, requirePermission('Reports'), [
  validMonth(query('month').optional()),
  query('page').optional().isInt({ min: 1 }).toInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    if (!mongoose.isValidObjectId(req.params.customerId)) return res.status(400).json({ status: 'error', message: 'Invalid customer' });
    const now = new Date();
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { start, end } = monthRange(month);
    const match = {
      ...staffScopeQuery(req.user),
      customerId: new mongoose.Types.ObjectId(req.params.customerId),
      invoiceDate: { $gte: start, $lt: end },
      status: { $nin: ['cancelled', 'refunded'] },
      noGst: { $ne: true }
    };
    const page = Number(req.query.page || 1);
    const limit = 25;
    const [invoices, total] = await Promise.all([
      Invoice.find(match).select('invoiceNumber invoiceDate dueDate totalAmount paidAmount balanceAmount paymentStatus status')
        .sort({ invoiceDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Invoice.countDocuments(match)
    ]);
    res.json({ status: 'success', data: { invoices, pagination: { page, limit, total } } });
  } catch (error) {
    console.error('Customer invoice report error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading customer invoices' });
  }
});

/*
  Vendor report: purchase bills dated in the month, grouped by vendor. The
  caller sees the bills the Purchase Bills page shows them — the whole
  business for the admin and "view all staff data" logins, otherwise the bills
  they recorded. Cancelled bills are left out; drafts are counted separately
  and kept out of the money totals.
*/
const billScope = async (user) => (canViewAllStaffData(user) ? orgUserFilter(user) : { userId: user._id });
const currentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

// @route   GET /api/reports/vendors?month=YYYY-MM
// @desc    Vendor-wise purchase bill totals, with drafts shown separately
// @access  Private (Reports + Purchase Bills)
router.get('/vendors', protect, requirePermission('Reports'), requirePermission('Purchase Bills'), [validMonth(query('month').optional())], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    const month = req.query.month || currentMonth();
    const { start, end, label } = monthRange(month);
    const match = {
      ...(await billScope(req.user)),
      billDate: { $gte: start, $lt: end },
      status: { $ne: 'cancelled' }
    };
    const recorded = { $ne: ['$status', 'draft'] };
    const onRecorded = (field) => ({ $sum: { $cond: [recorded, { $ifNull: [field, 0] }, 0] } });
    const grouped = await PurchaseBill.aggregate([
      { $match: match },
      { $sort: { billDate: -1, _id: -1 } },
      { $group: {
        _id: '$vendorId',
        vendorName: { $first: '$vendorName' },
        billCount: { $sum: { $cond: [recorded, 1, 0] } },
        draftCount: { $sum: { $cond: [recorded, 0, 1] } },
        taxableAmount: onRecorded('$taxableAmount'),
        gstAmount: onRecorded('$totalGstAmount'),
        totalBilled: onRecorded('$totalAmount'),
        paidToDate: onRecorded('$paidAmount'),
        outstanding: onRecorded('$balanceAmount')
      } },
      { $sort: { totalBilled: -1, vendorName: 1 } }
    ]);
    const fields = ['billCount', 'draftCount', 'taxableAmount', 'gstAmount', 'totalBilled', 'paidToDate', 'outstanding'];
    const vendors = grouped.map((row) => ({
      vendorId: String(row._id),
      vendorName: row.vendorName || 'Unnamed vendor',
      billCount: row.billCount,
      draftCount: row.draftCount,
      taxableAmount: round2(row.taxableAmount),
      gstAmount: round2(row.gstAmount),
      totalBilled: round2(row.totalBilled),
      paidToDate: round2(row.paidToDate),
      outstanding: round2(row.outstanding)
    }));
    const totals = Object.fromEntries(fields.map((key) => [key, round2(vendors.reduce((sum, row) => sum + row[key], 0))]));
    res.json({ status: 'success', data: { month: label, period: month, vendors, totals, draftCount: totals.draftCount } });
  } catch (error) {
    console.error('Vendor report error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building the vendor report' });
  }
});

// @route   GET /api/reports/vendors/:vendorId/bills?month=YYYY-MM&page=N
// @desc    Recorded and draft purchase bills behind one row of the vendor report
// @access  Private (Reports + Purchase Bills)
router.get('/vendors/:vendorId/bills', protect, requirePermission('Reports'), requirePermission('Purchase Bills'), [
  validMonth(query('month').optional()),
  query('page').optional().isInt({ min: 1 }).toInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    if (!mongoose.isValidObjectId(req.params.vendorId)) return res.status(400).json({ status: 'error', message: 'Invalid vendor' });
    const { start, end } = monthRange(req.query.month || currentMonth());
    const match = {
      ...(await billScope(req.user)),
      vendorId: new mongoose.Types.ObjectId(req.params.vendorId),
      billDate: { $gte: start, $lt: end },
      status: { $ne: 'cancelled' }
    };
    const page = Number(req.query.page || 1);
    const limit = 25;
    const [bills, total] = await Promise.all([
      PurchaseBill.find(match).select('billNumber vendorInvoiceNumber billDate dueDate totalAmount totalGstAmount paidAmount balanceAmount paymentStatus status')
        .sort({ billDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PurchaseBill.countDocuments(match)
    ]);
    res.json({ status: 'success', data: { bills, pagination: { page, limit, total } } });
  } catch (error) {
    console.error('Vendor bill report error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading vendor bills' });
  }
});

// @route   GET /api/reports/design-charges?year=YYYY
// @desc    Design charges per month of a year, from issued invoices and from quotations
// @access  Private (Reports)
router.get('/design-charges', protect, requirePermission('Reports'), [
  query('year').optional().isInt({ min: 2000, max: 2100 }).withMessage('Year must look like 2026').toInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });
    const year = req.query.year || new Date().getFullYear();
    res.status(200).json({ status: 'success', data: await buildDesignChargeReport(req.user, year) });
  } catch (error) {
    console.error('Design charge report error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building the design charge report' });
  }
});

// @route   POST /api/reports/revenue/email
// @desc    Email the monthly summary (CSV attached) to an accountant
// @access  Private (Reports: Export)
router.post('/revenue/email', protect, requirePermission('Reports: Export'), [
  validMonth(body('month')),
  body('email').isEmail().withMessage('Enter the accountant\'s email address').normalizeEmail(),
  body('subject').optional().isString().trim().isLength({ max: 200 }),
  body('message').optional().isString().isLength({ max: 5000 }),
  body('notes').optional().isString().isLength({ max: 5000 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ status: 'error', message: errors.array()[0].msg });

    const { month, email, notes } = req.body;
    // Figures are rebuilt on the server, never taken from the request.
    const report = await buildMonthlyReport(req.user, month);
    const company = req.user.companyName || 'Carbon';
    const subject = req.body.subject || `Monthly report for ${report.month} — ${company}`;
    const message = req.body.message || `Please find attached the sales summary for ${report.month}.`;

    const text = [
      message,
      '',
      `Invoices: ${report.totalInvoices}`,
      `Taxable value: ${money(report.taxableAmount)}`,
      report.totalTaxPayable > 0
        ? `GST: ${money(report.totalTaxPayable)} (CGST ${money(report.cgstAmount)}, SGST ${money(report.sgstAmount)}, IGST ${money(report.igstAmount)})`
        : '',
      `Total invoiced: ${money(report.totalRevenue)}`,
      report.excludedNoGst.count ? `Older No GST bills not included: ${report.excludedNoGst.count} (${money(report.excludedNoGst.amount)})` : '',
      notes ? `\nNotes:\n${notes}` : '',
      '',
      `Sent by ${req.user.fullName} from ${company}.`
    ].filter((l) => l !== '').join('\n');

    const info = await mailer.createTransporter().sendMail({
      from: mailer.getFromAddress(company),
      to: email,
      replyTo: req.user.email,
      subject,
      text,
      attachments: [{ filename: `monthly-report-${month}.csv`, content: reportCsv(report, notes), contentType: 'text/csv' }]
    });

    ActivityLog.logActivity({
      action: 'Monthly Report Emailed',
      description: `Monthly report for ${report.month} was emailed to ${email}`,
      entityType: 'system',
      entityId: req.user._id,
      entityName: `Monthly report ${month}`,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'export',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch((err) => console.error('Activity log (report email) failed:', err.message));

    res.status(200).json({ status: 'success', message: `Report sent to ${email}`, data: { messageId: info.messageId, report } });
  } catch (error) {
    return mailer.sendMailErrorResponse(res, error, 'Emailing the monthly report');
  }
});

module.exports = router;
module.exports.buildMonthlyReport = buildMonthlyReport;
module.exports.reportCsv = reportCsv;
module.exports.buildDesignChargeReport = buildDesignChargeReport;
