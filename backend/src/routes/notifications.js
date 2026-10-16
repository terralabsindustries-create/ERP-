const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const Task = require('../models/Task');
const Job = require('../models/Job');
const Inventory = require('../models/Inventory');
const Invoice = require('../models/Invoice');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { orgScope } = require('../utils/accessScope');
const { staffScopeQuery } = require('../utils/dataScopeHelper');
const { visibleTasks, isTeamLead } = require('./tasks');

const router = express.Router();
router.use(protect);

const OPEN_JOB = { status: { $nin: ['completed', 'delivered', 'cancelled'] } };
const OPEN_TASK = { status: { $nin: ['completed', 'cancelled'] } };

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * Live conditions that need attention, computed from the records themselves so
 * they clear as soon as the work is done. Each one is only shown to logins
 * whose permissions cover the underlying records.
 */
async function liveAlerts(user) {
  const today = startOfToday();
  const tomorrow = new Date(today.getTime() + 864e5);
  const checks = [];

  // Everyone: their own overdue work.
  checks.push(
    // Same day boundary as the team overview: due today is not overdue yet.
    Task.countDocuments({ assignedTo: user._id, ...OPEN_TASK, dueDate: { $lt: today } }).then((n) =>
      n && { id: 'my-overdue-tasks', severity: 'danger', count: n, title: `${n} of your tasks ${n === 1 ? 'is' : 'are'} overdue`, link: '/' }
    )
  );

  if (isTeamLead(user)) {
    const visible = await visibleTasks(user);
    checks.push(
      Task.countDocuments({ $and: [visible, OPEN_TASK, { assignedTo: { $ne: user._id } }, { dueDate: { $lt: today } }] }).then((n) =>
        n && { id: 'team-overdue-tasks', severity: 'danger', count: n, title: `${n} team task${n === 1 ? '' : 's'} overdue`, link: '/team' }
      ),
      Task.countDocuments({ $and: [visible, { status: 'on_hold' }] }).then((n) =>
        n && { id: 'team-blocked-tasks', severity: 'warning', count: n, title: `${n} task${n === 1 ? '' : 's'} on hold`, message: 'Blocked work waiting on a decision or material.', link: '/team' }
      )
    );
  }

  if (userCan(user, 'Jobs')) {
    const scope = orgScope(user);
    checks.push(
      Job.countDocuments({ ...scope, ...OPEN_JOB, dueDate: { $lt: today } }).then((n) =>
        n && { id: 'jobs-overdue', severity: 'danger', count: n, title: `${n} job${n === 1 ? '' : 's'} past the delivery date`, link: '/production' }
      ),
      Job.countDocuments({ ...scope, ...OPEN_JOB, dueDate: { $gte: today, $lt: tomorrow } }).then((n) =>
        n && { id: 'jobs-due-today', severity: 'warning', count: n, title: `${n} job${n === 1 ? '' : 's'} due today`, link: '/production' }
      )
    );
  }

  if (userCan(user, 'Inventory')) {
    checks.push(
      Inventory.countDocuments({ ...orgScope(user), status: 'active', $expr: { $lte: ['$quantity', '$minStockLevel'] } }).then((n) =>
        n && { id: 'low-stock', severity: 'warning', count: n, title: `${n} material${n === 1 ? '' : 's'} at or below minimum stock`, link: '/inventory' }
      )
    );
  }

  if (userCan(user, 'Invoicing')) {
    checks.push(
      Invoice.countDocuments({
        ...staffScopeQuery(user),
        status: { $nin: ['draft', 'cancelled', 'refunded'] },
        paymentStatus: { $in: ['pending', 'partial', 'overdue'] },
        balanceAmount: { $gt: 0 },
        dueDate: { $lt: today },
        ...(userCan(user, 'Invoicing (View No GST)') ? {} : { noGst: { $ne: true } })
      }).then((n) =>
        n && {
          id: 'invoices-overdue',
          severity: 'warning',
          count: n,
          title: `${n} invoice${n === 1 ? '' : 's'} overdue for payment`,
          // Reminders for those who can send them; the overdue invoices for everyone else.
          link: userCan(user, 'Payment Reminders') ? '/payment-reminders' : '/invoices?view=overdue'
        }
      )
    );
  }

  return (await Promise.all(checks)).filter(Boolean);
}

// GET /api/notifications — your messages plus live alerts
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const [items, unreadCount, alerts] = await Promise.all([
      Notification.find({ recipient: req.user._id }).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ recipient: req.user._id, readAt: null }),
      liveAlerts(req.user)
    ]);
    res.json({ status: 'success', data: { items, unreadCount, alerts } });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching notifications' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    const result = await Notification.updateMany({ recipient: req.user._id, readAt: null }, { readAt: new Date() });
    res.json({ status: 'success', data: { updated: result.modifiedCount } });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating notifications' });
  }
});

// POST /api/notifications/:id/read — only your own
router.post('/:id/read', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ status: 'error', message: 'Notification not found' });
    }
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ status: 'error', message: 'Notification not found' });
    }
    res.json({ status: 'success', data: { notification } });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating notification' });
  }
});

module.exports = router;
