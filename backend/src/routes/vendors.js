const express = require('express');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const Vendor = require('../models/Vendor');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const PurchaseBill = require('../models/PurchaseBill');
const { canViewAllStaffData } = require('../utils/dataScopeHelper');

const { orgUserFilter } = require('../utils/accessScope');

const { gstinError, normalizeGstin } = require('../utils/gstin');
const router = express.Router();

// Validation rules
const vendorValidation = [
  body('name').notEmpty().withMessage('Vendor name is required').trim(),
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail(),
  body('gstNumber').optional({ values: 'falsy' }).customSanitizer(normalizeGstin).custom((value) => {
    const message = gstinError(value);
    if (message) throw new Error(message);
    return true;
  }),
  body('phone').optional({ values: 'falsy' }).matches(/^\+?[\d\s()-]{7,20}$/).withMessage('Enter a valid phone number'),
  body('vendorType').optional({ values: 'falsy' }).isIn(['Supplier', 'Service Provider', 'Contractor', 'Other']),
  body('status').optional({ values: 'falsy' }).isIn(['active', 'inactive', 'blacklisted'])
];

// @route   GET /api/vendors
// @desc    Get all vendors for the authenticated user
// @access  Private
router.get('/', protect, [
  query('vendorType').optional({ values: 'falsy' }).isIn(['all', 'Supplier', 'Service Provider', 'Contractor', 'Other']),
  query('status').optional({ values: 'falsy' }).isIn(['all', 'active', 'inactive', 'blacklisted']),
  query('search').optional({ values: 'falsy' }).trim(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const {
      vendorType,
      status,
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    // Build query - filter by authenticated user
    const query = { ...(await orgUserFilter(req.user)) };

    if (vendorType && vendorType !== 'all') {
      query.vendorType = vendorType;
    }
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { contactPerson: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    // Execute query
    const vendors = await Vendor.find(query)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    // Get total count
    const totalVendors = await Vendor.countDocuments(query);

    // Billed and still owed per supplier, from the purchase bills this login
    // may see (the stored totals on the vendor are not kept up to date).
    let bills = {};
    if (vendors.length && userCan(req.user, 'Purchase Bills')) {
      const scope = canViewAllStaffData(req.user) ? await orgUserFilter(req.user) : { userId: req.user._id };
      const rows = await PurchaseBill.aggregate([
        { $match: { ...scope, vendorId: { $in: vendors.map((v) => v._id) }, status: { $ne: 'cancelled' } } },
        {
          $group: {
            _id: '$vendorId',
            billed: { $sum: '$totalAmount' },
            outstanding: { $sum: { $ifNull: ['$balanceAmount', 0] } },
            bills: { $sum: 1 },
            lastBillDate: { $max: '$billDate' }
          }
        }
      ]);
      bills = Object.fromEntries(rows.map((r) => [String(r._id), { billed: r.billed, outstanding: r.outstanding, bills: r.bills, lastBillDate: r.lastBillDate }]));
    }

    res.status(200).json({
      status: 'success',
      data: {
        vendors: vendors.map((v) => ({ ...v.toJSON(), purchases: bills[String(v._id)] || null })),
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalVendors / limit),
          count: vendors.length,
          totalVendors
        }
      }
    });
    
  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching vendors'
    });
  }
});

// @route   GET /api/vendors/analytics
// @desc    Get comprehensive vendor analytics
// @access  Private
router.get('/analytics', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const [analytics, topPerformingVendors, performanceCategories, contractAlerts, paymentTrends, communicationSummary] = await Promise.all([
      Vendor.getVendorAnalytics(userId),
      Vendor.getTopPerformingVendors(userId, 10),
      Vendor.getVendorsByPerformance(userId),
      Vendor.getContractExpiryAlerts(userId, 30),
      Vendor.getVendorPaymentTrends(userId, 12),
      Vendor.getVendorCommunicationSummary(userId, 30)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        analytics: analytics[0] || {
          totalVendors: 0,
          activeVendors: 0,
          totalPendingAmount: 0,
          totalContractValue: 0,
          avgRating: 0,
          avgPerformanceScore: 0
        },
        topPerformingVendors,
        performanceCategories,
        contractAlerts,
        paymentTrends,
        communicationSummary
      }
    });
    
  } catch (error) {
    console.error('Get vendor analytics error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching vendor analytics'
    });
  }
});

