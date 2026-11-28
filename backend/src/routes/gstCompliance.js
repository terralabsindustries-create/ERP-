const express = require('express');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const svc = require('../services/gstCompliance');

/*
  E-invoice / e-way bill (services/gstCompliance.js).
  GET  /api/gst-compliance/settings          PUT the same (needs Settings: Edit)
  GET  /api/gst-compliance/invoices/:id      status, validation problems, records
  POST /api/gst-compliance/invoices/:id/irn          generate IRN
  POST /api/gst-compliance/invoices/:id/irn/cancel   { reasonCode, remark }
  POST /api/gst-compliance/invoices/:id/eway-bill    transport details → EWB
*/
const router = express.Router();
router.use(protect);
const fail = (res, error, what) => {
  if (error instanceof svc.ComplianceError) return res.status(error.status).json({ status: 'error', message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
  console.error(`GST compliance ${what} error:`, error);
  return res.status(500).json({ status: 'error', message: `Could not ${what}.` });
};

router.get('/settings', async (req, res) => {
  try { res.json({ status: 'success', data: { settings: await svc.settingsFor(req.user) } }); } catch (e) { fail(res, e, 'load the settings'); }
});
router.put('/settings', async (req, res) => {
  try {
    if (!userCan(req.user, 'Settings: Edit')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to do this.' });
    res.json({ status: 'success', data: { settings: await svc.saveSettings(req.user, req.body || {}) } });
  } catch (e) { fail(res, e, 'save the settings'); }
});
router.get('/invoices/:id', async (req, res) => {
  try { res.json({ status: 'success', data: await svc.status(req.user, req.params.id) }); } catch (e) { fail(res, e, 'load the status'); }
});
router.post('/invoices/:id/irn', async (req, res) => {
  try { res.json({ status: 'success', data: { eInvoice: await svc.generateIrn(req.user, req.params.id) } }); } catch (e) { fail(res, e, 'generate the IRN'); }
});
router.post('/invoices/:id/irn/cancel', async (req, res) => {
  try { res.json({ status: 'success', data: { eInvoice: await svc.cancelIrn(req.user, req.params.id, { reasonCode: Number(req.body?.reasonCode), remark: req.body?.remark }) } }); } catch (e) { fail(res, e, 'cancel the IRN'); }
});
router.post('/invoices/:id/eway-bill', async (req, res) => {
  try { res.json({ status: 'success', data: { eWayBill: await svc.generateEwb(req.user, req.params.id, req.body || {}) } }); } catch (e) { fail(res, e, 'generate the e-way bill'); }
});

module.exports = router;
