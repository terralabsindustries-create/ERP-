const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const PurchaseOrder = require('../models/PurchaseOrder');
const Vendor = require('../models/Vendor');
const Inventory = require('../models/Inventory');
const InventoryMovement = require('../models/InventoryMovement');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { orgUserFilter } = require('../utils/accessScope');
const InventoryService = require('../services/InventoryService');

const router = express.Router();

/*
  Purchase orders: what the shop has ordered from a supplier (paper, ink,
  plates…) and what has arrived. Receiving an order adds the stock to
  Paper & stock and records a stock movement against the PO number.
  Status flow: draft → sent → partial → completed, or cancelled.
*/

const STATUSES = ['draft', 'sent', 'acknowledged', 'partial', 'completed', 'cancelled'];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oid = (v) => mongoose.isValidObjectId(v);

/** POs of the caller's business: tagged with its dataScope, or older ones made by its logins. */
async function poScope(user) {
  if (!user.dataScope) return { userId: user._id };
  return { $or: [{ dataScope: user.dataScope }, { dataScope: { $exists: false }, ...(await orgUserFilter(user)) }] };
}

const findPO = async (req, id) => (oid(id) ? PurchaseOrder.findOne({ $and: [{ _id: id }, await poScope(req.user)] }) : null);

const log = (req, po, action, actionType, severity = 'low') =>
  ActivityLog.logActivity({
    action,
    description: `${action}: ${po.poNumber} (${po.vendorName})`,
    entityType: 'inventory',
    entityId: po._id,
    entityName: po.poNumber,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

const orderRules = [
  body('vendorId').isMongoId().withMessage('Choose a supplier'),
  body('expectedDelivery').optional({ values: 'falsy' }).isISO8601().withMessage('Choose a valid delivery date'),
  body('notes').optional().trim().isLength({ max: 1000 }),
  body('terms').optional().trim().isLength({ max: 120 }),
  body('send').optional().isBoolean(),
  body('items').isArray({ min: 1, max: 100 }).withMessage('Add at least one item'),
  body('items.*.inventoryId').isMongoId().withMessage('Choose a stock item for every line'),
  body('items.*.quantity').isFloat({ gt: 0 }).withMessage('Every line needs a quantity'),
  body('items.*.unitCost').isFloat({ min: 0 }).withMessage('Unit cost cannot be negative')
];

/** Vendor and lines checked against the business; lines priced and named from the stock items. */
async function buildOrder(req) {
  const vendor = await Vendor.findOne({ _id: req.body.vendorId, ...(await orgUserFilter(req.user)) }).select('name');
  if (!vendor) return { error: 'Supplier not found', status: 404 };
  const ids = req.body.items.map((i) => i.inventoryId);
  const stock = await Inventory.find({ _id: { $in: ids }, ...InventoryService.itemScope(req.user) }).select('name category unit');
  const byId = new Map(stock.map((s) => [String(s._id), s]));
  if (ids.some((id) => !byId.has(String(id)))) return { error: 'Some stock items were not found', status: 400 };
  let subtotal = 0;
  const items = req.body.items.map((line) => {
    const s = byId.get(String(line.inventoryId));
    const quantity = Number(line.quantity);
    const unitCost = Number(line.unitCost);
    const totalCost = Math.round(quantity * unitCost * 100) / 100;
    subtotal += totalCost;
    return { inventoryId: s._id, itemName: s.name, category: s.category, quantity, unitCost, totalCost, receivedQuantity: 0, pendingQuantity: quantity };
  });
  subtotal = Math.round(subtotal * 100) / 100;
  return { vendor, items, subtotal };
}

// GET /api/purchase-orders?status=&search=&vendorId=&page=&limit=
router.get(
  '/',
  protect,
  [query('status').optional({ values: 'falsy' }).isIn(['all', 'open', ...STATUSES]), query('vendorId').optional({ values: 'falsy' }).isMongoId(), query('search').optional().trim(), query('page').optional().isInt({ min: 1 }), query('limit').optional().isInt({ min: 1, max: 100 })],
  validate,
  async (req, res) => {
    try {
      const { status, vendorId, search } = req.query;
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 25;
      const filters = [await poScope(req.user)];
      if (status === 'open') filters.push({ status: { $in: ['draft', 'sent', 'acknowledged', 'partial'] } });
      else if (status && status !== 'all') filters.push({ status });
      if (vendorId) filters.push({ vendorId });
      if (search) {
        const rx = new RegExp(escapeRegex(search), 'i');
        filters.push({ $or: [{ poNumber: rx }, { vendorName: rx }, { 'items.itemName': rx }] });
      }
      const q = { $and: filters };
      const [purchaseOrders, total] = await Promise.all([
        PurchaseOrder.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        PurchaseOrder.countDocuments(q)
      ]);
      res.json({ status: 'success', data: { purchaseOrders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
    } catch (error) {
      console.error('Get purchase orders error:', error);
      res.status(500).json({ status: 'error', message: 'Server error while fetching purchase orders' });
    }
  }
);

// GET /api/purchase-orders/stats/summary
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const scope = await poScope(req.user);
    const rows = await PurchaseOrder.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$totalAmount' } } }]);
    const by = Object.fromEntries(rows.map((r) => [r._id, r]));
    const open = ['draft', 'sent', 'acknowledged', 'partial'];
    const overdue = await PurchaseOrder.countDocuments({ $and: [scope, { status: { $in: ['sent', 'acknowledged', 'partial'] }, expectedDelivery: { $lt: new Date(new Date().setHours(0, 0, 0, 0)) } }] });
    res.json({
      status: 'success',
      data: {
        stats: {
          counts: Object.fromEntries(STATUSES.map((s) => [s, by[s]?.count || 0])),
          open: open.reduce((n, s) => n + (by[s]?.count || 0), 0),
          openValue: open.reduce((n, s) => n + (by[s]?.value || 0), 0),
          overdue,
          total: rows.reduce((n, r) => n + r.count, 0)
        }
      }
    });
  } catch (error) {
    console.error('Get purchase order stats error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching purchase order statistics' });
  }
});

// GET /api/purchase-orders/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const po = await findPO(req, req.params.id);
    if (!po) return res.status(404).json({ status: 'error', message: 'Purchase order not found' });
    await po.populate([{ path: 'vendorId', select: 'name contactPerson email phone' }, { path: 'items.inventoryId', select: 'name unit quantity' }]);
    res.json({ status: 'success', data: { purchaseOrder: po } });
  } catch (error) {
    console.error('Get purchase order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching purchase order' });
  }
});

