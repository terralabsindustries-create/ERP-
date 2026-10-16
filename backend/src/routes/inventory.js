const express = require('express');
const mongoose = require('mongoose');
const { orgScope } = require('../utils/accessScope');

const router = express.Router();
const Inventory = require('../models/Inventory');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { requirePermission, userCan } = require('../middleware/requirePermission');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryService = require('../services/InventoryService');

// Apply auth middleware to all routes
router.use(protect);

/*
  "Inventory: View Cost". Purchase costs are hidden from logins that work in
  Inventory without that action. Logins that reach the item list from billing
  or jobs (Invoicing, Quotations, Jobs, Purchase Bills, Counter jobs) keep the
  item rate, because they price lines from it.
*/
const COST_KEYS = new Set(['unitCost', 'totalValue', 'avgUnitCost', 'minValue', 'maxValue', 'totalCost', 'totalValueMoved', 'valueChange']);
const PRICING_MODULES = ['Invoicing', 'Quotations', 'Jobs', 'Purchase Bills', 'Walk-In Jobs'];
const canSeeCost = (user) => userCan(user, 'Inventory: View Cost') || PRICING_MODULES.some((m) => userCan(user, m));
const stripCosts = (value) => {
  if (Array.isArray(value)) return value.map(stripCosts);
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId) && !Buffer.isBuffer(value)) {
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    return Object.fromEntries(Object.entries(plain).filter(([k]) => !COST_KEYS.has(k)).map(([k, v]) => [k, stripCosts(v)]));
  }
  return value;
};
router.use((req, res, next) => {
  if (canSeeCost(req.user)) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(stripCosts(body));
  next();
});

// GET /api/inventory - Get all inventory items for user's dataScope
router.get('/', async (req, res) => {
  try {
    const { category, status, search } = req.query;

    // Build query with dataScope or userId filtering
    let query = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { userId: req.user._id };

    // Add filters
    if (category && category !== 'all') {
      query.category = category;
    }
    if (status && status !== 'all') {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const inventory = await Inventory.find(query).sort({ createdAt: -1 });
    res.json({ success: true, data: inventory });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory' });
  }
});

// GET /api/inventory/stats - Get inventory statistics for user's dataScope
router.get('/stats', async (req, res) => {
  try {
    // Build query with dataScope or userId filtering
    const query = req.user.dataScope
      ? { dataScope: req.user.dataScope, status: 'active' }
      : { userId: req.user._id, status: 'active' };

    const [totalItems, lowStockItems, criticalItems, totalValue] = await Promise.all([
      Inventory.countDocuments(query),
      Inventory.getLowStockItems(orgScope(req.user)),
      Inventory.getCriticalStockItems(orgScope(req.user)),
      Inventory.getTotalValue(orgScope(req.user))
    ]);

    res.json({
      success: true,
      data: {
        totalItems,
        lowStockItems: lowStockItems.length,
        criticalItems: criticalItems.length,
        totalValue: totalValue[0]?.totalValue || 0
      }
    });
  } catch (error) {
    console.error('Error fetching inventory stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory stats' });
  }
});

// GET /api/inventory/analytics - Get comprehensive inventory analytics for user's dataScope
router.get('/analytics', async (req, res) => {
  try {
    const { category } = req.query;

    // Build query with dataScope or userId filtering
    const filterQuery = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { userId: req.user._id };

    const [analytics, categoryDistribution, topMovingItems, trends, categoryAnalytics] = await Promise.all([
      Inventory.getInventoryAnalytics(filterQuery),
      Inventory.getCategoryDistribution(filterQuery),
      Inventory.getTopMovingItems(filterQuery, 10),
      Inventory.getInventoryTrends(filterQuery, 30),
      Inventory.getCategoryAnalytics(filterQuery, category)
    ]);

    res.json({
      success: true,
      data: {
        analytics: analytics[0] || {
          totalItems: 0,
          totalValue: 0,
          totalQuantity: 0,
          avgUnitCost: 0,
          lowStockCount: 0,
          criticalStockCount: 0
        },
        categoryDistribution,
        categoryAnalytics,
        topMovingItems,
        trends
      }
    });
  } catch (error) {
    console.error('Error fetching inventory analytics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory analytics' });
  }
});

// GET /api/inventory/reports/low-stock - Get low stock report for user's dataScope
router.get('/reports/low-stock', async (req, res) => {
  try {
    const { category } = req.query;

    // Build query with dataScope or userId filtering
    const query = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { userId: req.user._id };

    let lowStockItems = await Inventory.find({
      ...query,
      $expr: { $lte: ['$quantity', '$minStockLevel'] }
    });

    // Filter by category if specified
    if (category && category !== 'all') {
      lowStockItems = lowStockItems.filter(item => item.category === category);
    }

    res.json({
      success: true,
      data: {
        items: lowStockItems,
        count: lowStockItems.length,
        totalValue: lowStockItems.reduce((sum, item) => sum + (item.quantity * item.unitCost), 0),
        byCategory: {
          Numbers: lowStockItems.filter(item => item.category === 'Numbers').length,
          'Square Feet': lowStockItems.filter(item => item.category === 'Square Feet').length
        }
      }
    });
  } catch (error) {
    console.error('Error fetching low stock report:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch low stock report' });
  }
});

