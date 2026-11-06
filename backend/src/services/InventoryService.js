const Inventory = require('../models/Inventory');
const InventoryMovement = require('../models/InventoryMovement');
const mongoose = require('mongoose');
const { orgMemberIds } = require('../utils/accessScope');

/**
 * Stock bookkeeping for invoices. Every lookup stays inside the business of
 * the login doing the work: an invoice line is matched to a stock item of the
 * same business by name, never to another business's item that happens to
 * share the name.
 */

/** The stock items of a login's business (same rule as routes/inventory.js). */
const itemScope = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/**
 * Movements of a login's business: those tagged with its dataScope, plus older
 * untagged ones made by any of its logins.
 */
const movementScope = async (user) =>
  user.dataScope
    ? { $or: [{ dataScope: user.dataScope }, { dataScope: { $exists: false }, userId: { $in: await orgMemberIds(user) } }] }
    : { userId: user._id };

const findItem = (user, name, session) => {
  const q = Inventory.findOne({ ...itemScope(user), name, status: 'active' });
  return session ? q.session(session) : q;
};

/**
 * How much of a stock item an invoice line uses. An area-priced line (6 ft ×
 * 4 ft × 10 pieces) of a stock item counted in the same area unit uses its
 * total area, 240 sq ft; every other line uses its quantity.
 */
const stockNeeded = (item, inventoryItem) => {
  const area = Number(item.totalSquareFeet) || 0;
  if (item.itemType === 'Square Feet' && area > 0 && inventoryItem && inventoryItem.unit === item.unit) return area;
  return Number(item.quantity) || 0;
};

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

// The stock status the model's save hook would give the new quantity; an
// update that bypasses save() recomputes it the same way.
const STOCK_STATUS = {
  $switch: {
    branches: [
      { case: { $lte: ['$quantity', 0] }, then: 'out_of_stock' },
      { case: { $lte: ['$quantity', { $ifNull: ['$minStockLevel', 0] }] }, then: 'low_stock' }
    ],
    default: 'adequate'
  }
};
const stockUpdate = (quantity) => [
  { $set: { quantity, lastUpdated: '$$NOW', updatedAt: '$$NOW' } },
  { $set: { stockStatus: STOCK_STATUS } }
];

/** Thrown when an invoice wants more of a stock item than is left. */
class InsufficientStockError extends Error {
  constructor(details) {
    super('Insufficient stock for invoice items');
    this.name = 'InsufficientStockError';
    this.details = details;
  }
}

class InventoryService {
  /**
   * Moves a stock item's quantity by `delta` in one atomic write, so changes
   * made at the same moment add up rather than overwrite each other. A
   * decrease is only applied while enough stock is left: if it would go below
   * zero nothing changes and this returns null.
   *
   * @returns {{ item, previousQuantity, newQuantity } | null}
   */
  static async changeStock(filter, delta, { session } = {}) {
    const guard = delta < 0 ? { quantity: { $gte: -delta } } : {};
    const item = await Inventory.findOneAndUpdate(
      { ...filter, ...guard },
      stockUpdate({ $round: [{ $add: ['$quantity', delta] }, 4] }),
      { new: true, session }
    );
    if (!item) return null;
    return { item, previousQuantity: round4(item.quantity - delta), newQuantity: item.quantity };
  }

  /**
   * Sets a stock item's quantity (a stock count) in one atomic write, and
   * reports what it was just before. Returns null if there is no such item.
   */
  static async setStock(filter, quantity, { session } = {}) {
    const before = await Inventory.findOneAndUpdate(filter, stockUpdate(round4(quantity)), { new: false, session });
    if (!before) return null;
    const item = await Inventory.findById(before._id).session(session || null);
    return { item, previousQuantity: before.quantity, newQuantity: round4(quantity) };
  }

  /**
   * Takes an invoice's stock out: for each line that is a stock item of the
   * business, an atomic decrement guarded by the quantity left (so two
   * invoices racing for the last units cannot both have them). Lines that
   * are not stock items — one-off text lines — are skipped.
   *
   * Throws InsufficientStockError if a line wants more than is left. Without
   * a transaction (no `session`), whatever this call had already taken is put
   * back before it throws; inside one, the transaction's abort does that.
   *
   * @returns {Array<{ item, quantity, previousQuantity, newQuantity }>}
   */
  static async takeStockForInvoice(lines, user, { session } = {}) {
    const taken = [];
    try {
      for (const line of lines || []) {
        if (!line.itemName || !((Number(line.quantity) || 0) > 0)) continue;
        const stock = await findItem(user, line.itemName, session);
        if (!stock) continue;
        const quantity = stockNeeded(line, stock);
        if (!(quantity > 0)) continue;

        const change = await this.changeStock({ _id: stock._id, ...itemScope(user), status: 'active' }, -quantity, { session });
        if (!change) {
          const now = await findItem(user, line.itemName, session);
          // Retired since the line was priced: no longer a stock item.
          if (!now) continue;
          throw new InsufficientStockError([
            `Insufficient stock for "${line.itemName}". Available: ${now.quantity}, Required: ${quantity}`
          ]);
        }
        taken.push({ quantity, ...change });
      }
      return taken;
    } catch (error) {
      if (!session) await this.returnStock(taken, user);
      throw error;
    }
  }

  /**
   * Puts back stock taken by takeStockForInvoice (undoing an invoice that
   * could not be completed). Keeps going past an item it cannot update, and
   * reports each one loudly: it is a stock count someone must correct.
   */
  static async returnStock(taken, user) {
    for (const { item, quantity } of taken || []) {
      try {
        await this.changeStock({ _id: item._id, ...itemScope(user) }, quantity);
      } catch (error) {
        console.error(`STOCK NOT RESTORED: ${quantity} ${item.unit} of "${item.name}" (${item._id}) — correct it by hand.`, error.message);
      }
    }
  }

