const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const Cost = require('../models/Cost');
const Job = require('../models/Job');
const Vendor = require('../models/Vendor');
const Invoice = require('../models/Invoice');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { userCan } = require('../middleware/requirePermission');
const { orgUserFilter, orgScope } = require('../utils/accessScope');

const router = express.Router();

/*
  Job costing: what a job really cost (paper, plates, ink, labour, outside
  work, transport) against what it was billed for, so the owner sees the
  profit and margin of every job. Mounted behind "Cost & Profit" in app.js.
*/

const CATEGORIES = Cost.schema.path('category').enumValues;
const UNITS = Cost.schema.path('unit').enumValues;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(new Date(`${d}T00:00:00`).getTime() + 864e5 - 1) : new Date(d));

/** Costs of the caller's business: tagged with its dataScope, or older ones made by its logins. */
async function costScope(user) {
  if (!user.dataScope) return { userId: user._id };
  return { $or: [{ dataScope: user.dataScope }, { dataScope: { $exists: false }, ...(await orgUserFilter(user)) }] };
}

/** Invoices whose amounts count as revenue: issued, and No GST ones only for logins allowed to see them. */
const revenueInvoices = (user) => ({
  ...orgScope(user),
  status: { $nin: ['draft', 'cancelled'] },
  ...(userCan(user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } })
});

const dateRange = (from, to, field) => {
  if (!from && !to) return {};
  const r = {};
  if (from) r.$gte = new Date(from);
  if (to) r.$lte = endOfDay(to);
  return { [field]: r };
};

