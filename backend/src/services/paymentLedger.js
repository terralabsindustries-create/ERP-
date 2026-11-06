const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const transactions = require('../utils/transactions');

/**
 * Customer payments and the invoice balances they settle, kept in step.
 *
 * A payment's `allocations` say which invoices it pays and how much of it goes
 * to each; whatever is not allocated is held on account (an advance) until it
 * is applied. A payment recorded before allocations existed has none and was
 * applied whole to its `invoiceId` — allocationsOf() reads both, so old
 * records need no migration.
 *
 * An invoice's paidAmount is the completed payments allocated to it plus
 * manualPaidAmount: money recorded straight on the invoice (before Carbon, or
 * by the old "Mark paid"), changed only through a balance correction. Older
 * invoices have no manualPaidAmount; for them it is whatever part of
 * paidAmount no payment accounts for.
 *
 * Every change to a payment goes through commitPaymentChange(), which writes
 * the payment and moves each affected invoice's paid amount together:
 * - with transactions (a replica set, MongoDB Atlas) in one transaction;
 * - on a standalone MongoDB step by step, undoing the steps already taken if
 *   a later one fails (see utils/transactions.js).
 * Invoice writes are guarded by the invoice's version, so concurrent payments
 * each see the latest balance and none can take an invoice past its total.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const HALF_PAISA = 0.005;
const UNPAYABLE = ['draft', 'cancelled'];
const ATTEMPTS = 5;

class LedgerError extends Error {
  constructor(message, statusCode = 400, code = undefined, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const idOf = (value) => (value && typeof value === 'object' && value._id ? value._id : value);
const keyOf = (value) => String(idOf(value));

/** A filter that only matches the document while it is still at the version that was read. */
const atVersion = (doc) => (doc.__v === undefined || doc.__v === null ? { __v: { $exists: false } } : { __v: doc.__v });

/** Invoice → amount of this payment applied to it, oldest records included. */
function allocationsOf(payment) {
  if (!payment) return [];
  const list = payment.allocations || [];
  if (list.length) {
    return list.map((a) => ({
      invoiceId: idOf(a.invoiceId),
      invoiceNumber: a.invoiceNumber,
      amount: round2(a.amount),
      allocatedAt: a.allocatedAt,
      allocatedBy: a.allocatedBy
    }));
  }
  if (payment.invoiceId) {
    const invoice = payment.invoiceId;
    return [{ invoiceId: idOf(invoice), invoiceNumber: payment.invoiceNumber || invoice.invoiceNumber, amount: round2(payment.amount) }];
  }
  return [];
}

const allocatedTotal = (allocations) => round2(allocations.reduce((sum, a) => sum + a.amount, 0));

/** The part of a received payment not yet applied to any invoice. */
const unallocatedOf = (payment) =>
  payment && payment.status === 'completed' ? Math.max(0, round2(payment.amount - allocatedTotal(allocationsOf(payment)))) : 0;

/** What a payment adds to each invoice's paid amount: its allocations, while it is received. */
function effectOf(payment) {
  const effect = new Map();
  if (!payment || payment.status !== 'completed') return effect;
  for (const a of allocationsOf(payment)) effect.set(keyOf(a.invoiceId), round2((effect.get(keyOf(a.invoiceId)) || 0) + a.amount));
  return effect;
}

/** How each invoice's paid amount moves when a payment goes from `before` to `after` (null = absent). */
function invoiceDeltas(before, after) {
  const was = effectOf(before);
  const will = effectOf(after);
  return [...new Set([...was.keys(), ...will.keys()])]
    .sort()
    .map((invoiceId) => ({ invoiceId, delta: round2((will.get(invoiceId) || 0) - (was.get(invoiceId) || 0)) }))
    .filter(({ delta }) => Math.abs(delta) >= HALF_PAISA);
}

/** Payment status and invoice status that follow from a paid amount. */
function paymentState(invoice, paidAmount) {
  const total = round2(invoice.totalAmount);
  const paymentStatus = paidAmount >= total ? 'paid' : paidAmount > 0 ? 'partial' : 'pending';
  const fixed = ['draft', 'cancelled', 'refunded'].includes(invoice.status);
  const status = fixed ? invoice.status : paymentStatus === 'paid' ? 'paid' : invoice.status === 'paid' ? 'sent' : invoice.status;
  return { paidAmount, balanceAmount: round2(total - paidAmount), paymentStatus, status };
}

/**
 * Moves an invoice's paid amount by `delta`. An increase needs an issued
 * invoice with that much balance left; a decrease never takes it below 0.
 * The write only lands on the version of the invoice that was read.
 */