// GET /api/inventory/reports/critical-stock - Get critical stock report for user's dataScope
router.get('/reports/critical-stock', async (req, res) => {
  try {
    const { category } = req.query;

    // Build query with dataScope or userId filtering
    const query = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { userId: req.user._id };

    let criticalItems = await Inventory.find({
      ...query,
      $expr: { $lte: ['$quantity', { $divide: ['$minStockLevel', 2] }] }
    });

    // Filter by category if specified
    if (category && category !== 'all') {
      criticalItems = criticalItems.filter(item => item.category === category);
    }

    res.json({
      success: true,
      data: {
        items: criticalItems,
        count: criticalItems.length,
        totalValue: criticalItems.reduce((sum, item) => sum + (item.quantity * item.unitCost), 0),
        byCategory: {
          Numbers: criticalItems.filter(item => item.category === 'Numbers').length,
          'Square Feet': criticalItems.filter(item => item.category === 'Square Feet').length
        }
      }
    });
  } catch (error) {
    console.error('Error fetching critical stock report:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch critical stock report' });
  }
});

// GET /api/inventory/reports/valuation - Get inventory valuation report for user's dataScope
router.get('/reports/valuation', async (req, res) => {
  try {
    const { category } = req.query;

    // Build match query with dataScope or userId filtering
    let matchQuery = req.user.dataScope
      ? { dataScope: req.user.dataScope, status: 'active' }
      : { userId: req.user._id, status: 'active' };

    if (category && category !== 'all') {
      matchQuery.category = category;
    }

    const valuation = await Inventory.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
          totalValue: { $sum: { $multiply: ['$quantity', '$unitCost'] } },
          avgUnitCost: { $avg: '$unitCost' },
          minValue: { $min: { $multiply: ['$quantity', '$unitCost'] } },
          maxValue: { $max: { $multiply: ['$quantity', '$unitCost'] } },
          unit: { $first: '$unit' }
        }
      },
      { $sort: { totalValue: -1 } }
    ]);

    const totalValuation = valuation.reduce((sum, cat) => sum + cat.totalValue, 0);

    res.json({
      success: true,
      data: {
        valuation,
        totalValuation,
        summary: {
          totalCategories: valuation.length,
          totalItems: valuation.reduce((sum, cat) => sum + cat.count, 0),
          totalQuantity: valuation.reduce((sum, cat) => sum + cat.totalQuantity, 0)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching valuation report:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch valuation report' });
  }
});

// GET /api/inventory/reports/movement-summary - Get movement summary
router.get('/reports/movement-summary', async (req, res) => {
  try {
    const { days = 30, category } = req.query;

    const since = new Date(Date.now() - (Number(days) || 30) * 864e5);
    const match = { ...(await InventoryService.movementScope(req.user)), createdAt: { $gte: since } };
    if (category && category !== 'all') {
      const ids = await Inventory.find({ ...InventoryService.itemScope(req.user), category }).distinct('_id');
      match.inventoryItem = { $in: ids };
    }
    const byType = await InventoryMovement.aggregate([
      { $match: match },
      { $group: { _id: '$movementType', count: { $sum: 1 }, quantity: { $sum: '$quantity' }, value: { $sum: '$totalCost' } } }
    ]);
    res.json({
      success: true,
      data: {
        period: `${Number(days) || 30} days`,
        category: category || 'all',
        summary: {
          totalMovements: byType.reduce((s, r) => s + r.count, 0),
          totalQuantityMoved: byType.reduce((s, r) => s + r.quantity, 0),
          totalValueMoved: byType.reduce((s, r) => s + r.value, 0),
          movementTypes: Object.fromEntries(byType.map((r) => [r._id, { count: r.count, quantity: r.quantity }]))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching movement summary:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch movement summary' });
  }
});

// GET /api/inventory/reports/category-comparison - Get category comparison report for user's dataScope
router.get('/reports/category-comparison', async (req, res) => {
  try {
    // Build match query with dataScope or userId filtering
    let matchQuery = req.user.dataScope
      ? { dataScope: req.user.dataScope, status: 'active' }
      : { userId: req.user._id, status: 'active' };

    const comparison = await Inventory.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: '$category',
          totalItems: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
          totalValue: { $sum: { $multiply: ['$quantity', '$unitCost'] } },
          avgUnitCost: { $avg: '$unitCost' },
          lowStockItems: {
            $sum: {
              $cond: [{ $lte: ['$quantity', '$minStockLevel'] }, 1, 0]
            }
          },
          criticalStockItems: {
            $sum: {
              $cond: [{ $lte: ['$quantity', { $divide: ['$minStockLevel', 2] }] }, 1, 0]
            }
          },
          unit: { $first: '$unit' }
        }
      },
      { $sort: { totalValue: -1 } }
    ]);

    res.json({
      success: true,
      data: {
        comparison,
        timestamp: new Date()
      }
    });
  } catch (error) {
    console.error('Error fetching category comparison:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch category comparison' });
  }
});