/** Keeps Job.actualCost equal to the sum of its recorded costs. */
async function refreshJobCost(jobId) {
  const [row] = await Cost.aggregate([{ $match: { jobId: new mongoose.Types.ObjectId(String(jobId)) } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  await Job.updateOne({ _id: jobId }, { actualCost: row?.total || 0 });
}

const costRules = (partial) => {
  const opt = (chain) => (partial ? chain.optional() : chain);
  return [
    opt(body('jobId')).isMongoId().withMessage('Choose a job'),
    opt(body('category')).isIn(CATEGORIES).withMessage('Choose a category'),
    opt(body('description')).trim().notEmpty().withMessage('Describe the cost').isLength({ max: 300 }),
    opt(body('amount')).isFloat({ min: 0.01, max: 1e9 }).withMessage('Amount must be more than 0'),
    body('quantity').optional({ values: 'falsy' }).isFloat({ min: 0, max: 1e9 }).withMessage('Quantity must be a number'),
    body('unit').optional({ values: 'falsy' }).isIn(UNITS),
    body('date').optional({ values: 'falsy' }).isISO8601().withMessage('Choose a valid date'),
    body('vendorId').optional({ values: 'falsy' }).isMongoId(),
    body('invoiceNumber').optional().trim().isLength({ max: 80 }),
    body('notes').optional().trim().isLength({ max: 1000 })
  ];
};

const pick = (b) => {
  const out = {};
  for (const k of ['category', 'description', 'amount', 'quantity', 'unit', 'date', 'invoiceNumber', 'notes']) {
    if (b[k] !== undefined && b[k] !== '') out[k] = b[k];
  }
  if (out.quantity && out.amount) out.unitCost = Number(out.amount) / Number(out.quantity);
  return out;
};

async function resolveJob(req, jobId) {
  if (!mongoose.isValidObjectId(jobId)) return null;
  return Job.findOne({ _id: jobId, ...orgScope(req.user) }).select('title customerId status');
}

async function resolveVendor(req, vendorId) {
  if (!vendorId) return { vendorId: undefined, vendorName: undefined };
  const vendor = await Vendor.findOne({ _id: vendorId, ...(await orgUserFilter(req.user)) }).select('name');
  if (!vendor) return null;
  return { vendorId: vendor._id, vendorName: vendor.name };
}

const log = (req, cost, action, actionType) =>
  ActivityLog.logActivity({
    action,
    description: `${action}: ${cost.description} (${cost.jobTitle})`,
    entityType: 'cost',
    entityId: cost._id,
    entityName: cost.description,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity: 'low',
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

// GET /api/costs?jobId=&category=&from=&to=&search=&page=&limit=
router.get(
  '/',
  protect,
  [
    query('category').optional().isIn(['all', ...CATEGORIES]),
    query('jobId').optional().isMongoId(),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
    query('search').optional().trim(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  validate,
  async (req, res) => {
    try {
      const { category, jobId, from, to, search } = req.query;
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 25;
      const filters = [await costScope(req.user)];
      if (category && category !== 'all') filters.push({ category });
      if (jobId) filters.push({ jobId });
      if (from || to) filters.push(dateRange(from, to, 'date'));
      if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filters.push({ $or: [{ description: rx }, { jobTitle: rx }, { vendorName: rx }, { invoiceNumber: rx }] });
      }
      const q = { $and: filters };
      const [costs, total, sum] = await Promise.all([
        Cost.find(q).populate('jobId', 'title status').sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        Cost.countDocuments(q),
        Cost.aggregate([{ $match: q }, { $group: { _id: null, amount: { $sum: '$amount' } } }])
      ]);
      res.json({ status: 'success', data: { costs, totalAmount: sum[0]?.amount || 0, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
    } catch (error) {
      console.error('Get costs error:', error);
      res.status(500).json({ status: 'error', message: 'Server error while fetching costs' });
    }
  }
);

// GET /api/costs/stats/summary?from=&to= — revenue, costs and profit for a period
router.get('/stats/summary', protect, [query('from').optional().isISO8601(), query('to').optional().isISO8601()], validate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const scope = await costScope(req.user);
    const [byCategory, revenue] = await Promise.all([
      Cost.aggregate([
        { $match: { $and: [scope, dateRange(from, to, 'date')] } },
        { $group: { _id: '$category', count: { $sum: 1 }, total: { $sum: '$amount' } } },
        { $sort: { total: -1 } }
      ]),
      Invoice.aggregate([
        { $match: { ...revenueInvoices(req.user), ...dateRange(from, to, 'invoiceDate') } },
        { $group: { _id: null, taxable: { $sum: { $ifNull: ['$taxableAmount', '$subtotal'] } }, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } }
      ])
    ]);
    const totalCost = byCategory.reduce((s, c) => s + c.total, 0);
    const revenueTaxable = revenue[0]?.taxable || 0;
    res.json({
      status: 'success',
      data: {
        stats: {
          revenue: revenueTaxable,
          revenueWithGst: revenue[0]?.total || 0,
          invoices: revenue[0]?.count || 0,
          totalCost,
          costEntries: byCategory.reduce((s, c) => s + c.count, 0),
          profit: revenueTaxable - totalCost,
          margin: revenueTaxable > 0 ? ((revenueTaxable - totalCost) / revenueTaxable) * 100 : null,
          byCategory
        }
      }
    });
  } catch (error) {
    console.error('Get cost stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching cost statistics' });
  }
});

// GET /api/costs/jobs?from=&to=&search= — profit of each job that has costs or invoices
router.get('/jobs', protect, [query('from').optional().isISO8601(), query('to').optional().isISO8601(), query('search').optional().trim()], validate, async (req, res) => {
  try {
    const { from, to, search } = req.query;
    const scope = await costScope(req.user);
    const [costRows, revenueRows] = await Promise.all([
      Cost.aggregate([
        { $match: { $and: [scope, dateRange(from, to, 'date')] } },
        { $group: { _id: { job: '$jobId', category: '$category' }, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Invoice.aggregate([
        { $match: { ...revenueInvoices(req.user), jobId: { $ne: null }, ...dateRange(from, to, 'invoiceDate') } },
        { $group: { _id: '$jobId', revenue: { $sum: { $ifNull: ['$taxableAmount', '$subtotal'] } }, invoices: { $sum: 1 } } }
      ])
    ]);

    const byJob = new Map();
    const entry = (id) => {
      const key = String(id);
      if (!byJob.has(key)) byJob.set(key, { jobId: key, revenue: 0, invoices: 0, cost: 0, costEntries: 0, byCategory: {} });
      return byJob.get(key);
    };
    for (const r of costRows) {
      if (!r._id.job) continue;
      const e = entry(r._id.job);
      e.cost += r.total;
      e.costEntries += r.count;
      e.byCategory[r._id.category] = (e.byCategory[r._id.category] || 0) + r.total;
    }
    for (const r of revenueRows) {
      const e = entry(r._id);
      e.revenue += r.revenue;
      e.invoices += r.invoices;
    }

    const jobs = await Job.find({ _id: { $in: [...byJob.keys()] }, ...orgScope(req.user) })
      .select('title status customerId dueDate')
      .populate('customerId', 'name')
      .lean();
    const rx = search ? new RegExp(escapeRegex(search), 'i') : null;
    const rows = jobs
      .map((j) => {
        const e = byJob.get(String(j._id));
        const profit = e.revenue - e.cost;
        return {
          ...e,
          title: j.title,
          status: j.status,
          customerName: j.customerId?.name || '',
          profit,
          margin: e.revenue > 0 ? (profit / e.revenue) * 100 : null
        };
      })
      .filter((r) => !rx || rx.test(r.title) || rx.test(r.customerName))
      .sort((a, b) => a.profit - b.profit);
    res.json({ status: 'success', data: { jobs: rows } });
  } catch (error) {
    console.error('Get job profit error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while working out job profit' });
  }
});

// GET /api/costs/:id
router.get('/:id', protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Cost not found' });
    const cost = await Cost.findOne({ $and: [{ _id: req.params.id }, await costScope(req.user)] }).populate('jobId', 'title status');
    if (!cost) return res.status(404).json({ status: 'error', message: 'Cost not found' });
    res.json({ status: 'success', data: { cost } });
  } catch (error) {
    console.error('Get cost error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching cost' });
  }
});

// POST /api/costs
router.post('/', protect, costRules(false), validate, async (req, res) => {
  try {
    const job = await resolveJob(req, req.body.jobId);
    if (!job) return res.status(404).json({ status: 'error', message: 'Job not found' });
    const vendor = await resolveVendor(req, req.body.vendorId);
    if (!vendor) return res.status(404).json({ status: 'error', message: 'Supplier not found' });

    const cost = await Cost.create({
      ...pick(req.body),
      ...vendor,
      jobId: job._id,
      jobTitle: job.title,
      userId: req.user._id,
      dataScope: req.user.dataScope
    });
    await refreshJobCost(job._id);
    log(req, cost, 'Cost Added', 'create');
    res.status(201).json({ status: 'success', message: 'Cost added', data: { cost: await cost.populate('jobId', 'title status') } });
  } catch (error) {
    console.error('Create cost error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating cost' });
  }
});

// PUT /api/costs/:id
router.put('/:id', protect, costRules(true), validate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Cost not found' });
    const cost = await Cost.findOne({ $and: [{ _id: req.params.id }, await costScope(req.user)] });
    if (!cost) return res.status(404).json({ status: 'error', message: 'Cost not found' });
    const previousJob = cost.jobId;

    if (req.body.jobId && String(req.body.jobId) !== String(cost.jobId)) {
      const job = await resolveJob(req, req.body.jobId);
      if (!job) return res.status(404).json({ status: 'error', message: 'Job not found' });
      cost.jobId = job._id;
      cost.jobTitle = job.title;
    }
    if (req.body.vendorId !== undefined) {
      const vendor = await resolveVendor(req, req.body.vendorId || null);
      if (!vendor) return res.status(404).json({ status: 'error', message: 'Supplier not found' });
      cost.vendorId = vendor.vendorId;
      cost.vendorName = vendor.vendorName;
    }
    Object.assign(cost, pick(req.body));
    if (!cost.dataScope && req.user.dataScope) cost.dataScope = req.user.dataScope;
    await cost.save();

    await refreshJobCost(cost.jobId);
    if (String(previousJob) !== String(cost.jobId)) await refreshJobCost(previousJob);
    log(req, cost, 'Cost Updated', 'update');
    res.json({ status: 'success', message: 'Cost updated', data: { cost: await cost.populate('jobId', 'title status') } });
  } catch (error) {
    console.error('Update cost error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating cost' });
  }
});

// DELETE /api/costs/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Cost not found' });
    const cost = await Cost.findOneAndDelete({ $and: [{ _id: req.params.id }, await costScope(req.user)] });
    if (!cost) return res.status(404).json({ status: 'error', message: 'Cost not found' });
    await refreshJobCost(cost.jobId);
    log(req, cost, 'Cost Deleted', 'delete');
    res.json({ status: 'success', message: 'Cost deleted' });
  } catch (error) {
    console.error('Delete cost error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting cost' });
  }
});

module.exports = router;
