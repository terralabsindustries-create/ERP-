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

class InventoryService {
  /**
   * Take invoice quantities out of stock and record a "sale" movement per line.
   * Lines that are not stock items (custom text lines) are skipped.
   * @param {Array} items - Priced invoice lines ({ itemName, quantity, unit, itemType, totalSquareFeet })
   * @param {String} invoiceId
   * @param {String} invoiceNumber
   * @param {Object} user - req.user of the login creating the invoice
   */
  static async deductInventoryForInvoice(items, invoiceId, invoiceNumber, user) {
    const movements = [];
    const errors = [];

    try {
      let session = null;
      try {
        session = await mongoose.startSession();
      } catch {
        session = null;
      }

      if (session) {
        try {
          await session.withTransaction(async () => {
            for (const item of items) {
              await this.processInventoryDeduction(item, invoiceId, invoiceNumber, user, session, movements, errors);
            }
          });
          await session.endSession();
          return { success: errors.length === 0, movements, errors };
        } catch (txError) {
          // Standalone MongoDB has no transactions; do it step by step instead.
          await session.endSession().catch(() => {});
          movements.length = 0;
          errors.length = 0;
          if (!/Transaction numbers are only allowed|replica set|transaction/i.test(txError.message || '')) {
            console.error('Inventory deduction transaction failed:', txError.message);
          }
        }
      }

      for (const item of items) {
        await this.processInventoryDeduction(item, invoiceId, invoiceNumber, user, null, movements, errors);
      }
      return { success: errors.length === 0, movements, errors };
    } catch (error) {
      console.error('Error in deductInventoryForInvoice:', error);
      return { success: false, movements, errors: [...errors, error.message] };
    }
  }

  static async processInventoryDeduction(item, invoiceId, invoiceNumber, user, session, movements, errors) {
    if (!item.itemName || !((Number(item.quantity) || 0) > 0)) return;

    const inventoryItem = await findItem(user, item.itemName, session);
    // Not a stock item: a one-off line typed on the invoice. Nothing to deduct.
    if (!inventoryItem) return;
    const quantity = stockNeeded(item, inventoryItem);

    if (inventoryItem.quantity < quantity) {
      errors.push(`Insufficient stock for "${item.itemName}". Available: ${inventoryItem.quantity}, Required: ${quantity}`);
      return;
    }

    const previousQuantity = inventoryItem.quantity;
    const newQuantity = previousQuantity - quantity;
    await Inventory.updateOne({ _id: inventoryItem._id }, { quantity: newQuantity, updatedAt: Date.now() }, session ? { session } : {});

    const movement = new InventoryMovement({
      inventoryItem: inventoryItem._id,
      itemName: inventoryItem.name,
      movementType: 'sale',
      quantity,
      unit: inventoryItem.unit,
      unitCost: inventoryItem.unitCost || 0,
      totalCost: quantity * (inventoryItem.unitCost || 0),
      previousQuantity,
      newQuantity,
      referenceType: 'invoice',
      referenceId: new mongoose.Types.ObjectId(String(invoiceId)),
      referenceNumber: invoiceNumber,
      reason: 'Invoice sale',
      notes: `Sold ${quantity} ${inventoryItem.unit} of ${inventoryItem.name}`,
      userId: user._id,
      performedByName: user.fullName,
      dataScope: inventoryItem.dataScope || user.dataScope
    });
    await movement.save(session ? { session } : undefined);
    movements.push(movement);
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
      const inventoryItem = await Inventory.findOne({ _id: sale.inventoryItem, ...itemScope(user) });
      if (!inventoryItem) continue;
      const previousQuantity = inventoryItem.quantity;
      const newQuantity = previousQuantity + sale.quantity;
      await Inventory.updateOne({ _id: inventoryItem._id }, { quantity: newQuantity, updatedAt: Date.now() });
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

    for (const item of items || []) {
      const inventoryItem = item.itemName ? await findItem(user, item.itemName) : null;
      if (!inventoryItem) {
        stockCheck.items.push({ itemName: item.itemName, available: true, availableQuantity: null, requiredQuantity: item.quantity, custom: true });
        continue;
      }
      const required = stockNeeded(item, inventoryItem);
      const isAvailable = inventoryItem.quantity >= required;
      if (!isAvailable) {
        stockCheck.available = false;
        stockCheck.errors.push(`Insufficient stock for "${item.itemName}". Available: ${inventoryItem.quantity}, Required: ${required}`);
      }
      stockCheck.items.push({
        itemName: item.itemName,
        available: isAvailable,
        availableQuantity: inventoryItem.quantity,
        requiredQuantity: required,
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
InventoryService.stockNeeded = stockNeeded;
InventoryService.movementScope = movementScope;

module.exports = InventoryService;
