const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryService = require('./InventoryService');
const transactions = require('../utils/transactions');

/**
 * Creates an invoice and takes its stock out together: both happen, or
 * neither does. An invoice is never left without its stock deducted, and
 * stock is never deducted for an invoice that does not exist.
 *
 * Three writes make an invoice: the stock (an atomic, guarded decrement per
 * stock line — see InventoryService.takeStockForInvoice), the invoice under
 * its next free number, and the "sale" stock movements that record it.
 *
 * - With transactions (a replica set or mongos — MongoDB Atlas), all three
 *   commit as one, and the invoice number is only used if they do.
 * - A standalone MongoDB has no transactions. The writes then run in that
 *   order, and a failure undoes the ones before it: the movements and the
 *   invoice are deleted and the stock put back. Stock is taken first, so a
 *   refusal for want of stock writes nothing and uses no invoice number.
 *
 * Throws InventoryService.InsufficientStockError when stock runs out, and
 * the duplicate-key error (Invoice.isNumberTaken) only if every retry for a
 * free invoice number lost to concurrent requests.
 *
 * @param {Object} data  the invoice's fields, without invoiceNumber
 * @param {Array} lines  its priced lines (what the stock is taken for)
 * @param {Object} user  req.user — whose business's stock, and who did it
 */
async function createInvoiceWithStock(data, lines, user) {
  if (await transactions.supportsTransactions()) {
    try {
      return await createInTransaction(data, lines, user);
    } catch (error) {
      if (!transactions.isTransactionUnsupported(error)) throw error;
      // The server said it had transactions but refused one. Nothing was
      // written; carry on without them from now on.
      transactions.markTransactionsUnsupported();
    }
  }
  return createStepByStep(data, lines, user);
}

const NUMBER_ATTEMPTS = 5;

async function createInTransaction(data, lines, user) {
  for (let attempt = 1; ; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let invoice;
      // withTransaction re-runs this on a transient error (two invoices
      // writing the same stock item or number counter at once), so every
      // run starts from scratch.
      await session.withTransaction(async () => {
        const taken = await InventoryService.takeStockForInvoice(lines, user, { session });
        invoice = await Invoice.createNumbered(data, { session });
        const movements = InventoryService.saleMovements(taken, invoice, user);
        if (movements.length) await InventoryMovement.insertMany(movements, { session });
      });
      return invoice;
    } catch (error) {
      // The number was taken by an invoice written outside a transaction;
      // a fresh transaction numbers past it.
      if (Invoice.isNumberTaken(error) && attempt < NUMBER_ATTEMPTS) continue;
      throw error;
    } finally {
      await session.endSession();
    }
  }
}

async function createStepByStep(data, lines, user) {
  // Puts back whatever it took if it fails part-way.
  const taken = await InventoryService.takeStockForInvoice(lines, user);
  let invoice = null;
  try {
    invoice = await Invoice.createNumbered(data, { attempts: NUMBER_ATTEMPTS });
    const movements = InventoryService.saleMovements(taken, invoice, user);
    if (movements.length) await InventoryMovement.insertMany(movements);
    return invoice;
  } catch (error) {
    await undo(invoice, taken, user);
    throw error;
  }
}

/** Removes a half-made invoice: its movements, the invoice, then the stock it took. */
async function undo(invoice, taken, user) {
  if (invoice) {
    await InventoryMovement.deleteMany({ referenceType: 'invoice', referenceId: invoice._id }).catch((error) =>
      console.error(`Could not remove the stock movements of unfinished invoice ${invoice.invoiceNumber}:`, error.message)
    );
    await Invoice.deleteOne({ _id: invoice._id }).catch((error) =>
      console.error(`INVOICE NOT REMOVED: unfinished invoice ${invoice.invoiceNumber} (${invoice._id}) — delete it by hand.`, error.message)
    );
  }
  await InventoryService.returnStock(taken, user);
}

module.exports = { createInvoiceWithStock };