  /** The "sale" stock movements recording what an invoice took. */
  static saleMovements(taken, invoice, user) {
    return (taken || []).map(({ item, quantity, previousQuantity, newQuantity }) => ({
      inventoryItem: item._id,
      itemName: item.name,
      movementType: 'sale',
      quantity,
      unit: item.unit,
      unitCost: item.unitCost || 0,
      totalCost: quantity * (item.unitCost || 0),
      previousQuantity,
      newQuantity,
      referenceType: 'invoice',
      referenceId: invoice._id,
      referenceNumber: invoice.invoiceNumber,
      reason: 'Invoice sale',
      notes: `Sold ${quantity} ${item.unit} of ${item.name}`,
      userId: user._id,
      performedByName: user.fullName,
      dataScope: item.dataScope || user.dataScope
    }));
  }

  /**
   * Put back the stock an invoice took out, when the invoice is cancelled.
   * Only movements of the caller's business are reversed.
   */
  static async restoreInventoryForCancelledInvoice(invoiceId, user) {
    const sales = await InventoryMovement.find({
      ...(await movementScope(user)),
      referenceType: 'invoice',
      referenceId: new mongoose.Types.ObjectId(String(invoiceId)),
      movementType: 'sale'
    });
    if (sales.length === 0) return { success: true, message: 'No inventory movements found for this invoice' };

    // A cancelled invoice is restored once, even if cancel is pressed twice.
    const alreadyReturned = await InventoryMovement.exists({
      ...(await movementScope(user)),
      referenceType: 'invoice',
      referenceId: new mongoose.Types.ObjectId(String(invoiceId)),
      movementType: 'return'
    });
    if (alreadyReturned) return { success: true, message: 'Stock was already restored for this invoice' };

    for (const sale of sales) {
      // Added on in one write, so a sale made at the same moment is not lost.
      const change = await this.changeStock({ _id: sale.inventoryItem, ...itemScope(user) }, sale.quantity);
      if (!change) continue;
      const { item: inventoryItem, previousQuantity, newQuantity } = change;
      await InventoryMovement.create({
        inventoryItem: sale.inventoryItem,
        itemName: sale.itemName,
        movementType: 'return',
        quantity: sale.quantity,
        unit: sale.unit,
        unitCost: sale.unitCost,
        totalCost: sale.totalCost,
        previousQuantity,
        newQuantity,
        referenceType: 'invoice',
        referenceId: sale.referenceId,
        referenceNumber: sale.referenceNumber,
        reason: 'Invoice cancelled',
        notes: `Restored ${sale.quantity} ${sale.unit} of ${sale.itemName} (invoice cancelled)`,
        userId: user._id,
        performedByName: user.fullName,
        dataScope: inventoryItem.dataScope || user.dataScope
      });
    }
    return { success: true, message: 'Inventory restored successfully' };
  }

  /**
   * Whether the business has enough stock for each invoice line. Lines that
   * are not stock items are reported as custom and always available.
   */
  static async checkStockAvailability(items, user) {
    const stockCheck = { available: true, items: [], errors: [] };
    const requiredByStock = new Map();

    for (const item of items || []) {
      const inventoryItem = item.itemName ? await findItem(user, item.itemName) : null;
      if (!inventoryItem) {
        stockCheck.items.push({ itemName: item.itemName, available: true, availableQuantity: null, requiredQuantity: item.quantity, custom: true });
        continue;
      }
      const required = stockNeeded(item, inventoryItem);
      const id = String(inventoryItem._id);
      const totalRequired = (requiredByStock.get(id) || 0) + required;
      requiredByStock.set(id, totalRequired);
      const isAvailable = inventoryItem.quantity >= totalRequired;
      if (!isAvailable) {
        stockCheck.available = false;
        stockCheck.errors.push(`Insufficient stock for "${item.itemName}". Available: ${inventoryItem.quantity}, Required: ${totalRequired} across invoice lines`);
      }
      stockCheck.items.push({
        itemName: item.itemName,
        available: isAvailable,
        availableQuantity: inventoryItem.quantity,
        requiredQuantity: totalRequired,
        unit: inventoryItem.unit
      });
    }
    return stockCheck;
  }

  /**
   * Stock movements of the caller's business, newest first.
   * filters: inventoryItemId, movementType, referenceType, referenceId, startDate, endDate, limit, skip
   */
  static async getMovementHistory(user, filters = {}) {
    const query = { ...(await movementScope(user)) };
    if (filters.inventoryItemId) query.inventoryItem = new mongoose.Types.ObjectId(String(filters.inventoryItemId));
    if (filters.movementType) query.movementType = filters.movementType;
    if (filters.referenceType) query.referenceType = filters.referenceType;
    if (filters.referenceId) query.referenceId = new mongoose.Types.ObjectId(String(filters.referenceId));
    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }
    const find = InventoryMovement.find(query)
      .populate('inventoryItem', 'name sku category unit')
      .sort({ createdAt: -1 })
      .skip(filters.skip || 0)
      .limit(filters.limit || 100);
    if (!filters.withTotal) return find;
    const [movements, total] = await Promise.all([find, InventoryMovement.countDocuments(query)]);
    return { movements, total };
  }
}

InventoryService.itemScope = itemScope;
InventoryService.InsufficientStockError = InsufficientStockError;
InventoryService.stockNeeded = stockNeeded;
InventoryService.movementScope = movementScope;

module.exports = InventoryService;
