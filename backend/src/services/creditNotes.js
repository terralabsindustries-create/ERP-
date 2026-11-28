const mongoose = require('mongoose');
const CreditNote = require('../models/CreditNote');
const Invoice = require('../models/Invoice');
const NumberSequence = require('../models/NumberSequence');
const transactions = require('../utils/transactions');
const { round2, splitGstAll } = require('../utils/billing');
const { financialYearOf } = require('../utils/financialYear');

/*
  GST credit and debit notes against issued invoices.

  Limits (checked on create and again on issue, against ISSUED notes only):
  - a credit note line can take off at most what is left of the original line:
    its taxable value, plus issued debit notes on that line, less issued credit
    notes on it; the quantity at most the original quantity less quantities
    already credited;
  - the GST on a line is the original line's rate, split CGST/SGST or IGST
    exactly as the invoice was.

  Effects on issue:
  - credit: the note's total comes off what the customer still owes on the
    invoice, up to that outstanding amount (`appliedToInvoice`); any rest is the
    customer's credit (`unappliedAmount`), for a refund or later settlement;
  - debit: the note's total is added to what is owed (invoice.debitNoteTotal).
  Cancelling an issued note reverses exactly what it applied.

  All of this runs in a transaction where the database supports them; without
  one, the invoice is changed first and put back if the note cannot be saved.
*/

class NoteError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

const PREFIX = { credit: 'CN', debit: 'DN' };
const STALE_CLAIM_MS = 60 * 1000;
const ISSUED_INVOICE = (inv) => inv && !['draft', 'cancelled'].includes(inv.status);

const scopeOf = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/** The invoice's adjustable lines: each item, and its design charge when there is one. */
function invoiceLines(invoice) {
  const rateOf = (r) => (invoice.noGst ? 0 : Number(r) || 0);
  const lines = (invoice.items || []).map((item) => ({
    ref: String(item._id),
    itemName: item.itemName,
    description: item.description,
    hsnCode: item.hsnCode,
    sacCode: item.sacCode,
    unit: item.unit,
    quantity: Number(item.quantity) || 0,
    taxableValue: round2(item.taxableValue != null ? item.taxableValue : item.totalAmount),
    gstRate: rateOf(item.gstRate)
  }));
  if ((invoice.designCharge || 0) > 0) {
    lines.push({
      ref: 'design',
      itemName: 'Design charge',
      sacCode: invoice.designChargeSacCode,
      unit: '',
      quantity: 0,
      taxableValue: round2(invoice.designChargeTaxableValue != null ? invoice.designChargeTaxableValue : invoice.designCharge),
      gstRate: rateOf(invoice.designChargeGstRate)
    });
  }
  return lines;
}

/** What each invoice line still allows a credit note to take off, after issued notes. */
async function remainingByLine(invoice, { session, excludeNoteId } = {}) {
  const issued = await CreditNote.find({
    invoiceId: invoice._id,
    status: 'issued',
    ...(excludeNoteId ? { _id: { $ne: excludeNoteId } } : {})
  }).session(session || null).lean();
  const map = new Map(invoiceLines(invoice).map((l) => [l.ref, { ...l, creditable: l.taxableValue, creditableQty: l.quantity }]));
  for (const note of issued) {
    for (const line of note.items) {
      const entry = map.get(line.invoiceLineRef);
      if (!entry) continue;
      const sign = note.noteType === 'credit' ? -1 : 1;
      entry.creditable = round2(entry.creditable + sign * line.taxableValue);
      if (note.noteType === 'credit') entry.creditableQty = round2(entry.creditableQty - (line.quantity || 0));
    }
  }
  return map;
}

/**
 * Prices a note's lines from what the client asked for. `requested` is
 * [{ invoiceLineRef, quantity, taxableValue }]; with `full` a credit note
 * takes everything still creditable.
 */