// POST /api/purchase-orders  { vendorId, items:[{inventoryId, quantity, unitCost}], expectedDelivery, notes, terms, send }
router.post('/', protect, orderRules, validate, async (req, res) => {
  try {
    const built = await buildOrder(req);
    if (built.error) return res.status(built.status).json({ status: 'error', message: built.error });
    const send = req.body.send === true || req.body.send === 'true';
    let po;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        po = await PurchaseOrder.create({
          userId: req.user._id,
          dataScope: req.user.dataScope,
          createdBy: req.user._id,
          poNumber: await PurchaseOrder.generatePONumber(),
          vendorId: built.vendor._id,
          vendorName: built.vendor.name,
          status: send ? 'sent' : 'draft',
          sentAt: send ? new Date() : undefined,
          expectedDelivery: req.body.expectedDelivery ? new Date(req.body.expectedDelivery) : undefined,
          items: built.items,
          subtotal: built.subtotal,
          taxAmount: 0,
          discountAmount: 0,
          totalAmount: built.subtotal,
          notes: req.body.notes,
          terms: req.body.terms || 'Net 30'
        });
        break;
      } catch (err) {
        if (err.code !== 11000 || attempt === 2) throw err;
      }
    }
    log(req, po, 'Purchase Order Created', 'create');
    res.status(201).json({ status: 'success', message: 'Purchase order created', data: { purchaseOrder: po } });
  } catch (error) {
    console.error('Create purchase order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating purchase order' });
  }
});

