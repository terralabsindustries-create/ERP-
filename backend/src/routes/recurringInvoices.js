const express = require('express');
const mongoose = require('mongoose');
const RecurringInvoice = require('../models/RecurringInvoice');
const { RecurringInvoiceRun } = RecurringInvoice;
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const svc = require('../services/recurringInvoices');

/*
  /api/recurring-invoices — templates that raise an invoice on a schedule
  (services/recurringInvoices.js). Reading needs Invoicing; changes need
  "Invoicing: Create & Edit" (app.js moduleGuard).
*/
const router = express.Router();
router.use(protect);

const fail = (res, error, what) => {
  if (error instanceof svc.RecurringError) return res.status(error.status).json({ status: 'error', message: error.message, code: error.code });
  if (error.name === 'ValidationError') return res.status(400).json({ status: 'error', message: error.message });
  console.error(`Recurring invoice ${what} error:`, error);
  return res.status(500).json({ status: 'error', message: `Could not ${what} the recurring invoice.` });
};
const own = async (req) => (mongoose.isValidObjectId(req.params.id) ? RecurringInvoice.findOne({ _id: req.params.id, ...svc.scopeOf(req.user) }) : null);
const log = (req, t, action) => ActivityLog.logActivity({
  action, description: `Recurring invoice "${t.name}": ${action.toLowerCase()}`, entityType: 'invoice', entityId: t._id, entityName: t.name,
  performedBy: req.user._id, performedByName: req.user.fullName, actionType: 'update', severity: 'medium', userId: req.user._id, dataScope: req.user.dataScope
}).catch(() => {});

router.get('/', async (req, res) => {
  try {
    const q = { ...svc.scopeOf(req.user) };
    if (['active', 'paused', 'cancelled', 'completed'].includes(req.query.status)) q.status = req.query.status;
    const templates = await RecurringInvoice.find(q).populate('customerId', 'name company').sort({ status: 1, nextRunDate: 1 }).limit(500).lean();
    res.json({ status: 'success', data: { templates } });
  } catch (error) { fail(res, error, 'list'); }
});

router.get('/:id', async (req, res) => {
  try {
    const t = await own(req);
    if (!t) return res.status(404).json({ status: 'error', message: 'Recurring invoice not found' });
    const runs = await RecurringInvoiceRun.find({ templateId: t._id }).sort({ scheduledFor: -1 }).limit(100).lean();
    res.json({ status: 'success', data: { template: t, runs } });
  } catch (error) { fail(res, error, 'load'); }
});

router.post('/', async (req, res) => {
  try {
    const fields = await svc.buildTemplate(req.user, req.body || {});
    const t = await RecurringInvoice.create({ ...fields, status: 'active', createdBy: req.user._id, userId: req.user._id, dataScope: req.user.dataScope });
    log(req, t, 'Recurring invoice created');
    res.status(201).json({ status: 'success', data: { template: t } });
  } catch (error) { fail(res, error, 'create'); }
});

router.put('/:id', async (req, res) => {
  try {
    const t = await own(req);
    if (!t) return res.status(404).json({ status: 'error', message: 'Recurring invoice not found' });
    if (['cancelled', 'completed'].includes(t.status)) return res.status(409).json({ status: 'error', code: 'TEMPLATE_CLOSED', message: `This recurring invoice is ${t.status}; create a new one instead.` });
    Object.assign(t, await svc.buildTemplate(req.user, req.body || {}, t));
    await t.save();
    log(req, t, 'Recurring invoice changed');
    res.json({ status: 'success', data: { template: t } });
  } catch (error) { fail(res, error, 'update'); }
});

const transition = (from, to, action) => async (req, res) => {
  try {
    const set = { status: to };
    if (to === 'active') Object.assign(set, { retryAfter: null, consecutiveFailures: 0 });
    const t = await RecurringInvoice.findOneAndUpdate({ _id: req.params.id, ...svc.scopeOf(req.user), status: { $in: from } }, { $set: set }, { new: true });
    if (!t) {
      const exists = await own(req);
      return res.status(exists ? 409 : 404).json({ status: 'error', message: exists ? `A ${exists.status} recurring invoice cannot be ${action}.` : 'Recurring invoice not found' });
    }
    log(req, t, `Recurring invoice ${action}`);
    res.json({ status: 'success', data: { template: t } });
  } catch (error) { fail(res, error, action); }
};
router.post('/:id/pause', transition(['active'], 'paused', 'paused'));
router.post('/:id/resume', transition(['paused'], 'active', 'resumed'));
router.post('/:id/cancel', transition(['active', 'paused'], 'cancelled', 'cancelled'));

// Bill every date that is due now (the same as the scheduler would).
router.post('/:id/run-now', async (req, res) => {
  try {
    const t = await own(req);
    if (!t) return res.status(404).json({ status: 'error', message: 'Recurring invoice not found' });
    if (t.status !== 'active') return res.status(409).json({ status: 'error', message: `This recurring invoice is ${t.status}.` });
    if (t.nextRunDate > new Date()) return res.status(409).json({ status: 'error', code: 'NOT_DUE', message: 'Nothing is due yet: the next invoice is scheduled for a later date.' });
    const results = await svc.runTemplate(t, { trigger: 'manual' });
    res.json({ status: 'success', data: { results: results.map((r) => ({ periodKey: r.periodKey, generated: !!r.generated, skipped: !!r.skipped, failed: !!r.failed, error: r.error?.message, invoiceNumber: r.invoice?.invoiceNumber })) } });
  } catch (error) { fail(res, error, 'run'); }
});

module.exports = router;
