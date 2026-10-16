const express = require('express');
const { query, body, validationResult } = require('express-validator');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const { staffScopeQuery } = require('../utils/dataScopeHelper');
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

  Invoices are issued without GST now. The GST figures below only come from
  invoices issued before that, so a past month can still be reported to the
  accountant; for later months they are all 0.

  Figures:
    totalRevenue     sum of invoice totals
    taxableAmount    sum of net values (lines + design charge − discount)
    totalDiscounts   sum of invoice-level discounts
    totalTaxPayable  sum of CGST + SGST + IGST on older GST invoices
    gstBreakdown     per GST rate: invoices containing that rate, line value
                     and tax, from the invoice lines
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
      { $unwind: '$items' },
      {
        $group: {
          _id: { rate: '$items.gstRate', invoice: '$_id' },
          amount: { $sum: '$items.totalAmount' },
          tax: { $sum: { $add: [{ $ifNull: ['$items.cgstAmount', 0] }, { $ifNull: ['$items.sgstAmount', 0] }, { $ifNull: ['$items.igstAmount', 0] }] } }
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
    ['Net value', report.taxableAmount],
    ['Discounts', report.totalDiscounts],
    ...(hasGst ? [['GST on older invoices', report.totalTaxPayable]] : []),
    ['Total invoiced', report.totalRevenue],
    ...(hasGst
      ? [
          [],
          ['GST rate (older invoices)', 'Invoices', 'Taxable value', 'GST'],
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
    const company = req.user.companyName || 'Terralabs ERP';
    const subject = req.body.subject || `Monthly report for ${report.month} — ${company}`;
    const message = req.body.message || `Please find attached the sales summary for ${report.month}.`;

    const text = [
      message,
      '',
      `Invoices: ${report.totalInvoices}`,
      `Net value: ${money(report.taxableAmount)}`,
      report.totalTaxPayable > 0
        ? `GST on older invoices: ${money(report.totalTaxPayable)} (CGST ${money(report.cgstAmount)}, SGST ${money(report.sgstAmount)}, IGST ${money(report.igstAmount)})`
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
