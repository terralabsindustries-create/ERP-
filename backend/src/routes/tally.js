const express = require('express');
const { protect } = require('../middleware/auth');
const svc = require('../services/tallyExport');
const { IST_OFFSET_MS } = require('../utils/financialYear');

/*
  Tally export (services/tallyExport.js). Needs Accounts (app.js).
  GET /api/tally/preview?from=YYYY-MM-DD&to=YYYY-MM-DD[&salesLedger=…]
  GET /api/tally/export?kind=vouchers|masters&from&to[&mapping…]  → XML file
  GET /api/tally/history
*/
const router = express.Router();
router.use(protect);

const day = (s, end) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + (end ? 1 : 0)) - IST_OFFSET_MS) : null; };
const mappingOf = (q) => Object.fromEntries(Object.keys(svc.DEFAULT_MAPPING).filter((k) => typeof q[k] === 'string' && q[k].trim()).map((k) => [k, q[k].trim().slice(0, 100)]));
const rangeOf = (q) => { const from = day(q.from); const to = day(q.to, true); return from && to && from < to ? { from, to } : null; };

router.get('/preview', async (req, res) => {
  try {
    const r = rangeOf(req.query);
    if (!r) return res.status(400).json({ status: 'error', message: 'Choose a from and to date.' });
    res.json({ status: 'success', data: await svc.preview(req.user, r.from, r.to, mappingOf(req.query)) });
  } catch (error) {
    console.error('Tally preview error:', error);
    res.status(500).json({ status: 'error', message: 'Could not prepare the Tally preview.' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const kind = req.query.kind === 'masters' ? 'masters' : 'vouchers';
    const r = rangeOf(req.query);
    if (kind === 'vouchers' && !r) return res.status(400).json({ status: 'error', message: 'Choose a from and to date.' });
    const { xml } = await svc.exportFile(req.user, kind, r?.from, r?.to, mappingOf(req.query));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Tally_${kind}_${req.query.from || ''}_${req.query.to || ''}.xml"`);
    res.send(xml);
  } catch (error) {
    console.error('Tally export error:', error);
    res.status(500).json({ status: 'error', message: 'Could not export to Tally format.' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const scope = req.user.dataScope ? { dataScope: req.user.dataScope } : { userId: req.user._id };
    const rows = await svc.TallyExport.find(scope).select('-documentKeys').sort({ createdAt: -1 }).limit(50).lean();
    res.json({ status: 'success', data: { exports: rows } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Could not load the export history.' });
  }
});

module.exports = router;