// @route   GET /api/vendors/:id
// @desc    Get single vendor
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const vendor = await Vendor.findOne({
      _id: req.params.id,
      ...(await orgUserFilter(req.user))
    });
    
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      data: {
        vendor
      }
    });
    
  } catch (error) {
    console.error('Get vendor error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching vendor'
    });
  }
});

// @route   POST /api/vendors
// @desc    Create new vendor
// @access  Private
router.post('/', protect, requirePermission('Vendors: Create & Edit'), vendorValidation, validate, async (req, res) => {
  try {
    const vendorData = {
      ...req.body,
      userId: req.user._id
    };
    
    const vendor = await Vendor.create(vendorData);

    ActivityLog.logActivity({
      action: 'Vendor Created',
      description: `Vendor ${vendor.name} was created`,
      entityType: 'vendor',
      entityId: vendor._id,
      entityName: vendor.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create vendor) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Vendor created successfully',
      data: {
        vendor
      }
    });
    
  } catch (error) {
    console.error('Create vendor error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while creating vendor'
    });
  }
});

// @route   PUT /api/vendors/:id
// @desc    Update vendor
// @access  Private
router.put('/:id', protect, requirePermission('Vendors: Create & Edit'), vendorValidation, validate, async (req, res) => {
  try {
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, ...(await orgUserFilter(req.user)) },
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }

    ActivityLog.logActivity({
      action: 'Vendor Updated',
      description: `Vendor ${vendor.name} was updated`,
      entityType: 'vendor',
      entityId: vendor._id,
      entityName: vendor.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update vendor) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Vendor updated successfully',
      data: {
        vendor
      }
    });
    
  } catch (error) {
    console.error('Update vendor error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating vendor'
    });
  }
});

// Everything that still refers to a supplier. A supplier with any of it is
// deactivated, never deleted, so purchase history stays readable.
async function vendorHistory(vendor) {
  const PurchaseOrder = require('../models/PurchaseOrder');
  const PurchaseBill = require('../models/PurchaseBill');
  const Cost = require('../models/Cost');
  const AccountTransaction = require('../models/AccountTransaction');
  const Cheque = require('../models/Cheque');
  const id = vendor._id;
  const [orders, bills, costs, transactions, cheques] = await Promise.all([
    PurchaseOrder.countDocuments({ vendorId: id }),
    PurchaseBill.countDocuments({ vendorId: id }),
    Cost.countDocuments({ vendorId: id }),
    AccountTransaction.countDocuments({ vendorId: id }),
    Cheque.countDocuments({ vendorId: id })
  ]);
  return { orders, bills, costs, transactions, cheques, total: orders + bills + costs + transactions + cheques };
}