async function priceLines(invoice, noteType, { requested = [], full = false }, opts = {}) {
  const remaining = await remainingByLine(invoice, opts);
  let wanted;
  if (full) {
    if (noteType !== 'credit') throw new NoteError(400, 'A full adjustment is only for credit notes.', 'FULL_ONLY_CREDIT');
    wanted = [...remaining.values()].filter((l) => l.creditable > 0.004).map((l) => ({ invoiceLineRef: l.ref, quantity: Math.max(0, l.creditableQty), taxableValue: l.creditable }));
  } else {
    if (!Array.isArray(requested) || requested.length === 0) throw new NoteError(400, 'Choose at least one line of the invoice to adjust.', 'NO_LINES');
    wanted = requested;
  }

  const seen = new Set();
  const priced = [];
  for (const raw of wanted) {
    const ref = String(raw.invoiceLineRef || '');
    const line = remaining.get(ref);
    if (!line) throw new NoteError(400, 'A line on the note is not on the original invoice.', 'UNKNOWN_LINE', { invoiceLineRef: ref });
    if (seen.has(ref)) throw new NoteError(400, `${line.itemName} appears twice on the note.`, 'DUPLICATE_LINE');
    seen.add(ref);
    const taxable = round2(Number(raw.taxableValue));
    const quantity = raw.quantity === undefined || raw.quantity === null || raw.quantity === '' ? 0 : Number(raw.quantity);
    if (!Number.isFinite(taxable) || taxable < 0) throw new NoteError(400, `Enter a valid amount for ${line.itemName}.`, 'INVALID_AMOUNT');
    if (!Number.isFinite(quantity) || quantity < 0) throw new NoteError(400, `Enter a valid quantity for ${line.itemName}.`, 'INVALID_QUANTITY');
    if (taxable === 0) continue;
    if (noteType === 'credit') {
      if (taxable > line.creditable + 0.004) {
        throw new NoteError(400, `At most ₹${Math.max(0, line.creditable).toLocaleString('en-IN')} of ${line.itemName} can still be credited.`, 'EXCEEDS_LINE', { invoiceLineRef: ref, creditable: Math.max(0, line.creditable) });
      }
      if (quantity > line.creditableQty + 0.0001) {
        throw new NoteError(400, `At most ${Math.max(0, line.creditableQty)} of ${line.itemName} can still be returned.`, 'EXCEEDS_QUANTITY', { invoiceLineRef: ref, creditableQty: Math.max(0, line.creditableQty) });
      }
    }
    priced.push({ line, taxable, quantity });
  }
  if (!priced.length) throw new NoteError(400, 'The note has no amount to adjust.', 'ZERO_NOTE');

  const gsts = priced.map((p) => round2((p.taxable * p.line.gstRate) / 100));
  const splits = splitGstAll(gsts, invoice.isInterState === true);
  const items = priced.map((p, i) => ({
    invoiceLineRef: p.line.ref,
    itemName: p.line.itemName,
    description: p.line.description,
    hsnCode: p.line.hsnCode,
    sacCode: p.line.sacCode,
    unit: p.line.unit,
    quantity: p.quantity,
    taxableValue: p.taxable,
    gstRate: p.line.gstRate,
    ...splits[i],
    gstAmount: gsts[i],
    total: round2(p.taxable + gsts[i])
  }));
  const sum = (f) => round2(items.reduce((t, l) => t + (l[f] || 0), 0));
  return {
    items,
    taxableAmount: sum('taxableValue'),
    totalCgstAmount: sum('cgstAmount'),
    totalSgstAmount: sum('sgstAmount'),
    totalIgstAmount: sum('igstAmount'),
    totalGstAmount: sum('gstAmount'),
    totalAmount: sum('total')
  };
}

async function loadInvoice(user, invoiceId, { session } = {}) {
  if (!mongoose.isValidObjectId(invoiceId)) throw new NoteError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  const invoice = await Invoice.findOne({ _id: invoiceId, ...scopeOf(user) }).session(session || null);
  if (!invoice) throw new NoteError(404, 'Invoice not found', 'INVOICE_NOT_FOUND');
  if (!ISSUED_INVOICE(invoice)) {
    throw new NoteError(409, invoice.status === 'draft'
      ? 'This invoice is still a draft: edit it directly. Credit and debit notes are for issued invoices.'
      : 'This invoice is cancelled; no note can be raised against it.', 'INVOICE_NOT_ISSUED');
  }
  return invoice;
}

const REASON_TEXT_REQUIRED = new Set(['other', 'correction']);

