const express = require('express');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { orgScope } = require('../utils/accessScope');
const { runReconciliation, CHECKS } = require('../services/reconciliation');
const TransactionJournal = require('../models/TransactionJournal');
const Customer = require('../models/Customer');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(protect);

// GET /api/reconciliation?checks=invoice_payments,customer_balances
// Read only: lists discrepancies for review; changes nothing.
router.get('/', requirePermission('Reconciliation: View'), async (req, res) => {
  try {
    const checks = req.query.checks ? String(req.query.checks).split(',').filter((c) => CHECKS[c]) : undefined;
    const report = await runReconciliation(orgScope(req.user), { checks });
    res.json({ status: 'success', data: report });
  } catch (error) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while running reconciliation' });
  }
});

// POST /api/reconciliation/resolve  { action, id, note }
// The only corrections offered here, each explicit and audited:
//   refresh_customer_stats  recompute derived customer totals (customer id)
//   resolve_operation       mark a failed/interrupted operation reviewed (journal id) — note required
// Invoice balances, stock counts and payments are corrected through their own
// permissioned workflows (Correct Balance, Adjust Stock, Payments), never here.
router.post('/resolve', requirePermission('Reconciliation: Resolve'), async (req, res) => {
  try {
    const { action, id, note } = req.body || {};
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ status: 'error', message: 'A valid id is required' });
    const scope = orgScope(req.user);
    if (action === 'refresh_customer_stats') {
      const customer = await Customer.findOne({ _id: id, ...scope });
      if (!customer) return res.status(404).json({ status: 'error', message: 'Customer not found' });
      const before = { outstandingBalance: customer.outstandingBalance, totalRevenue: customer.totalRevenue, totalSpent: customer.totalSpent };
      await customer.updateStats();
      await audit(req, { action: 'Customer Stats Refreshed (Reconciliation)', entityType: 'customer', entityId: customer._id, entityName: customer.name, actionType: 'correct', protected: true, before, after: { outstandingBalance: customer.outstandingBalance, totalRevenue: customer.totalRevenue, totalSpent: customer.totalSpent }, reason: note || 'Reconciliation refresh' });
      return res.json({ status: 'success', message: 'Customer statistics refreshed' });
    }
    if (action === 'resolve_operation') {
      if (!note || String(note).trim().length < 5) return res.status(400).json({ status: 'error', message: 'Describe what was checked or corrected (at least 5 characters)' });
      const base = scope.dataScope ? { dataScope: scope.dataScope } : { userId: scope.userId };
      const entry = await TransactionJournal.findOneAndUpdate({ _id: id, ...base, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedBy: req.user._id, resolvedAt: new Date(), resolutionNote: String(note).slice(0, 1000) } }, { new: true });
      if (!entry) return res.status(404).json({ status: 'error', message: 'Open operation not found' });
      await audit(req, { action: 'Failed Operation Resolved', entityType: 'system', entityId: entry._id, entityName: entry.label, actionType: 'correct', protected: true, reason: note, severity: 'high' });
      return res.json({ status: 'success', message: 'Operation marked resolved' });
    }
    return res.status(400).json({ status: 'error', message: 'Unknown action' });
  } catch (error) {
    console.error('Reconciliation resolve error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while resolving' });
  }
});

module.exports = router;