async function setVendorStatus(req, res, status) {
  try {
    const vendor = await Vendor.findOne({ _id: req.params.id, ...(await orgUserFilter(req.user)) });
    if (!vendor) return res.status(404).json({ status: 'error', message: 'Vendor not found' });
    if (vendor.status === status) {
      return res.status(200).json({ status: 'success', message: `Supplier is already ${status}`, data: { vendor } });
    }
    vendor.status = status;
    await vendor.save();
    ActivityLog.logActivity({
      action: status === 'active' ? 'Vendor Reactivated' : 'Vendor Deactivated',
      description: `Vendor ${vendor.name} was ${status === 'active' ? 'reactivated' : 'deactivated'}`,
      entityType: 'vendor',
      entityId: vendor._id,
      entityName: vendor.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (vendor status) failed:', err.message));
    res.status(200).json({
      status: 'success',
      message: status === 'active'
        ? `${vendor.name} is active again and can be used on new purchase orders.`
        : `${vendor.name} was deactivated. Existing orders and bills keep showing it; it will not be offered on new ones.`,
      data: { vendor }
    });
  } catch (error) {
    console.error('Vendor status error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating supplier' });
  }
}

// @route   PATCH /api/vendors/:id/deactivate | /reactivate
router.patch('/:id/deactivate', protect, requirePermission('Vendors: Create & Edit'), (req, res) => setVendorStatus(req, res, 'inactive'));
router.patch('/:id/reactivate', protect, requirePermission('Vendors: Create & Edit'), (req, res) => setVendorStatus(req, res, 'active'));

// @route   DELETE /api/vendors/:id
// @desc    Permanently delete a vendor that has no purchase history
// @access  Private
router.delete('/:id', protect, requirePermission('Vendors: Delete'), async (req, res) => {
  try {
    const vendor = await Vendor.findOne({ _id: req.params.id, ...(await orgUserFilter(req.user)) });
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }

    const history = await vendorHistory(vendor);
    if (history.total > 0) {
      return res.status(409).json({
        status: 'error',
        code: 'VENDOR_HAS_HISTORY',
        message: `${vendor.name} has purchase history (${history.orders} orders, ${history.bills} bills, ${history.costs + history.transactions + history.cheques} payments/costs) and cannot be deleted. Deactivate it instead: it stays on past records but is not offered on new ones.`,
        details: history
      });
    }
    await Vendor.deleteOne({ _id: vendor._id });

    ActivityLog.logActivity({
      action: 'Vendor Deleted',
      description: `Vendor ${vendor.name} was deleted`,
      entityType: 'vendor',
      entityId: vendor._id,
      entityName: vendor.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (delete vendor) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Vendor deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete vendor error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting vendor'
    });
  }
});

// @route   GET /api/vendors/stats/summary
// @desc    Get vendor statistics
// @access  Private
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    const scope = await orgUserFilter(req.user);
    
    const [totalVendors, activeVendors, inactiveVendors, blacklistedVendors] = await Promise.all([
      Vendor.countDocuments({ ...scope }),
      Vendor.countDocuments({ ...scope, status: 'active' }),
      Vendor.countDocuments({ ...scope, status: 'inactive' }),
      Vendor.countDocuments({ ...scope, status: 'blacklisted' })
    ]);
    
    // Get vendor type distribution
    const vendorTypeStats = await Vendor.aggregate([
      { $match: { ...scope } },
      { $group: { _id: '$vendorType', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalVendors,
          activeVendors,
          inactiveVendors,
          blacklistedVendors,
          vendorTypeStats
        }
      }
    });
    
  } catch (error) {
    console.error('Get vendor stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching vendor statistics'
    });
  }
});

// @route   GET /api/vendors/:id/performance
// @desc    Get vendor performance details
// @access  Private
router.get('/:id/performance', protect, async (req, res) => {
  try {
    const vendor = await Vendor.findOne({
      _id: req.params.id,
      ...(await orgUserFilter(req.user))
    }).select('name performanceMetrics communicationHistory paymentHistory');
    
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      data: {
        vendor: {
          name: vendor.name,
          performanceMetrics: vendor.performanceMetrics,
          communicationHistory: vendor.communicationHistory.slice(-10), // Last 10 communications
          paymentHistory: vendor.paymentHistory.slice(-10) // Last 10 payments
        }
      }
    });
    
  } catch (error) {
    console.error('Get vendor performance error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching vendor performance'
    });
  }
});