function validateHeader(body) {
  const noteType = body.noteType;
  if (!['credit', 'debit'].includes(noteType)) throw new NoteError(400, 'Choose a credit note or a debit note.', 'INVALID_TYPE');
  if (!CreditNote.REASONS.includes(body.reason)) throw new NoteError(400, 'Choose the reason for the note.', 'INVALID_REASON');
  const reasonText = typeof body.reasonText === 'string' ? body.reasonText.trim().slice(0, 500) : '';
  if (REASON_TEXT_REQUIRED.has(body.reason) && reasonText.length < 3) throw new NoteError(400, 'Describe the reason for the note.', 'REASON_TEXT_REQUIRED');
  let noteDate = body.noteDate ? new Date(body.noteDate) : new Date();
  if (Number.isNaN(noteDate.getTime())) throw new NoteError(400, 'The note date is not a valid date.', 'INVALID_DATE');
  return { noteType, reason: body.reason, reasonText, noteDate };
}

async function draftNumber(user, noteType) {
  const scopeKey = user.dataScope || String(user._id);
  const n = await NumberSequence.nextAfter(`${noteType}-note-draft:${scopeKey}`, 0);
  return `DRAFT-${PREFIX[noteType]}-${String(n).padStart(5, '0')}`;
}

/** Create a draft note. With an idempotency key already used, returns that note. */
async function createNote(user, body = {}) {
  // Duplicate submissions are stopped by the unique (business, idempotency key)
  // index, built when the server starts (autoIndex / the index migration).
  const key = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim() ? body.idempotencyKey.trim().slice(0, 100) : null;
  if (key) {
    const existing = await CreditNote.findOne({ ...scopeOf(user), idempotencyKey: key });
    if (existing) return { note: existing, duplicate: true };
  }
  const header = validateHeader(body);
  const invoice = await loadInvoice(user, body.invoiceId);
  if (header.noteDate < new Date(new Date(invoice.invoiceDate).setHours(0, 0, 0, 0))) {
    throw new NoteError(400, 'A note cannot be dated before the invoice it adjusts.', 'DATE_BEFORE_INVOICE');
  }
  const priced = await priceLines(invoice, header.noteType, { requested: body.items, full: body.full === true });
  const noteNumber = await draftNumber(user, header.noteType);
  try {
    const note = await CreditNote.create({
      ...header,
      noteNumber,
      status: 'draft',
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      customerGstNumber: invoice.customerGstNumber,
      customerAddress: invoice.customerAddress,
      isInterState: invoice.isInterState === true,
      notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : undefined,
      ...priced,
      idempotencyKey: key || undefined,
      createdBy: user._id,
      userId: user._id,
      dataScope: user.dataScope
    });
    return { note, duplicate: false };
  } catch (error) {
    if (error.code === 11000 && key) {
      const existing = await CreditNote.findOne({ ...scopeOf(user), idempotencyKey: key });
      if (existing) return { note: existing, duplicate: true };
    }
    throw error;
  }
}

async function findOwn(user, id, { session } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new NoteError(404, 'Note not found', 'NOT_FOUND');
  const note = await CreditNote.findOne({ _id: id, ...scopeOf(user) }).session(session || null);
  if (!note) throw new NoteError(404, 'Note not found', 'NOT_FOUND');
  return note;
}

/** Change a draft's reason, date, notes or lines. Issued notes are fixed. */
async function updateDraft(user, id, body = {}) {
  const note = await findOwn(user, id);
  if (note.status !== 'draft') throw new NoteError(409, `${note.noteNumber} has been issued and cannot be edited. Cancel it and raise a new note.`, 'NOTE_LOCKED');
  const header = validateHeader({ noteType: note.noteType, reason: body.reason ?? note.reason, reasonText: body.reasonText ?? note.reasonText, noteDate: body.noteDate ?? note.noteDate });
  const invoice = await loadInvoice(user, note.invoiceId);
  Object.assign(note, header);
  if (body.items !== undefined || body.full === true) {
    Object.assign(note, await priceLines(invoice, note.noteType, { requested: body.items, full: body.full === true }));
  }
  if (body.notes !== undefined) note.notes = String(body.notes || '').trim().slice(0, 2000);
  await note.save();
  return note;
}

async function deleteDraft(user, id) {
  const note = await findOwn(user, id);
  if (note.status !== 'draft') throw new NoteError(409, `${note.noteNumber} has been issued; cancel it instead (it keeps its number).`, 'NOTE_LOCKED');
  const { deletedCount } = await CreditNote.deleteOne({ _id: note._id, status: 'draft', issuingAt: null });
  if (!deletedCount) throw new NoteError(409, 'This note is being issued right now.', 'ISSUE_IN_PROGRESS');
  return note;
}

