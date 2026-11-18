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
const { orgUserFilter, purchaseOrderScope } = require('../utils/accessScope');
const InventoryService = require('../services/InventoryService');
const { inTransaction } = require('../utils/transactions');

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
const poScope = purchaseOrderScope;

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
  body('items.*.unitCost').isFloat({ gt: 0 }).withMessage('Every line needs a unit cost above 0')
];

/** Vendor and lines checked against the business; lines priced and named from the stock items. */
async function buildOrder(req) {
  const vendor = await Vendor.findOne({ _id: req.body.vendorId, ...(await orgUserFilter(req.user)) }).select('name');
  if (!vendor) return { error: 'Supplier not found', status: 404 };
  const ids = req.body.items.map((i) => i.inventoryId);
  const stock = await Inventory.find({ _id: { $in: ids }, ...InventoryService.itemScope(req.user) }).select('name category unit');
  const byId = new Map(stock.map((s) => [String(s._id), s]));
  if (ids.some((id) => !byId.has(String(id)))) return { error: 'Some stock items were not found', status: 400 };
  // One line per stock item, so what is due and what arrives are counted once.
  const twice = ids.find((id, i) => ids.findIndex((other) => String(other) === String(id)) !== i);
  if (twice) return { error: `${byId.get(String(twice)).name} is on the order twice. Put it on one line.`, status: 400 };
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
          approvedBy: send ? req.user._id : undefined,
          approvedAt: send ? new Date() : undefined,
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
    if (po.purchaseBillId) return res.status(409).json({ status: 'error', message: 'Delete the generated purchase bill before changing this order' });
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
    if (po.purchaseBillId && status !== po.status) {
      return res.status(409).json({ status: 'error', message: 'Delete the generated purchase bill before changing this order' });
    }
    const received = po.items.some((i) => i.receivedQuantity > 0);
    const allowed = {
      sent: ['draft'].includes(po.status),
      draft: ['sent'].includes(po.status) && !received,
      cancelled: ['draft', 'sent', 'acknowledged', 'partial'].includes(po.status)
    };
    if (!allowed[status]) return res.status(409).json({ status: 'error', message: `A ${po.status} order can't be marked ${status}` });
    po.status = status;
    // Placing the order is its approval; from then on a bill can be generated from it.
    if (status === 'sent') {
      po.sentAt = new Date();
      po.approvedBy = req.user._id;
      po.approvedAt = po.sentAt;
    }
    if (req.body.notes) po.notes = req.body.notes;
    await po.save();
    log(req, po, status === 'cancelled' ? 'Purchase Order Cancelled' : status === 'sent' ? 'Purchase Order Sent' : 'Purchase Order Back To Draft', status === 'cancelled' ? 'cancel' : 'update');
    res.json({ status: 'success', message: 'Purchase order updated', data: { purchaseOrder: po } });
  } catch (error) {
    console.error('Update purchase order status error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while updating purchase order status' });
  }
});

/*
  Receiving goods.

  What arrived is combined per stock item first (two lines for the same item
  add up), then spread over the order's lines for that item, oldest first —
  so a delivery is checked against everything still due for the item, once.

  The order, the stock counts and the stock movements change together:
  - the order is claimed first, with a write that only lands on the version
    of the order that was read (and only while it can still receive). A
    delivery recorded at the same moment makes the claim miss; the order is
    read again and the request re-checked against what is now due;
  - then each item's stock goes up and the movements are recorded.
  With transactions (a replica set, MongoDB Atlas) this is one transaction.
  On a standalone MongoDB each step registers its undo, and a failure after
  the claim puts the order and the stock back (utils/transactions.js).

  An idempotency key (Idempotency-Key header or body.idempotencyKey) makes a
  retried request — a double click, a dropped connection — return the
  delivery already recorded instead of adding the stock twice.
*/
const RECEIVABLE = ['sent', 'acknowledged', 'partial'];
const ATTEMPTS = 5;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const atVersion = (doc) => (doc.__v === undefined || doc.__v === null ? { __v: { $exists: false } } : { __v: doc.__v });

class ReceiveError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class OrderChanged extends Error {}

/** What arrived, one entry per stock item. */
function combineLines(lines) {
  const byItem = new Map();
  for (const line of lines) {
    const quantity = Number(line.quantity);
    if (!(quantity > 0)) continue;
    const id = String(line.inventoryId);
    byItem.set(id, round4((byItem.get(id) || 0) + quantity));
  }
  return [...byItem].map(([inventoryId, quantity]) => ({ inventoryId, quantity }));
}