async function movePaid(invoiceId, delta, { session = null } = {}) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      // Taking money off an invoice that no longer exists (deleted before
      // payments guarded it) has nothing to move.
      if (delta < 0) return null;
      throw new LedgerError('That invoice is no longer available for payment', 400, 'INVOICE_UNAVAILABLE');
    }
    if (delta > 0 && UNPAYABLE.includes(invoice.status)) {
      throw new LedgerError(`${invoice.invoiceNumber} is ${invoice.status}; payments can only be applied to issued invoices`, 400, 'INVOICE_UNAVAILABLE');
    }
    const total = round2(invoice.totalAmount);
    const current = round2(invoice.paidAmount || 0);
    const next = round2(current + delta);
    if (delta > 0 && next > total + HALF_PAISA) {
      const balance = round2(total - current);
      throw new LedgerError(
        `₹${round2(delta).toLocaleString('en-IN')} is more than the ₹${balance.toLocaleString('en-IN')} still due on ${invoice.invoiceNumber}.`,
        400,
        'AMOUNT_EXCEEDS_BALANCE',
        { invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber, balanceAmount: balance }
      );
    }
    if (next < -HALF_PAISA) {
      console.warn(`Invoice ${invoice.invoiceNumber}: reversing ₹${-delta} would take paid below 0 (was ₹${current}); stopping at 0.`);
    }
    const updated = await Invoice.findOneAndUpdate(
      { _id: invoice._id, totalAmount: invoice.totalAmount, ...atVersion(invoice) },
      { $set: paymentState(invoice, Math.min(Math.max(next, 0), Math.max(total, 0))), $inc: { __v: 1 } },
      { new: true, session }
    );
    if (updated) return updated;
  }
  throw new LedgerError('The invoice balance changed while saving. Please try again.', 409, 'INVOICE_CHANGED');
}

/**
 * Runs `work` in a transaction where the database has them; otherwise runs it
 * directly and, if it fails, calls the undo steps it registered (newest
 * first). `work` receives { session, onUndo }.
 */
async function inTransaction(work) {
  if (await transactions.supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      // withTransaction re-runs `work` on a transient error (a write conflict
      // with another payment), so it must start from scratch every time.
      await session.withTransaction(async () => {
        result = await work({ session, onUndo: () => {} });
      });
      return result;
    } catch (error) {
      if (!transactions.isTransactionUnsupported(error)) throw error;
      // The server said it had transactions but refused one; nothing was written.
      transactions.markTransactionsUnsupported();
    } finally {
      await session.endSession();
    }
  }

  const undo = [];
  try {
    return await work({ session: null, onUndo: (step) => undo.push(step) });
  } catch (error) {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (undoError) {
        console.error('PAYMENT NOT FULLY UNDONE — check the invoice balances it touched:', undoError.message);
      }
    }
    throw error;
  }
}

/**
 * Writes one change to a payment and moves the paid amount of every invoice
 * it touches, together.
 *
 * Increases are applied first (they are what can be refused: a full invoice,
 * a cancelled one), then the payment itself, then decreases (which cannot be
 * refused) — so without transactions a refusal leaves nothing to undo but the
 * steps before it.
 *
 * @param before     the payment as stored, or null when creating one
 * @param after      the payment as it will be stored, or null when deleting it
 * @param write      (session) => performs the payment write, returns its result
 * @param undoWrite  (result) => reverses that write (used without transactions)
 */
async function commitPaymentChange({ before, after, write, undoWrite }) {
  const deltas = invoiceDeltas(before, after);
  return inTransaction(async ({ session, onUndo }) => {
    for (const { invoiceId, delta } of deltas.filter((d) => d.delta > 0)) {
      await movePaid(invoiceId, delta, { session });
      onUndo(() => movePaid(invoiceId, -delta));
    }
    const result = await write(session);
    onUndo(() => undoWrite(result));
    for (const { invoiceId, delta } of deltas.filter((d) => d.delta < 0)) {
      await movePaid(invoiceId, delta, { session });
      onUndo(() => movePaid(invoiceId, -delta));
    }
    return result;
  });
}

/** The stored fields for a set of allocations; invoiceId/invoiceNumber mirror a single one for older readers. */
function allocationFields(allocations) {
  const clean = allocations.map((a) => ({
    invoiceId: idOf(a.invoiceId),
    invoiceNumber: a.invoiceNumber,
    amount: round2(a.amount),
    allocatedAt: a.allocatedAt || new Date(),
    ...(a.allocatedBy ? { allocatedBy: a.allocatedBy } : {})
  }));
  const single = clean.length === 1 ? clean[0] : null;
  return {
    set: { allocations: clean, ...(single ? { invoiceId: single.invoiceId, invoiceNumber: single.invoiceNumber } : {}) },
    unset: single ? {} : { invoiceId: 1, invoiceNumber: 1 }
  };
}