/** The next official number of the business's series for the note's financial year. */
async function officialNumber(note, { session } = {}) {
  const fy = financialYearOf(note.noteDate);
  const prefix = `${PREFIX[note.noteType]}-${fy.code}-`;
  const scope = note.dataScope ? { dataScope: note.dataScope } : { userId: note.userId };
  const [highest] = await CreditNote.aggregate([
    { $match: { ...scope, noteNumber: { $regex: `^${prefix}\\d+$` } } },
    { $group: { _id: null, max: { $max: { $toLong: { $substrCP: ['$noteNumber', prefix.length, 12] } } } } }
  ]).session(session || null);
  const n = await NumberSequence.nextAfter(`${note.noteType}-note:${note.dataScope || note.userId}:${fy.code}`, Number(highest?.max) || 0, { session });
  return { number: `${prefix}${String(n).padStart(4, '0')}`, financialYear: fy.label };
}

/** Change the invoice by what the note applies; guarded by the invoice version read. */
async function applyToInvoice(note, { session, direction = 1 } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const invoice = await Invoice.findById(note.invoiceId).session(session || null);
    if (!invoice || !ISSUED_INVOICE(invoice)) throw new NoteError(409, 'The invoice is no longer issued.', 'INVOICE_NOT_ISSUED');
    const next = { creditNoteApplied: invoice.creditNoteApplied || 0, debitNoteTotal: invoice.debitNoteTotal || 0 };
    let applied = 0;
    if (note.noteType === 'credit') {
      if (direction > 0) {
        const outstanding = Math.max(0, round2(Invoice.receivableOf(invoice) - (invoice.paidAmount || 0)));
        applied = Math.min(note.totalAmount, outstanding);
        next.creditNoteApplied = round2(next.creditNoteApplied + applied);
      } else {
        applied = note.appliedToInvoice || 0;
        next.creditNoteApplied = Math.max(0, round2(next.creditNoteApplied - applied));
      }
    } else {
      next.debitNoteTotal = direction > 0 ? round2(next.debitNoteTotal + note.totalAmount) : Math.max(0, round2(next.debitNoteTotal - note.totalAmount));
      if (direction < 0 && (invoice.paidAmount || 0) > Invoice.receivableOf({ ...invoice.toObject(), ...next }) + 0.005) {
        throw new NoteError(409, `Payments on ${invoice.invoiceNumber} already cover more than it would be worth without this debit note. Take the extra payment off the invoice first.`, 'PAID_EXCEEDS_TOTAL');
      }
    }
    const state = Invoice.paymentStateFor({ ...invoice.toObject(), ...next }, invoice.paidAmount || 0);
    const versionFilter = invoice.__v === undefined ? { __v: { $exists: false } } : { __v: invoice.__v };
    const updated = await Invoice.findOneAndUpdate(
      { _id: invoice._id, ...versionFilter },
      { $set: { ...next, ...state }, $inc: { __v: 1 } },
      { new: true, ...(session ? { session } : {}) }
    );
    if (updated) return { invoice: updated, before: invoice, applied };
  }
  throw new NoteError(409, 'The invoice changed while the note was being applied. Please try again.', 'INVOICE_CHANGED');
}

async function runAtomically(work) {
  if (await transactions.supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await work({ session, onUndo: () => {} }); });
      return result;
    } catch (error) {
      if (!transactions.isTransactionUnsupported(error)) throw error;
      transactions.markTransactionsUnsupported();
    } finally {
      await session.endSession();
    }
  }
  const undo = [];
  try {
    return await work({ session: null, onUndo: (fn) => undo.unshift(fn) });
  } catch (error) {
    for (const fn of undo) await fn().catch((e) => console.error('Credit note undo step failed:', e.message));
    throw error;
  }
}