/** Each item's quantity spread over the order lines for it; refuses more than is due. */
function allocate(po, combined) {
  const allocations = [];
  for (const { inventoryId, quantity } of combined) {
    const lines = po.items.map((item, index) => ({ item, index })).filter(({ item }) => String(item.inventoryId) === inventoryId);
    if (!lines.length) throw new ReceiveError(400, 'An item is not on this order');
    const due = round4(lines.reduce((sum, { item }) => sum + Math.max(0, item.quantity - item.receivedQuantity), 0));
    if (quantity > due) throw new ReceiveError(400, `Only ${due} more of ${lines[0].item.itemName} ${due === 1 ? 'is' : 'are'} due on this order`);
    let left = quantity;
    for (const { item, index } of lines) {
      const take = Math.min(left, round4(Math.max(0, item.quantity - item.receivedQuantity)));
      if (take > 0) {
        allocations.push({ inventoryId, index, quantity: take, unitCost: item.unitCost });
        left = round4(left - take);
      }
      if (!(left > 0)) break;
    }
  }
  return allocations;
}

/** The order's fields after a delivery (or, with sign -1, after undoing one). */
function receivedState(po, allocations, sign = 1, statusBefore = 'sent') {
  const items = po.items.map((item) => ({ ...item }));
  for (const { index, quantity } of allocations) {
    const item = items[index];
    item.receivedQuantity = Math.max(0, round4(item.receivedQuantity + sign * quantity));
    item.pendingQuantity = Math.max(0, round4(item.quantity - item.receivedQuantity));
  }
  const done = items.every((i) => i.receivedQuantity >= i.quantity);
  const any = items.some((i) => i.receivedQuantity > 0);
  const set = {};
  allocations.forEach(({ index }) => {
    set[`items.${index}.receivedQuantity`] = items[index].receivedQuantity;
    set[`items.${index}.pendingQuantity`] = items[index].pendingQuantity;
  });
  set.status = done ? 'completed' : any ? 'partial' : (RECEIVABLE.includes(statusBefore) && statusBefore !== 'partial' ? statusBefore : 'sent');
  return { set, done };
}

/** Takes a delivery back off an order (an undo step without transactions). */
async function unreceive(orderId, receiptId, allocations, statusBefore) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const po = await PurchaseOrder.findById(orderId).lean();
    if (!po || !po.receipts.some((r) => String(r._id) === String(receiptId))) return;
    const { set, done } = receivedState(po, allocations, -1, statusBefore);
    const unset = done ? {} : { completedAt: '', actualDelivery: '' };
    const undone = await PurchaseOrder.updateOne(
      { _id: orderId, ...atVersion(po) },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $pull: { receipts: { _id: receiptId } }, $inc: { __v: 1 } }
    );
    if (undone.modifiedCount) return;
  }
  throw new Error(`delivery ${receiptId} could not be taken off order ${orderId}`);
}

const idempotencyKeyOf = (req) => {
  const key = (req.get('Idempotency-Key') || req.body.idempotencyKey || '').toString().trim();
  return key || undefined;
};

