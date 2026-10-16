const express = require('express');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const Job = require('../models/Job');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Inventory = require('../models/Inventory');
const Delivery = require('../models/Delivery');
const AccountTransaction = require('../models/AccountTransaction');
const Settings = require('../models/Settings');
const { settingsOwnerId, businessSettings } = require('../utils/businessSettings');
const { orgScope, orgUserFilter, orgMemberIds } = require('../utils/accessScope');
const { staffScopeQuery, canViewAllStaffData } = require('../utils/dataScopeHelper');

const router = express.Router();

/*
  Dashboard figures. Every number is counted from real records, and a section
  is only included when the caller's permissions cover those records; the
  others come back as null so the dashboard can leave them out. The `sources`
  map says where each figure comes from, which the dashboard shows on hover.
*/

const ISSUED = { status: { $nin: ['draft', 'cancelled', 'refunded'] } };
const OPEN_JOB = { status: { $nin: ['completed', 'delivered', 'cancelled'] } };

const sum = (Model, match, field) =>
  Model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` } } }]).then((r) => Math.round((r[0]?.total || 0) * 100) / 100);

// @route   GET /api/dashboard/stats
// @access  Private (sections depend on permissions)
router.get('/stats', protect, async (req, res) => {
  try {
    const user = req.user;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today.getTime() + 864e5);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const settings = await businessSettings(user);

    const stats = {
      monthlyTarget: settings.monthlyRevenueTarget,
      todaysJobs: null,
      urgentJobs: null,
      openJobs: null,
      totalCustomers: null,
      unpaidInvoices: null,
      overdueInvoices: null,
      receivables: null,
      invoicedThisMonth: null,
      collectedToday: null,
      cashBalance: null,
      bankBalance: null,
      lowStockItems: null,
      pendingDeliveries: null
    };
    const work = [];

    if (userCan(user, 'Jobs')) {
      const scope = orgScope(user);
      work.push(
        Job.countDocuments({ ...scope, createdAt: { $gte: today, $lt: tomorrow } }).then((n) => (stats.todaysJobs = n)),
        Job.countDocuments({ ...scope, ...OPEN_JOB, priority: 'urgent' }).then((n) => (stats.urgentJobs = n)),
        Job.countDocuments({ ...scope, ...OPEN_JOB }).then((n) => (stats.openJobs = n))
      );
    }

    if (userCan(user, 'Customers')) {
      work.push(Customer.countDocuments({ ...orgScope(user), status: { $ne: 'inactive' } }).then((n) => (stats.totalCustomers = n)));
    }

    if (userCan(user, 'Invoicing')) {
      const unpaid = { ...staffScopeQuery(user), ...ISSUED, balanceAmount: { $gt: 0 } };
      work.push(
        Invoice.countDocuments(unpaid).then((n) => (stats.unpaidInvoices = n)),
        Invoice.countDocuments({ ...unpaid, dueDate: { $lt: today } }).then((n) => (stats.overdueInvoices = n)),
        sum(Invoice, unpaid, 'balanceAmount').then((n) => (stats.receivables = n)),
        sum(Invoice, { ...staffScopeQuery(user), ...ISSUED, invoiceDate: { $gte: monthStart } }, 'totalAmount').then((n) => (stats.invoicedThisMonth = n))
      );
    }

    if (userCan(user, 'Payments')) {
      const scope = !user.dataScope || !canViewAllStaffData(user)
        ? { userId: user._id }
        : { $or: [{ dataScope: user.dataScope }, { userId: { $in: await orgMemberIds(user) } }] };
      work.push(sum(Payment, { $and: [scope, { status: 'completed', paymentDate: { $gte: today, $lt: tomorrow } }] }, 'amount').then((n) => (stats.collectedToday = n)));
    }

    if (userCan(user, 'Accounts')) {
      // Same business-wide ledger as Accounts → balances.
      work.push(
        orgUserFilter(user).then((scope) => AccountTransaction.getAccountBalances(scope)).then((rows) => {
          const balanceOf = (type) => rows.find((r) => r.accountType === type || r._id === type)?.balance || 0;
          stats.cashBalance = balanceOf('cash');
          stats.bankBalance = balanceOf('bank');
        })
      );
    }

    if (userCan(user, 'Inventory')) {
      work.push(
        Inventory.countDocuments({ ...orgScope(user), status: 'active', $expr: { $lte: ['$quantity', '$minStockLevel'] } }).then((n) => (stats.lowStockItems = n))
      );
    }

    if (userCan(user, 'Delivery')) {
      work.push(
        orgUserFilter(user).then((scope) =>
          Delivery.countDocuments({ ...scope, status: { $in: ['scheduled', 'in_transit'] } }).then((n) => (stats.pendingDeliveries = n))
        )
      );
    }

    await Promise.all(work);

    res.json({
      status: 'success',
      stats,
      sources: {
        todaysJobs: 'Job tickets created today',
        urgentJobs: 'Open job tickets with Rush priority',
        unpaidInvoices: 'Issued invoices with a balance due',
        overdueInvoices: 'Issued invoices with a balance due past their due date',
        receivables: 'Sum of balances due on issued invoices',
        invoicedThisMonth: 'Total of invoices issued this month',
        collectedToday: 'Payments recorded today with status Completed',
        cashBalance: 'Accounts: completed cash transactions',
        bankBalance: 'Accounts: completed bank transactions',
        lowStockItems: 'Active stock items at or below their minimum level',
        pendingDeliveries: 'Deliveries scheduled or in transit',
        monthlyTarget: 'Target you set on the dashboard'
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch dashboard statistics'
    });
  }
});

// @route   PUT /api/dashboard/monthly-target
// @desc    Update the monthly revenue target (stored with this login's settings)
// @access  Private
router.put('/monthly-target', protect, async (req, res) => {
  try {
    const { monthlyTarget } = req.body;
    if (typeof monthlyTarget !== 'number' || monthlyTarget < 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Monthly target must be a valid positive number'
      });
    }

    // The target is the business's, so only people who run it may change it.
    if (!(req.user.role === 'admin' || req.user.role === 'manager' || userCan(req.user, 'Settings: Edit'))) {
      return res.status(403).json({ status: 'error', message: 'Only the owner or a manager can change the monthly target' });
    }
    const settings = await Settings.updateSettings(await settingsOwnerId(req.user), { monthlyRevenueTarget: monthlyTarget });
    res.json({
      status: 'success',
      message: 'Monthly target updated successfully',
      data: { monthlyTarget: settings.monthlyRevenueTarget }
    });
  } catch (error) {
    console.error('❌ Error updating monthly target:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to update monthly target'
    });
  }
});

// @route   GET /api/dashboard/monthly-target
// @access  Private
router.get('/monthly-target', protect, async (req, res) => {
  try {
    const settings = await businessSettings(req.user);
    res.json({ status: 'success', data: { monthlyTarget: settings.monthlyRevenueTarget } });
  } catch (error) {
    console.error('❌ Error fetching monthly target:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch monthly target'
    });
  }
});

module.exports = router;
