const express = require('express');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { staffScopeQuery } = require('../utils/dataScopeHelper');
const { issueInvoice, IssueError } = require('../services/invoiceIssue');

/*
  POST /api/invoices-bulk/issue   { ids: [...] }  issue several drafts
  Each id is checked on its own (business, visibility, still a draft); the
  answer lists every success with its new number and every failure with its
  reason. Issued invoices are never deleted or edited here — there is no bulk
  delete for financial documents.
*/
const router = express.Router();
router.use(protect);

router.post('/issue', async (req, res) => {
  try {
    if (!userCan(req.user, 'Invoicing: Create & Edit')) return res.status(403).json({ status: 'error', code: 'PERMISSION_DENIED', message: 'You do not have permission to do this.' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ status: 'error', message: 'Select at least one draft invoice.' });
    const noGst = userCan(req.user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } };
    const succeeded = [];
    const failed = [];
    // One at a time, in the order given, so numbers follow the selection.
    for (const id of ids) {
      if (!mongoose.isValidObjectId(id)) { failed.push({ id, reason: 'Not found' }); continue; }
      try {
        const inv = await issueInvoice({ _id: id, ...staffScopeQuery(req.user), ...noGst });
        succeeded.push({ id, invoiceNumber: inv.invoiceNumber });
        ActivityLog.logActivity({ action: 'Invoice Issued (bulk)', description: `Invoice ${inv.invoiceNumber} was issued`, entityType: 'invoice', entityId: inv._id, entityName: inv.invoiceNumber, performedBy: req.user._id, performedByName: req.user.fullName, actionType: 'update', userId: req.user._id, dataScope: req.user.dataScope }).catch(() => {});
      } catch (error) {
        failed.push({ id, reason: error instanceof IssueError ? error.message : 'Could not be issued' });
      }
    }
    res.json({ status: 'success', data: { succeeded, failed } });
  } catch (error) {
    console.error('Bulk issue error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while issuing invoices' });
  }
});

module.exports = router;