/** Creates a payment. `data` carries its allocations (already checked by resolveAllocations). */
function createPayment(data) {
  const { set, unset } = allocationFields(data.allocations || []);
  const doc = { ...data, ...set };
  for (const field of Object.keys(unset)) delete doc[field];
  return commitPaymentChange({
    before: null,
    after: doc,
    write: async (session) => {
      const [payment] = await Payment.create([doc], session ? { session } : {});
      return payment;
    },
    undoWrite: (payment) => Payment.deleteOne({ _id: payment._id })
  });
}

/** Changes a stored payment to `changes` (plain fields, plus `allocations` when they change). */
function updatePayment(payment, changes) {
  const allocations = changes.allocations || allocationsOf(payment);
  const { set, unset } = allocationFields(allocations);
  const fields = { ...changes, ...set };
  const after = { ...payment.toObject(), ...fields };
  for (const field of Object.keys(unset)) delete after[field];
  const stored = payment.toObject({ depopulate: true });
  return commitPaymentChange({
    before: payment,
    after,
    write: async (session) => {
      const update = { $set: fields, $inc: { __v: 1 } };
      if (Object.keys(unset).length) update.$unset = unset;
      const updated = await Payment.findOneAndUpdate({ _id: payment._id, ...atVersion(payment) }, update, { new: true, runValidators: true, session });
      if (!updated) throw new LedgerError('This payment was changed by someone else. Reload it and try again.', 409, 'PAYMENT_CHANGED');
      return updated;
    },
    undoWrite: (updated) => Payment.replaceOne({ _id: payment._id, __v: updated.__v }, stored)
  });
}

/** Deletes a payment and takes it back off every invoice it paid. */
function deletePayment(payment) {
  const stored = payment.toObject({ depopulate: true });
  return commitPaymentChange({
    before: payment,
    after: null,
    write: async (session) => {
      const removed = await Payment.findOneAndDelete({ _id: payment._id, ...atVersion(payment) }, { session });
      if (!removed) throw new LedgerError('This payment was changed by someone else. Reload it and try again.', 409, 'PAYMENT_CHANGED');
      return removed;
    },
    undoWrite: () => Payment.collection.insertOne(stored)
  });
}

/**
 * Checks a requested set of allocations ([{ invoiceId, amount }]) for a
 * customer's payment and returns them ready to store. Only invoices whose
 * allocation is new or larger are looked up: they must be the same
 * customer's, visible to this login (`invoiceScope`) and issued. Allocations
 * kept as they were stay as stored.
 */
async function resolveAllocations(requested, { customerId, invoiceScope, existing = [], userId }) {
  if (!Array.isArray(requested)) throw new LedgerError('allocations must be a list of { invoiceId, amount }');
  const seen = new Set();
  const wanted = requested.map((entry, i) => {
    const invoiceId = entry && idOf(entry.invoiceId);
    const amount = round2(entry && entry.amount);
    if (!invoiceId || !mongoose.isValidObjectId(String(invoiceId))) throw new LedgerError(`Allocation ${i + 1}: choose a valid invoice`);
    if (!(amount > 0)) throw new LedgerError(`Allocation ${i + 1}: the amount must be more than 0`);
    if (seen.has(String(invoiceId))) throw new LedgerError('Each invoice can appear only once in a payment\'s allocations', 400, 'DUPLICATE_ALLOCATION');
    seen.add(String(invoiceId));
    return { invoiceId: String(invoiceId), amount };
  });

  const before = new Map(existing.map((a) => [keyOf(a.invoiceId), a]));
  const grown = wanted.filter((w) => !before.has(w.invoiceId) || w.amount > before.get(w.invoiceId).amount + HALF_PAISA);
  const invoices = grown.length
    ? await Invoice.find({ _id: { $in: grown.map((w) => w.invoiceId) }, ...invoiceScope }).select('invoiceNumber customerId status')
    : [];
  const byId = new Map(invoices.map((inv) => [String(inv._id), inv]));
  for (const w of grown) {
    const invoice = byId.get(w.invoiceId);
    if (!invoice) throw new LedgerError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    if (String(invoice.customerId) !== String(customerId)) throw new LedgerError(`${invoice.invoiceNumber} belongs to a different customer`, 400, 'WRONG_CUSTOMER');
    if (UNPAYABLE.includes(invoice.status)) throw new LedgerError(`${invoice.invoiceNumber} is ${invoice.status}; payments can only be applied to issued invoices`, 400, 'INVOICE_UNAVAILABLE');
  }

  return wanted.map((w) => {
    const kept = before.get(w.invoiceId);
    const invoice = byId.get(w.invoiceId);
    if (kept && !invoice) return { ...kept, amount: w.amount };
    return {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      amount: w.amount,
      allocatedAt: kept?.allocatedAt && w.amount === kept.amount ? kept.allocatedAt : new Date(),
      allocatedBy: userId
    };
  });
}