// PUT /api/purchase-orders/:id — change an order nothing has been received against yet
router.put('/:id', protect, orderRules, validate, async (req, res) => {
  try {
    const po = await findPO(req, req.params.id);
    if (!po) return res.status(404).json({ status: 'error', message: 'Purchase order not found' });
    if (!['draft', 'sent', 'acknowledged'].includes(po.status) || po.items.some((i) => i.receivedQuantity > 0)) {
      return res.status(409).json({ status: 'error', message: 'Goods have been received against this order, so it can no longer be changed' });
    }
    const built = await buildOrder(req);
    if (built.error) return res.status(built.status).json({ status: 'error', message: built.error });
    Object.assign(po, {
      vendorId: built.vendor._id,
      vendorName: built.vendor.name,
      items: built.items,
      subtotal: built.subtotal,
      totalAmount: built.subtotal,
      expectedDelivery: req.body.expectedDelivery ? new Date(req.body.expectedDelivery) : undefined,
      notes: req.body.notes,
      terms: req.body.terms || po.terms
    });
    if (!po.dataScope && req.user.dataScope) po.dataScope = req.user.dataScope;
    await po.save();
    log(req, po, 'Purchase Order Updated', 'update');
    res.json({ status: 'success', message: 'Purchase order updated', data: { purchaseOrder: po } });
  } catch (error) {
    console.error('Update purchase order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating purchase order' });
  }
});

// PATCH /api/purchase-orders/:id/status  { status: 'sent' | 'cancelled' | 'draft', notes }
router.patch('/:id/status', protect, [body('status').isIn(['draft', 'sent', 'cancelled']).withMessage('Invalid status'), body('notes').optional().trim()], validate, async (req, res) => {
  try {
    const po = await findPO(req, req.params.id);
    if (!po) return res.status(404).json({ status: 'error', message: 'Purchase order not found' });
    const { status } = req.body;
    const received = po.items.some((i) => i.receivedQuantity > 0);
    const allowed = {
      sent: ['draft'].includes(po.status),
      draft: ['sent'].includes(po.status) && !received,
      cancelled: ['draft', 'sent', 'acknowledged', 'partial'].includes(po.status)
    };
    if (!allowed[status]) return res.status(409).json({ status: 'error', message: `A ${po.status} order can't be marked ${status}` });
    po.status = status;
    if (status === 'sent') po.sentAt = new Date();
    if (req.body.notes) po.notes = req.body.notes;
    await po.save();
    log(req, po, status === 'cancelled' ? 'Purchase Order Cancelled' : status === 'sent' ? 'Purchase Order Sent' : 'Purchase Order Back To Draft', status === 'cancelled' ? 'cancel' : 'update');
    res.json({ status: 'success', message: 'Purchase order updated', data: { purchaseOrder: po } });
  } catch (error) {
    console.error('Update purchase order status error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating purchase order status' });
  }
});

