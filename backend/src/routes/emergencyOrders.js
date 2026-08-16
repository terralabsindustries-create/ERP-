const express = require('express');
const { body, query } = require('express-validator');
const EmergencyOrder = require('../models/EmergencyOrder');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Validation rules
const emergencyOrderValidation = [
  body('customerName').notEmpty().withMessage('Customer name is required').trim(),
  body('customerPhone').notEmpty().withMessage('Customer phone is required').trim(),
  body('orderDetails').notEmpty().withMessage('Order details are required').trim(),
  body('estimatedAmount').isFloat({ min: 0 }).withMessage('Estimated amount must be a positive number'),
  body('priority').isIn(['low', 'medium', 'high', 'urgent']),
  body('status').optional().isIn(['pending', 'in_progress', 'completed', 'cancelled'])
];

// @route   GET /api/emergency-orders
// @desc    Get all emergency orders for the authenticated user
// @access  Private
router.get('/', protect, [
  query('status').optional().isIn(['pending', 'in_progress', 'completed', 'cancelled']),
  query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
  query('search').optional().trim(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const {
      status,
      priority,
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    // Build query
    const query = {};
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (priority && priority !== 'all') {
      query.priority = priority;
    }
    
    if (search) {
      query.$or = [
        { customerName: { $regex: search, $options: 'i' } },
        { customerPhone: { $regex: search, $options: 'i' } },
        { orderDetails: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Calculate pagination
    const skip = (page - 1) * limit;
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
    
    // Execute query
    const emergencyOrders = await EmergencyOrder.find(query)
      .populate('jobId', 'title status')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    // Get total count
    const totalEmergencyOrders = await EmergencyOrder.countDocuments(query);
    
    res.status(200).json({
      status: 'success',
      data: {
        emergencyOrders,
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalEmergencyOrders / limit),
          count: emergencyOrders.length,
          totalEmergencyOrders
        }
      }
    });
    
  } catch (error) {
    console.error('Get emergency orders error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching emergency orders'
    });
  }
});

// @route   GET /api/emergency-orders/:id
// @desc    Get single emergency order
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    const emergencyOrder = await EmergencyOrder.findOne({
      _id: req.params.id,
      userId: req.user._id
    }).populate('jobId', 'title status');
    
    if (!emergencyOrder) {
      return res.status(404).json({
        status: 'error',
        message: 'Emergency order not found'
      });
    }
    
    res.status(200).json({
      status: 'success',
      data: {
        emergencyOrder
      }
    });
    
  } catch (error) {
    console.error('Get emergency order error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching emergency order'
    });
  }
});

// @route   POST /api/emergency-orders
// @desc    Create new emergency order
// @access  Private
router.post('/', protect, emergencyOrderValidation, async (req, res) => {
  try {
    const emergencyOrderData = {
      ...req.body,
      userId: req.user._id
    };
    
    const emergencyOrder = await EmergencyOrder.create(emergencyOrderData);

    // Populate the created emergency order
    const populatedEmergencyOrder = await EmergencyOrder.findById(emergencyOrder._id)
      .populate('jobId', 'title status');

    ActivityLog.logActivity({
      action: 'Emergency Order Created',
      description: `Emergency order for "${emergencyOrder.customerName}" was created`,
      entityType: 'emergency_order',
      entityId: emergencyOrder._id,
      entityName: emergencyOrder.customerName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create emergency order) failed:', err.message));

    res.status(201).json({
      status: 'success',
      message: 'Emergency order created successfully',
      data: {
        emergencyOrder: populatedEmergencyOrder
      }
    });
    
  } catch (error) {
    console.error('Create emergency order error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while creating emergency order'
    });
  }
});

