const express = require('express');
const mongoose = require('mongoose');
const { query } = require('express-validator');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Same list as the model's enum.
const ENTITY_TYPES = ActivityLog.schema.path('entityType').enumValues;
const ACTION_TYPES = ActivityLog.schema.path('actionType').enumValues;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A date-only "to" includes that whole day.
const endOf = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(new Date(`${d}T00:00:00`).getTime() + 864e5 - 1) : new Date(d));

// Tenant filter, same fallback pattern used across the rest of the app
// (see utils/dataScopeHelper.js): accounts with a dataScope share it between
// the admin and their staff/managers; accounts predating dataScope fall back
// to the individual user's own id.
const scopeQueryFor = (user) =>
  user.dataScope ? { dataScope: user.dataScope } : { userId: user._id };

const buildListQuery = (user, { entityType, actionType, severity, performedBy, dateFrom, dateTo, search }) => {
  const q = { ...scopeQueryFor(user) };

  if (entityType && entityType !== 'all') q.entityType = entityType;
  if (actionType && actionType !== 'all') q.actionType = actionType;
  if (severity && severity !== 'all') q.severity = severity;
  if (performedBy) q.performedBy = performedBy;

  if (dateFrom || dateTo) {
    q.createdAt = {};
    if (dateFrom) q.createdAt.$gte = new Date(dateFrom);
    if (dateTo) q.createdAt.$lte = endOf(dateTo);
  }

  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    q.$or = [{ action: rx }, { description: rx }, { entityName: rx }, { performedByName: rx }, { tags: { $in: [rx] } }];
  }

  return q;
};

const listFilterValidators = [
  query('entityType').optional().isIn(ENTITY_TYPES),
  query('actionType').optional().isIn(ACTION_TYPES),
  query('severity').optional().isIn(['low', 'medium', 'high', 'critical']),
  query('performedBy').optional().isMongoId(),
  query('dateFrom').optional().isISO8601(),
  query('dateTo').optional().isISO8601(),
  query('search').optional().trim()
];

// @route   GET /api/activity-log
// @desc    Get activity log entries for the authenticated account (tenant-scoped)
// @access  Private
router.get('/', protect, [
  ...listFilterValidators,
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const listQuery = buildListQuery(req.user, req.query);
    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const [activities, totalActivities] = await Promise.all([
      ActivityLog.find(listQuery)
        .populate('performedBy', 'fullName email')
        .populate('relatedCustomer', 'name')
        .populate('relatedJob', 'title')
        .populate('relatedInvoice', 'invoiceNumber')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit)),
      ActivityLog.countDocuments(listQuery)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        activities,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalActivities / limit),
          count: activities.length,
          totalActivities
        }
      }
    });

  } catch (error) {
    console.error('Get activity log error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching activity log'
    });
  }
});

// @route   GET /api/activity-log/stats/summary
// @desc    Get activity log statistics for the authenticated account
// @access  Private
router.get('/stats/summary', protect, [
  query('days').optional().isInt({ min: 1, max: 365 })
], validate, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const stats = await ActivityLog.getActivityStats(scopeQueryFor(req.user), days);

    res.status(200).json({
      status: 'success',
      data: { stats }
    });

  } catch (error) {
    console.error('Get activity stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching activity statistics'
    });
  }
});

// @route   GET /api/activity-log/recent
// @desc    Get recent activity log entries for the authenticated account
// @access  Private
router.get('/recent', protect, [
  query('limit').optional().isInt({ min: 1, max: 50 })
], validate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    const activities = await ActivityLog.find(scopeQueryFor(req.user))
      .populate('performedBy', 'fullName email')
      .populate('relatedCustomer', 'name')
      .populate('relatedJob', 'title')
      .populate('relatedInvoice', 'invoiceNumber')
      .sort({ createdAt: -1 })
      .limit(limit);

    res.status(200).json({
      status: 'success',
      data: { activities }
    });

  } catch (error) {
    console.error('Get recent activity error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching recent activity'
    });
  }
});

// @route   GET /api/activity-log/critical
// @desc    Get high/critical severity activity log entries for the authenticated account
// @access  Private
router.get('/critical', protect, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const listQuery = {
      ...scopeQueryFor(req.user),
      severity: { $in: ['high', 'critical'] }
    };

    const skip = (page - 1) * limit;

    const [activities, totalActivities] = await Promise.all([
      ActivityLog.find(listQuery)
        .populate('performedBy', 'fullName email')
        .populate('relatedCustomer', 'name')
        .populate('relatedJob', 'title')
        .populate('relatedInvoice', 'invoiceNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      ActivityLog.countDocuments(listQuery)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        activities,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalActivities / limit),
          count: activities.length,
          totalActivities
        }
      }
    });

  } catch (error) {
    console.error('Get critical activity error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching critical activity'
    });
  }
});