/** Completed payments allocated to an invoice, with the amount each applied to it. */
async function paymentsForInvoice(invoiceId, { session = null } = {}) {
  const id = new mongoose.Types.ObjectId(String(invoiceId));
  const payments = await Payment.find({ $or: [{ 'allocations.invoiceId': id }, { invoiceId: id }] })
    .select('paymentId paymentDate amount paymentMethod referenceNumber status allocations invoiceId invoiceNumber createdAt')
    .sort({ paymentDate: -1, createdAt: -1 })
    .session(session);
  return payments
    .map((payment) => {
      const applied = allocationsOf(payment).filter((a) => keyOf(a.invoiceId) === String(id));
      return { payment, appliedAmount: allocatedTotal(applied) };
    })
    .filter(({ appliedAmount }) => appliedAmount > 0);
}

/** How much of an invoice's paid amount came from completed payments. */
async function recordedPaidFor(invoiceId, { session = null } = {}) {
  const rows = await paymentsForInvoice(invoiceId, { session });
  return round2(rows.filter(({ payment }) => payment.status === 'completed').reduce((sum, r) => sum + r.appliedAmount, 0));
}

/** The money recorded straight on an invoice, outside payments. */
const manualPaidOf = (invoice, recorded) =>
  invoice.manualPaidAmount !== undefined && invoice.manualPaidAmount !== null
    ? round2(invoice.manualPaidAmount)
    : Math.max(0, round2((invoice.paidAmount || 0) - recorded));

/**
 * Balance correction: sets the amount recorded straight on an invoice (money
 * received before Carbon, or never entered as a payment). Payments recorded
 * against the invoice are untouched. Returns the invoice before and after.
 */
async function correctManualPaid(invoiceFilter, manualPaidAmount) {
  const manual = round2(manualPaidAmount);
  return inTransaction(async ({ session }) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const invoice = await Invoice.findOne(invoiceFilter).session(session);
      if (!invoice) throw new LedgerError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
      const hasManual = invoice.manualPaidAmount !== undefined && invoice.manualPaidAmount !== null;
      // With a stored manual amount the payments' share is paid − manual, read
      // from the same version of the invoice the write is guarded by.
      const recorded = hasManual ? round2((invoice.paidAmount || 0) - invoice.manualPaidAmount) : await recordedPaidFor(invoice._id, { session });
      const previousManual = hasManual ? round2(invoice.manualPaidAmount) : manualPaidOf(invoice, recorded);
      const paid = round2(recorded + manual);
      if (paid > round2(invoice.totalAmount) + HALF_PAISA) {
        throw new LedgerError(
          `Payments already cover ₹${recorded.toLocaleString('en-IN')} of the ₹${round2(invoice.totalAmount).toLocaleString('en-IN')} total, so at most ₹${Math.max(0, round2(invoice.totalAmount - recorded)).toLocaleString('en-IN')} can be recorded outside them.`,
          400,
          'AMOUNT_EXCEEDS_TOTAL'
        );
      }
      const updated = await Invoice.findOneAndUpdate(
        { _id: invoice._id, totalAmount: invoice.totalAmount, ...atVersion(invoice) },
        { $set: { manualPaidAmount: manual, ...paymentState(invoice, paid) }, $inc: { __v: 1 } },
        { new: true, session }
      );
      if (updated) return { before: invoice, after: updated, recorded, previousManual };
    }
    throw new LedgerError('The invoice balance changed while saving. Please try again.', 409, 'INVOICE_CHANGED');
  });
}

module.exports = {
  LedgerError,
  round2,
  allocationsOf,
  allocatedTotal,
  unallocatedOf,
  invoiceDeltas,
  movePaid,
  commitPaymentChange,
  createPayment,
  updatePayment,
  deletePayment,
  resolveAllocations,
  paymentsForInvoice,
  recordedPaidFor,
  manualPaidOf,
  correctManualPaid
};
