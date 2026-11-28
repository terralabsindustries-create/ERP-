const express = require('express');
const DocumentNumbering = require('../models/DocumentNumbering');
const Invoice = require('../models/Invoice');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { financialYearOf } = require('../utils/financialYear');

/*
  GET /api/document-numbering   the business's series and the next numbers (preview)
  PUT /api/document-numbering   { invoice: { prefix, reset, padding }, stockItemPrefix }  (Settings: Edit)
*/
const router = express.Router();
router.use(protect);
const scopeOf = (u) => (u.dataScope ? { dataScope: u.dataScope } : { userId: u._id });
const PREFIX = /^[A-Za-z0-9/-]{0,8}$/;

const preview = (cfg, date = new Date()) => {
  const period = cfg.reset === 'financial_year' ? financialYearOf(date).code : `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  return `${cfg.prefix}${period}-${'1'.padStart(cfg.padding, '0')}`;
};

router.get('/', async (req, res) => {
  try {
    const doc = await DocumentNumbering.findOne(scopeOf(req.user)).lean();
    const invoice = { prefix: 'INV-', reset: 'monthly', padding: 4, ...(doc?.invoice || {}) };
    res.json({ status: 'success', data: { invoice, stockItemPrefix: doc?.stockItemPrefix || 'STK-', example: { invoice: preview(invoice) } } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Could not load document numbering.' });
  }
});

router.put('/', async (req, res) => {
  try {
    if (!userCan(req.user, 'Settings: Edit')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to do this.' });
    const current = await DocumentNumbering.findOne(scopeOf(req.user)).lean();
    const inv = { prefix: 'INV-', reset: 'monthly', padding: 4, ...(current?.invoice || {}), ...(req.body?.invoice || {}) };
    if (!PREFIX.test(inv.prefix)) return res.status(400).json({ status: 'error', message: 'The invoice prefix may use up to 8 letters, digits, "-" or "/".' });
    if (!['monthly', 'financial_year'].includes(inv.reset)) return res.status(400).json({ status: 'error', message: 'Choose a monthly or financial-year series.' });
    inv.padding = Math.min(Math.max(parseInt(inv.padding, 10) || 4, 3), 6);
    const sample = preview(inv);
    // A month's or year's series must fit 16 characters even at its largest number.
    if (sample.length > 16) return res.status(400).json({ status: 'error', code: 'TOO_LONG', message: `Invoice numbers like ${sample} are longer than the 16 characters GST allows. Use a shorter prefix or fewer digits.` });
    const stockItemPrefix = req.body?.stockItemPrefix !== undefined ? String(req.body.stockItemPrefix).trim() : current?.stockItemPrefix || 'STK-';
    if (!/^[A-Za-z0-9-]{1,8}$/.test(stockItemPrefix)) return res.status(400).json({ status: 'error', message: 'The item code prefix may use up to 8 letters, digits or "-".' });
    if (stockItemPrefix.toUpperCase() === inv.prefix.toUpperCase()) return res.status(400).json({ status: 'error', message: 'Use a different prefix for item codes than for invoices.' });
    const doc = await DocumentNumbering.findOneAndUpdate(scopeOf(req.user), { $set: { invoice: inv, stockItemPrefix, updatedBy: req.user._id }, $setOnInsert: { dataScope: req.user.dataScope, userId: req.user._id } }, { upsert: true, new: true });
    res.json({ status: 'success', message: 'Numbering saved. Issued invoices keep their numbers; the next one uses the new series.', data: { invoice: doc.invoice, stockItemPrefix: doc.stockItemPrefix, example: { invoice: sample } } });
  } catch (error) {
    console.error('Document numbering error:', error);
    res.status(500).json({ status: 'error', message: 'Could not save document numbering.' });
  }
});

module.exports = router;
module.exports.preview = preview;