// @route   GET /api/activity-log/export
// @desc    Export activity log entries matching the current filters as an .xlsx file
// @access  Private
router.get('/export', protect, requirePermission('Activity Log: Export'), listFilterValidators, validate, async (req, res) => {
  try {
    const listQuery = buildListQuery(req.user, req.query);

    const activities = await ActivityLog.find(listQuery)
      .populate('performedBy', 'fullName email')
      .sort({ createdAt: -1 })
      .limit(10000);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Activity Log');

    worksheet.columns = [
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Action', key: 'action', width: 25 },
      { header: 'Description', key: 'description', width: 45 },
      { header: 'Entity Type', key: 'entityType', width: 16 },
      { header: 'Entity Name', key: 'entityName', width: 22 },
      { header: 'Performed By', key: 'performedBy', width: 22 },
      { header: 'Action Type', key: 'actionType', width: 14 },
      { header: 'Severity', key: 'severity', width: 12 }
    ];

    worksheet.getRow(1).font = { bold: true, size: 11 };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };

    activities.forEach(activity => {
      worksheet.addRow({
        date: activity.createdAt ? new Date(activity.createdAt).toLocaleString('en-GB') : '',
        action: activity.action,
        description: activity.description,
        entityType: activity.entityType,
        entityName: activity.entityName || '',
        performedBy: activity.performedByName,
        actionType: activity.actionType,
        severity: activity.severity
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=activity-log-${Date.now()}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Export activity log error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while exporting activity log'
    });
  }
});

// @route   GET /api/activity-log/entity/:entityType/:entityId
// @desc    Get activity log for a specific entity within the authenticated account
// @access  Private
router.get('/entity/:entityType/:entityId', protect, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    if (!ENTITY_TYPES.includes(entityType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid entity type'
      });
    }

    const activities = await ActivityLog.getEntityActivity(entityType, entityId, scopeQueryFor(req.user));

    const skip = (page - 1) * limit;
    const paginatedActivities = activities.slice(skip, skip + parseInt(limit));

    res.status(200).json({
      status: 'success',
      data: {
        activities: paginatedActivities,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(activities.length / limit),
          count: paginatedActivities.length,
          totalActivities: activities.length
        }
      }
    });

  } catch (error) {
    console.error('Get entity activity error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching entity activity'
    });
  }
});

// @route   GET /api/activity-log/user/:userId
// @desc    Get activity log for a specific user within the authenticated account
// @access  Private
router.get('/user/:userId', protect, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const activities = await ActivityLog.getUserActivity(scopeQueryFor(req.user), userId, parseInt(limit));

    const skip = (page - 1) * limit;
    const paginatedActivities = activities.slice(skip, skip + parseInt(limit));

    res.status(200).json({
      status: 'success',
      data: {
        activities: paginatedActivities,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(activities.length / limit),
          count: paginatedActivities.length,
          totalActivities: activities.length
        }
      }
    });

  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching user activity'
    });
  }
});

// @route   GET /api/activity-log/:id
// @desc    Get single activity log entry (must belong to the authenticated account)
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Activity log entry not found' });
    const activity = await ActivityLog.findOne({ _id: req.params.id, ...scopeQueryFor(req.user) })
      .populate('performedBy', 'fullName email')
      .populate('relatedCustomer', 'name')
      .populate('relatedJob', 'title')
      .populate('relatedInvoice', 'invoiceNumber');

    if (!activity) {
      return res.status(404).json({
        status: 'error',
        message: 'Activity log entry not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: { activity }
    });

  } catch (error) {
    console.error('Get activity log entry error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching activity log entry'
    });
  }
});

// @route   DELETE /api/activity-log/:id
// @desc    Delete an activity log entry
// @access  Private (admin only — an audit trail that any user can prune isn't one)
router.delete('/:id', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        status: 'error',
        message: 'Only an admin can delete activity log entries.'
      });
    }

    const activity = mongoose.isValidObjectId(req.params.id) ? await ActivityLog.findOne({ _id: req.params.id, ...scopeQueryFor(req.user) }) : null;

    if (!activity) {
      return res.status(404).json({
        status: 'error',
        message: 'Activity log entry not found'
      });
    }

    await ActivityLog.findByIdAndDelete(req.params.id);

    res.status(200).json({
      status: 'success',
      message: 'Activity log entry deleted successfully'
    });

  } catch (error) {
    console.error('Delete activity log error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting activity log entry'
    });
  }
});

module.exports = router;