// GET /api/inventory/:id - Get specific inventory item
// GET /api/inventory/movements - stock in/out history of the business
//   ?item=<id>&type=sale|purchase|adjustment|return|damage&from=&to=&page=&limit=
router.get('/movements', async (req, res) => {
  try {
    const { item, type, from, to } = req.query;
    if (item && !mongoose.isValidObjectId(item)) return res.status(400).json({ success: false, message: 'Invalid item' });
    if (type && !InventoryMovement.schema.path('movementType').enumValues.includes(type)) return res.status(400).json({ success: false, message: 'Invalid movement type' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const toDate = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(new Date(`${to}T00:00:00`).getTime() + 864e5 - 1) : to;
    const { movements, total } = await InventoryService.getMovementHistory(req.user, {
      inventoryItemId: item,
      movementType: type,
      startDate: from || undefined,
      endDate: toDate || undefined,
      limit,
      skip: (page - 1) * limit,
      withTotal: true
    });
    res.json({ success: true, data: { movements, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
  } catch (error) {
    console.error('Error fetching stock movements:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stock movements' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    // Build query with dataScope or userId filtering
    const findQuery = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const item = await Inventory.findOne(findQuery);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found' });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    console.error('Error fetching inventory item:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inventory item' });
  }
});

// POST /api/inventory - Create new inventory item
router.post('/', requirePermission('Inventory: Create & Edit'), async (req, res) => {
  try {
    const inventoryData = {
      ...req.body,
      userId: req.user._id
    };

    // Add dataScope if user has it (post-migration), otherwise skip
    if (req.user.dataScope) {
      inventoryData.dataScope = req.user.dataScope;
    }

    // Auto-generate SKU if not provided
    if (!inventoryData.sku) {
      const timestamp = Date.now().toString().slice(-6);
      const randomStr = Math.random().toString(36).substring(2, 5).toUpperCase();
      inventoryData.sku = `INV-${timestamp}-${randomStr}`;
    }

    const item = new Inventory(inventoryData);
    await item.save();

    ActivityLog.logActivity({
      action: 'Inventory Item Created',
      description: `Inventory item ${item.name} was created`,
      entityType: 'inventory',
      entityId: item._id,
      entityName: item.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'create',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (create inventory) failed:', err.message));

    res.status(201).json({ success: true, data: item });
  } catch (error) {
    console.error('Error creating inventory item:', error);
    res.status(400).json({ success: false, message: 'Failed to create inventory item', error: error.message });
  }
});

// PUT /api/inventory/:id - Update inventory item
router.put('/:id', requirePermission('Inventory: Create & Edit'), async (req, res) => {
  try {
    // Build query with dataScope or userId filtering
    const findQuery = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    // Prevent SKU changes after creation (immutable)
    if (req.body.sku) {
      delete req.body.sku;
    }

    const item = await Inventory.findOneAndUpdate(
      findQuery,
      req.body,
      { new: true, runValidators: true }
    );

    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found' });
    }

    ActivityLog.logActivity({
      action: 'Inventory Item Updated',
      description: `Inventory item ${item.name} was updated`,
      entityType: 'inventory',
      entityId: item._id,
      entityName: item.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { fields: Object.keys(req.body) },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (update inventory) failed:', err.message));

    res.json({ success: true, data: item });
  } catch (error) {
    console.error('Error updating inventory item:', error);
    res.status(400).json({ success: false, message: 'Failed to update inventory item', error: error.message });
  }
});

// DELETE /api/inventory/:id - Delete inventory item
router.delete('/:id', requirePermission('Inventory: Delete'), async (req, res) => {
  try {
    // Build query with dataScope or userId filtering
    const findQuery = req.user.dataScope
      ? { _id: req.params.id, dataScope: req.user.dataScope }
      : { _id: req.params.id, userId: req.user._id };

    const item = await Inventory.findOneAndDelete(findQuery);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Inventory item not found' });
    }

    ActivityLog.logActivity({
      action: 'Inventory Item Deleted',
      description: `Inventory item ${item.name} was deleted`,
      entityType: 'inventory',
      entityId: item._id,
      entityName: item.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (delete inventory) failed:', err.message));

    res.json({ success: true, message: 'Inventory item deleted successfully' });
  } catch (error) {
    console.error('Error deleting inventory item:', error);
    res.status(500).json({ success: false, message: 'Failed to delete inventory item' });
  }
});

// POST /api/inventory/:id/adjust - Adjust inventory quantity
router.post('/:id/adjust', requirePermission('Inventory: Adjust Stock'), async (req, res) => {
  /*
    Body, one of:
      { change: +25, type: 'purchase', reason, reference, notes }   stock in / out (negative = out)
      { quantity: 120, reason, notes }                               a stock count: set the quantity
    Every adjustment is recorded as a stock movement.
  */
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Inventory item not found' });
    const item = await Inventory.findOne({ _id: req.params.id, ...InventoryService.itemScope(req.user) });
    if (!item) return res.status(404).json({ success: false, message: 'Inventory item not found' });

    const { change, quantity, reason, reference, notes } = req.body;
    const hasChange = change !== undefined && change !== null && change !== '';
    const hasQuantity = quantity !== undefined && quantity !== null && quantity !== '';
    if (!hasChange && !hasQuantity) return res.status(400).json({ success: false, message: 'Give the quantity to add, remove or set' });
    const delta = hasChange ? Number(change) : Number(quantity) - item.quantity;
    if (!Number.isFinite(delta) || (hasQuantity && !Number.isFinite(Number(quantity)))) return res.status(400).json({ success: false, message: 'Quantity must be a number' });
    if (hasChange && delta === 0) return res.status(400).json({ success: false, message: 'The change cannot be zero' });

    const previousQuantity = item.quantity;
    const newQuantity = previousQuantity + delta;
    if (newQuantity < 0) {
      return res.status(400).json({ success: false, message: `Only ${previousQuantity} ${item.unit} in stock` });
    }

    const TYPES = ['purchase', 'adjustment', 'return', 'damage', 'sale'];
    const movementType = TYPES.includes(req.body.type) ? req.body.type : delta > 0 ? 'purchase' : 'adjustment';

    item.quantity = newQuantity;
    await item.save();

    await InventoryMovement.create({
      inventoryItem: item._id,
      itemName: item.name,
      movementType,
      quantity: Math.abs(delta),
      unit: item.unit,
      unitCost: item.unitCost || 0,
      totalCost: Math.abs(delta) * (item.unitCost || 0),
      previousQuantity,
      newQuantity,
      referenceType: movementType === 'damage' ? 'damage' : movementType === 'return' ? 'return' : 'adjustment',
      referenceNumber: reference ? String(reference).slice(0, 80) : undefined,
      reason: reason ? String(reason).slice(0, 200) : hasQuantity ? 'Stock count' : undefined,
      notes: notes ? String(notes).slice(0, 500) : undefined,
      userId: req.user._id,
      performedByName: req.user.fullName,
      dataScope: item.dataScope || req.user.dataScope
    });

    ActivityLog.logActivity({
      action: 'Inventory Stock Adjusted',
      description: `${item.name}: ${previousQuantity} → ${newQuantity} ${item.unit}${reason ? ` (${reason})` : ''}`,
      entityType: 'inventory',
      entityId: item._id,
      entityName: item.name,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: { before: { quantity: previousQuantity }, after: { quantity: newQuantity }, fields: ['quantity'] },
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope
    }).catch(err => console.error('Activity log (adjust inventory) failed:', err.message));

    res.json({ success: true, data: item, message: 'Stock updated' });
  } catch (error) {
    console.error('Error adjusting inventory:', error);
    res.status(500).json({ success: false, message: 'Failed to adjust inventory' });
  }
});

// POST /api/inventory/bulk-update - Bulk update inventory items
router.post('/bulk-update', async (req, res) => {
  try {
    const { items } = req.body; // Array of { id, updates }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid items array' });
    }

    const updatePromises = items.map(({ id, updates }) => {
      // Build query with dataScope or userId filtering
      const findQuery = req.user.dataScope
        ? { _id: id, dataScope: req.user.dataScope }
        : { _id: id, userId: req.user._id };

      // Prevent SKU changes in bulk updates (immutable)
      if (updates.sku) {
        delete updates.sku;
      }

      return Inventory.findOneAndUpdate(
        findQuery,
        updates,
        { new: true, runValidators: true }
      );
    });

    const updatedItems = await Promise.all(updatePromises);

    res.json({
      success: true,
      data: updatedItems.filter(item => item !== null),
      message: 'Bulk update completed successfully'
    });
  } catch (error) {
    console.error('Error in bulk update:', error);
    res.status(400).json({ success: false, message: 'Failed to bulk update inventory', error: error.message });
  }
});

module.exports = router;