// POST /api/purchase-orders/:id/receive  { lines: [{ inventoryId, quantity }], reference, idempotencyKey }
router.post(
  '/:id/receive',
  protect,
  [
    body('lines').isArray({ min: 1, max: 200 }).withMessage('Enter what arrived'),
    body('lines.*.inventoryId').isMongoId(),
    body('lines.*.quantity').isFloat({ min: 0 }).withMessage('Quantities cannot be negative'),
    body('reference').optional().trim().isLength({ max: 80 }),
    body('idempotencyKey').optional().isString().trim().isLength({ min: 8, max: 100 }).withMessage('Invalid idempotency key')
  ],
  validate,
  async (req, res) => {
    const key = idempotencyKeyOf(req);
    if (key && (key.length < 8 || key.length > 100)) return res.status(400).json({ status: 'error', message: 'Invalid idempotency key' });
    try {
      const combined = combineLines(req.body.lines);
      if (!combined.length) return res.status(400).json({ status: 'error', message: 'Enter a quantity for at least one item' });

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const po = oid(req.params.id) ? await PurchaseOrder.findOne({ $and: [{ _id: req.params.id }, await poScope(req.user)] }).lean() : null;
        if (!po) return res.status(404).json({ status: 'error', message: 'Purchase order not found' });
        if (key && po.receipts.some((r) => r.idempotencyKey === key)) {
          return res.json({ status: 'success', message: 'Delivery already recorded', data: { purchaseOrder: await PurchaseOrder.findById(po._id), replayed: true } });
        }
        if (!RECEIVABLE.includes(po.status)) {
          return res.status(409).json({ status: 'error', message: po.status === 'completed' ? 'Everything on this order has been received' : 'Mark the purchase order Ordered before receiving goods' });
        }

        const allocations = allocate(po, combined);
        const scope = InventoryService.itemScope(req.user);
        const stock = await Inventory.find({ _id: { $in: combined.map((c) => c.inventoryId) }, ...scope }).select('name').lean();
        const missing = combined.find((c) => !stock.some((s) => String(s._id) === c.inventoryId));
        if (missing) {
          const name = po.items.find((i) => String(i.inventoryId) === missing.inventoryId)?.itemName || 'An item';
          return res.status(409).json({ status: 'error', message: `${name} is no longer in Paper & stock, so it can't be received` });
        }

        const receiptId = new mongoose.Types.ObjectId();
        const receiptLines = combined.map(({ inventoryId, quantity }) => ({
          inventoryId, itemName: po.items.find((i) => String(i.inventoryId) === inventoryId).itemName, quantity
        }));
        const { set, done } = receivedState(po, allocations, 1);
        const now = new Date();
        if (done) Object.assign(set, { completedAt: now, actualDelivery: now });
        if (!po.sentAt) set.sentAt = now;

        try {
          const purchaseOrder = await inTransaction(async ({ session, onUndo }) => {
            const claimed = await PurchaseOrder.findOneAndUpdate(
              { _id: po._id, ...atVersion(po), status: { $in: RECEIVABLE }, ...(key ? { 'receipts.idempotencyKey': { $ne: key } } : {}) },
              {
                $set: set,
                $push: { receipts: { _id: receiptId, receivedAt: now, receivedBy: req.user._id, receivedByName: req.user.fullName, reference: req.body.reference, idempotencyKey: key, lines: receiptLines } },
                $inc: { __v: 1 }
              },
              { new: true, session }
            );
            if (!claimed) throw new OrderChanged();
            onUndo(() => unreceive(po._id, receiptId, allocations, po.status));

            const movements = [];
            for (const { inventoryId, quantity } of combined) {
              const filter = { _id: inventoryId, ...scope };
              // Added in one atomic write, so a sale made at the same moment is not overwritten.
              const received = await InventoryService.changeStock(filter, quantity, { session });
              if (!received) throw new ReceiveError(409, 'A stock item on this order was removed while receiving. Nothing was recorded.');
              onUndo(() => InventoryService.revertChange(filter, quantity));
              const { item: stockItem, previousQuantity, newQuantity } = received;

              const parts = allocations.filter((a) => a.inventoryId === inventoryId);
              const totalCost = Math.round(parts.reduce((sum, a) => sum + a.quantity * a.unitCost, 0) * 100) / 100;
              // The item's purchase price follows what was last paid for it.
              const lastCost = parts[parts.length - 1].unitCost;
              if (lastCost > 0 && stockItem.unitCost !== lastCost) {
                await Inventory.updateOne({ _id: stockItem._id }, { $set: { unitCost: lastCost } }, { session });
                onUndo(() => Inventory.updateOne({ _id: stockItem._id, unitCost: lastCost }, { $set: { unitCost: stockItem.unitCost } }));
              }
              movements.push({
                inventoryItem: stockItem._id,
                itemName: stockItem.name,
                movementType: 'purchase',
                quantity,
                unit: stockItem.unit,
                unitCost: quantity > 0 ? Math.round((totalCost / quantity) * 10000) / 10000 : lastCost,
                totalCost,
                previousQuantity,
                newQuantity,
                referenceType: 'purchase_order',
                referenceId: po._id,
                referenceNumber: po.poNumber,
                reason: `Received from ${po.vendorName}`,
                notes: req.body.reference ? `Supplier ref ${req.body.reference}` : undefined,
                userId: req.user._id,
                performedByName: req.user.fullName,
                dataScope: stockItem.dataScope || req.user.dataScope
              });
            }
            const recorded = await InventoryMovement.insertMany(movements, { session });
            onUndo(() => InventoryMovement.deleteMany({ _id: { $in: recorded.map((m) => m._id) } }));
            return claimed;
          }, { label: 'Purchase order receipt' });

          log(req, purchaseOrder, done ? 'Purchase Order Received' : 'Purchase Order Partly Received', 'receive', 'medium');
          return res.json({ status: 'success', message: done ? 'Order received in full' : 'Delivery recorded', data: { purchaseOrder } });
        } catch (error) {
          if (error instanceof OrderChanged) continue; // read the order again and re-check
          throw error;
        }
      }
      return res.status(409).json({ status: 'error', message: 'The order changed while receiving. Refresh and try again.' });
    } catch (error) {
      if (error instanceof ReceiveError) return res.status(error.status).json({ status: 'error', message: error.message });
      console.error('Receive purchase order error:', error);
      res.status(500).json({ status: 'error', message: 'Server error while receiving goods. Nothing was recorded; try again.' });
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