// POST /api/purchase-orders/:id/receive  { lines: [{ inventoryId, quantity }], reference }
// Adds what arrived to stock (one movement per line) and moves the order to partial/completed.
router.post(
  '/:id/receive',
  protect,
  [
    body('lines').isArray({ min: 1 }).withMessage('Enter what arrived'),
    body('lines.*.inventoryId').isMongoId(),
    body('lines.*.quantity').isFloat({ min: 0 }).withMessage('Quantities cannot be negative'),
    body('reference').optional().trim().isLength({ max: 80 })
  ],
  validate,
  async (req, res) => {
    try {
      const po = await findPO(req, req.params.id);
      if (!po) return res.status(404).json({ status: 'error', message: 'Purchase order not found' });
      if (!['sent', 'acknowledged', 'partial', 'draft'].includes(po.status)) {
        return res.status(409).json({ status: 'error', message: `A ${po.status} order can't receive goods` });
      }
      const lines = req.body.lines.filter((l) => Number(l.quantity) > 0);
      if (!lines.length) return res.status(400).json({ status: 'error', message: 'Enter a quantity for at least one item' });

      for (const l of lines) {
        const item = po.items.find((i) => String(i.inventoryId) === String(l.inventoryId));
        if (!item) return res.status(400).json({ status: 'error', message: 'An item is not on this order' });
        if (item.receivedQuantity + Number(l.quantity) > item.quantity) {
          return res.status(400).json({ status: 'error', message: `Only ${item.quantity - item.receivedQuantity} more of ${item.itemName} are due on this order` });
        }
      }

      const receiptLines = [];
      for (const l of lines) {
        const item = po.items.find((i) => String(i.inventoryId) === String(l.inventoryId));
        const qty = Number(l.quantity);
        const stock = await Inventory.findOne({ _id: item.inventoryId, ...InventoryService.itemScope(req.user) });
        if (stock) {
          const previousQuantity = stock.quantity;
          stock.quantity = previousQuantity + qty;
          await stock.save();
          await InventoryMovement.create({
            inventoryItem: stock._id,
            itemName: stock.name,
            movementType: 'purchase',
            quantity: qty,
            unit: stock.unit,
            unitCost: item.unitCost,
            totalCost: qty * item.unitCost,
            previousQuantity,
            newQuantity: stock.quantity,
            referenceType: 'purchase_order',
            referenceId: po._id,
            referenceNumber: po.poNumber,
            reason: `Received from ${po.vendorName}`,
            notes: req.body.reference ? `Supplier ref ${req.body.reference}` : undefined,
            userId: req.user._id,
            performedByName: req.user.fullName,
            dataScope: stock.dataScope || req.user.dataScope
          });
        }
        item.receivedQuantity += qty;
        item.pendingQuantity = Math.max(0, item.quantity - item.receivedQuantity);
        receiptLines.push({ inventoryId: item.inventoryId, itemName: item.itemName, quantity: qty });
      }

      po.receipts.push({ receivedBy: req.user._id, receivedByName: req.user.fullName, reference: req.body.reference, lines: receiptLines });
      const done = po.items.every((i) => i.receivedQuantity >= i.quantity);
      po.status = done ? 'completed' : 'partial';
      if (done) {
        po.completedAt = new Date();
        po.actualDelivery = new Date();
      }
      if (!po.sentAt) po.sentAt = new Date();
      await po.save();
      log(req, po, done ? 'Purchase Order Received' : 'Purchase Order Partly Received', 'receive', 'medium');
      res.json({ status: 'success', message: done ? 'Order received in full' : 'Delivery recorded', data: { purchaseOrder: po } });
    } catch (error) {
      console.error('Receive purchase order error:', error);
      res.status(500).json({ status: 'error', message: 'Server error while receiving goods' });
    }
  }
);

// DELETE /api/purchase-orders/:id — only drafts and cancelled orders
router.delete('/:id', protect, async (req, res) => {
  try {
    const po = await findPO(req, req.params.id);
    if (!po) return res.status(404).json({ status: 'error', message: 'Purchase order not found' });
    if (!['draft', 'cancelled'].includes(po.status) || po.items.some((i) => i.receivedQuantity > 0)) {
      return res.status(409).json({ status: 'error', message: 'Only draft or cancelled orders with nothing received can be deleted' });
    }
    await po.deleteOne();
    log(req, po, 'Purchase Order Deleted', 'delete');
    res.json({ status: 'success', message: 'Purchase order deleted' });
  } catch (error) {
    console.error('Delete purchase order error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting purchase order' });
  }
});

module.exports = router;