/** Issue a draft: re-check limits, number it, apply it to the invoice. */
async function issueNote(user, id) {
  const claimAt = new Date();
  const note = await CreditNote.findOneAndUpdate(
    { _id: id, ...scopeOf(user), status: 'draft', $or: [{ issuingAt: null }, { issuingAt: { $lt: new Date(claimAt - STALE_CLAIM_MS) } }] },
    { $set: { issuingAt: claimAt } },
    { new: true }
  );
  if (!note) {
    const existing = await findOwn(user, id);
    throw new NoteError(409, existing.status === 'draft' ? 'This note is already being issued.' : 'Only a draft note can be issued.', existing.status === 'draft' ? 'ISSUE_IN_PROGRESS' : 'NOT_DRAFT');
  }
  try {
    return await runAtomically(async ({ session, onUndo }) => {
      const invoice = await loadInvoice(user, note.invoiceId, { session });
      // Limits again, against notes issued since the draft was made.
      const priced = await priceLines(invoice, note.noteType, { requested: note.items.map((l) => ({ invoiceLineRef: l.invoiceLineRef, quantity: l.quantity, taxableValue: l.taxableValue })) }, { session, excludeNoteId: note._id });
      if (Math.abs(priced.totalAmount - note.totalAmount) > 0.005) throw new NoteError(409, 'The note no longer matches the invoice. Reopen it and save again.', 'NOTE_STALE');

      const { invoice: after, before, applied } = await applyToInvoice(note, { session });
      onUndo(() => Invoice.updateOne({ _id: before._id }, { $set: { creditNoteApplied: before.creditNoteApplied || 0, debitNoteTotal: before.debitNoteTotal || 0, balanceAmount: before.balanceAmount, paymentStatus: before.paymentStatus, status: before.status }, $inc: { __v: 1 } }));

      for (let attempt = 1; ; attempt += 1) {
        const { number, financialYear } = await officialNumber(note, { session });
        try {
          const issued = await CreditNote.findOneAndUpdate(
            { _id: note._id, status: 'draft', issuingAt: claimAt },
            {
              $set: {
                status: 'issued', noteNumber: number, draftNumber: note.noteNumber, financialYear,
                issuedAt: new Date(), issuedBy: user._id,
                appliedToInvoice: note.noteType === 'credit' ? applied : 0,
                unappliedAmount: note.noteType === 'credit' ? round2(note.totalAmount - applied) : 0
              },
              $unset: { issuingAt: 1 }
            },
            { new: true, ...(session ? { session } : {}) }
          );
          if (!issued) throw new NoteError(409, 'This note changed while it was being issued.', 'NOTE_CHANGED');
          return { note: issued, invoice: after };
        } catch (error) {
          if (error.code === 11000 && /noteNumber/.test(error.message || '') && attempt < 5 && !session) continue;
          throw error;
        }
      }
    });
  } catch (error) {
    await CreditNote.updateOne({ _id: note._id, status: 'draft', issuingAt: claimAt }, { $unset: { issuingAt: 1 } }).catch(() => {});
    throw error;
  }
}

/** Cancel a note. An issued note's effect on the invoice is reversed; its number is kept. */
async function cancelNote(user, id, reason) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 3) throw new NoteError(400, 'Give a reason for cancelling the note.', 'REASON_REQUIRED');
  const note = await findOwn(user, id);
  if (note.status === 'cancelled') throw new NoteError(409, 'This note is already cancelled.', 'ALREADY_CANCELLED');
  if (note.status === 'draft') {
    const updated = await CreditNote.findOneAndUpdate({ _id: note._id, status: 'draft', issuingAt: null }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user._id, cancellationReason: why } }, { new: true });
    if (!updated) throw new NoteError(409, 'This note is being issued right now.', 'ISSUE_IN_PROGRESS');
    return { note: updated };
  }
  return runAtomically(async ({ session, onUndo }) => {
    const { invoice, before } = await applyToInvoice(note, { session, direction: -1 });
    onUndo(() => Invoice.updateOne({ _id: before._id }, { $set: { creditNoteApplied: before.creditNoteApplied || 0, debitNoteTotal: before.debitNoteTotal || 0, balanceAmount: before.balanceAmount, paymentStatus: before.paymentStatus, status: before.status }, $inc: { __v: 1 } }));
    const updated = await CreditNote.findOneAndUpdate(
      { _id: note._id, status: 'issued' },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: user._id, cancellationReason: why } },
      { new: true, ...(session ? { session } : {}) }
    );
    if (!updated) throw new NoteError(409, 'This note changed while it was being cancelled.', 'NOTE_CHANGED');
    return { note: updated, invoice };
  });
}

module.exports = { NoteError, createNote, updateDraft, deleteDraft, issueNote, cancelNote, remainingByLine, invoiceLines, priceLines, findOwn, scopeOf };