// @route   PUT /api/emergency-orders/:id
// @desc    Update emergency order
// @access  Private
router.put('/:id', protect, emergencyOrderValidation, async (req, res) => {
  try {
    const emergencyOrder = await EmergencyOrder.findOneAndUpdate(
      { _id: req.params.id },
      req.body,
      { new: true, runValidators: true }
    ).populate('jobId', 'title status');
    
    if (!emergencyOrder) {
      return res.status(404).json({
        status: 'error',
        message: 'Emergency order not found'
      });
    }

    ActivityLog.logActivity({
      action: 'Emergency Order Updated',
      description: `Emergency order for "${emergencyOrder.customerName}" was updated`,
      entityType: 'emergency_order',
      entityId: emergencyOrder._id,
      entityName: emergencyOrder.customerName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update emergency order) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Emergency order updated successfully',
      data: {
        emergencyOrder
      }
    });
    
  } catch (error) {
    console.error('Update emergency order error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating emergency order'
    });
  }
});

// @route   DELETE /api/emergency-orders/:id
// @desc    Delete emergency order
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const emergencyOrder = await EmergencyOrder.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });
    
    if (!emergencyOrder) {
      return res.status(404).json({
        status: 'error',
        message: 'Emergency order not found'
      });
    }

    ActivityLog.logActivity({
      action: 'Emergency Order Deleted',
      description: `Emergency order for ${emergencyOrder.customerName} was deleted`,
      entityType: 'emergency_order',
      entityId: emergencyOrder._id,
      entityName: emergencyOrder.customerName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (delete emergency order) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Emergency order deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete emergency order error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting emergency order'
    });
  }
});

// @route   PUT /api/emergency-orders/:id/status
// @desc    Update emergency order status
// @access  Private
router.put('/:id/status', protect, [
  body('status').isIn(['pending', 'in_progress', 'completed', 'cancelled']),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    const { status, notes } = req.body;

    const updateFields = { status };
    if (notes !== undefined) updateFields.notes = notes;
    if (status === 'completed') updateFields.completedAt = new Date();

    const emergencyOrder = await EmergencyOrder.findOneAndUpdate(
      { _id: req.params.id },
      updateFields,
      { new: true, runValidators: true }
    ).populate('jobId', 'title status');

    if (!emergencyOrder) {
      return res.status(404).json({
        status: 'error',
        message: 'Emergency order not found'
      });
    }

    ActivityLog.logActivity({
      action: 'Emergency Order Status Updated',
      description: `Emergency order for ${emergencyOrder.customerName} status changed to ${status}`,
      entityType: 'emergency_order',
      entityId: emergencyOrder._id,
      entityName: emergencyOrder.customerName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: status === 'completed' ? 'complete' : status === 'cancelled' ? 'cancel' : 'update',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (emergency order status) failed:', err.message));

    res.status(200).json({
      status: 'success',
      message: 'Emergency order status updated successfully',
      data: {
        emergencyOrder
      }
    });
    
  } catch (error) {
    console.error('Update emergency order status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating emergency order status'
    });
  }
});

// @route   GET /api/emergency-orders/stats/summary
// @desc    Get emergency order statistics
// @access  Private
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const [
      totalEmergencyOrders,
      todayEmergencyOrders,
      monthlyEmergencyOrders,
      pendingEmergencyOrders,
      completedEmergencyOrders,
      urgentEmergencyOrders
    ] = await Promise.all([
      EmergencyOrder.countDocuments({ userId }),
      EmergencyOrder.countDocuments({ userId, createdAt: { $gte: today } }),
      EmergencyOrder.countDocuments({ userId, createdAt: { $gte: monthStart } }),
      EmergencyOrder.countDocuments({ userId, status: 'pending' }),
      EmergencyOrder.countDocuments({ userId, status: 'completed' }),
      EmergencyOrder.countDocuments({ userId, priority: 'urgent' })
    ]);
    
    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalEmergencyOrders,
          todayEmergencyOrders,
          monthlyEmergencyOrders,
          pendingEmergencyOrders,
          completedEmergencyOrders,
          urgentEmergencyOrders
        }
      }
    });
    
  } catch (error) {
    console.error('Get emergency order stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching emergency order statistics'
    });
  }
});

module.exports = router;