// @route   PUT /api/vendors/:id/performance
// @desc    Update vendor performance metrics
// @access  Private
router.put('/:id/performance', protect, [
  body('onTimeDelivery').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  body('qualityRating').optional({ values: 'falsy' }).isFloat({ min: 1, max: 5 }),
  body('communicationRating').optional({ values: 'falsy' }).isFloat({ min: 1, max: 5 }),
  body('priceCompetitiveness').optional({ values: 'falsy' }).isFloat({ min: 1, max: 5 })
], validate, async (req, res) => {
  try {
    const { onTimeDelivery, qualityRating, communicationRating, priceCompetitiveness } = req.body;
    
    // Calculate overall score
    const overallScore = (qualityRating + communicationRating + priceCompetitiveness) / 3;
    
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, ...(await orgUserFilter(req.user)) },
      {
        $set: {
          'performanceMetrics.onTimeDelivery': onTimeDelivery,
          'performanceMetrics.qualityRating': qualityRating,
          'performanceMetrics.communicationRating': communicationRating,
          'performanceMetrics.priceCompetitiveness': priceCompetitiveness,
          'performanceMetrics.overallScore': overallScore,
          'performanceMetrics.lastEvaluated': new Date()
        }
      },
      { new: true }
    );
    
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      message: 'Vendor performance updated successfully',
      data: {
        vendor: {
          name: vendor.name,
          performanceMetrics: vendor.performanceMetrics
        }
      }
    });
    
  } catch (error) {
    console.error('Update vendor performance error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating vendor performance'
    });
  }
});

// @route   POST /api/vendors/:id/communication
// @desc    Add communication record
// @access  Private
router.post('/:id/communication', protect, [
  body('type').isIn(['Email', 'Phone', 'Meeting', 'WhatsApp', 'Other']),
  body('subject').notEmpty().trim(),
  body('notes').optional({ values: 'falsy' }).trim(),
  body('initiatedBy').isIn(['Vendor', 'Company', 'Both'])
], validate, async (req, res) => {
  try {
    const { type, subject, notes, initiatedBy } = req.body;
    
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, ...(await orgUserFilter(req.user)) },
      {
        $push: {
          communicationHistory: {
            date: new Date(),
            type,
            subject,
            notes,
            initiatedBy
          }
        }
      },
      { new: true }
    );
    
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      message: 'Communication record added successfully',
      data: {
        communication: vendor.communicationHistory[vendor.communicationHistory.length - 1]
      }
    });
    
  } catch (error) {
    console.error('Add communication error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while adding communication record'
    });
  }
});

// @route   POST /api/vendors/:id/payment
// @desc    Add payment record
// @access  Private
router.post('/:id/payment', protect, [
  body('amount').isFloat({ gt: 0 }).withMessage('Enter an amount above 0'),
  body('invoiceNumber').optional({ values: 'falsy' }).trim(),
  body('paymentMethod').isIn(['Bank Transfer', 'Cheque', 'Cash', 'UPI', 'Other']),
  body('status').isIn(['Pending', 'Paid', 'Overdue', 'Cancelled']),
  body('notes').optional({ values: 'falsy' }).trim()
], validate, async (req, res) => {
  try {
    const { amount, invoiceNumber, paymentMethod, status, notes } = req.body;
    
    const vendor = await Vendor.findOneAndUpdate(
      { _id: req.params.id, ...(await orgUserFilter(req.user)) },
      {
        $push: {
          paymentHistory: {
            date: new Date(),
            amount,
            invoiceNumber,
            paymentMethod,
            status,
            notes
          }
        },
        $inc: {
          pendingAmount: status === 'Paid' ? -amount : amount
        }
      },
      { new: true }
    );
    
    if (!vendor) {
      return res.status(404).json({
        status: 'error',
        message: 'Vendor not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      message: 'Payment record added successfully',
      data: {
        payment: vendor.paymentHistory[vendor.paymentHistory.length - 1],
        updatedPendingAmount: vendor.pendingAmount
      }
    });
    
  } catch (error) {
    console.error('Add payment error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while adding payment record'
    });
  }
});

module.exports = router;