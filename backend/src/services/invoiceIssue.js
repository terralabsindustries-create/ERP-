const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const transactions = require('../utils/transactions');

/*
  Issuing a draft invoice: the one place an official invoice number is given
  to a draft.

  1. Claim the draft (status still 'draft', no other issue in progress) by
     stamping `issuingAt`. Two people pressing Issue at once, or an email send
     racing an Issue click, cannot both number it.
  2. Take the next official number from the business's series
     (Invoice.generateInvoiceNumber — an atomic counter, so concurrent issues
     of different drafts each get their own) and write it with status 'sent'
     and `issuedAt`, only while the claim is still ours.
  3. With transactions (replica set / Atlas) steps 2's number and write commit
     together, so a failure leaves no gap. Without them a crash between the two
     can skip one number; the skip is visible in the series and never reused.

  Legacy drafts created before this change already hold an official number;
  they keep it when issued (it is never renumbered).

  A claim left by a crashed request expires after STALE_CLAIM_MS.
*/
const STALE_CLAIM_MS = 60 * 1000;
const NUMBER_ATTEMPTS = 5;

class IssueError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

async function writeIssued(claimed, claimAt, { session } = {}) {
  const needsNumber = Invoice.isDraftNumber(claimed.invoiceNumber);
  const invoiceNumber = needsNumber
    ? await Invoice.generateInvoiceNumber(claimed.userId, claimed.dataScope, { session })
    : claimed.invoiceNumber;
  const issued = await Invoice.findOneAndUpdate(
    { _id: claimed._id, status: 'draft', issuingAt: claimAt },
    {
      $set: { status: 'sent', invoiceNumber, issuedAt: new Date(), ...(needsNumber ? { draftNumber: claimed.invoiceNumber } : {}) },
      $unset: { issuingAt: 1 }
    },
    { new: true, runValidators: true, ...(session ? { session } : {}) }
  );
  if (!issued) throw new IssueError(409, 'This invoice changed while it was being issued. Reload it and try again.', 'INVOICE_CHANGED');
  return issued;
}

/**
 * Issue one draft. `filter` must include `_id` and the caller's scope.
 * Resolves to the issued invoice; throws IssueError(404/409) otherwise.
 */
async function issueInvoice(filter) {
  const claimAt = new Date();
  const claimed = await Invoice.findOneAndUpdate(
    { ...filter, status: 'draft', $or: [{ issuingAt: null }, { issuingAt: { $lt: new Date(claimAt.getTime() - STALE_CLAIM_MS) } }] },
    { $set: { issuingAt: claimAt } },
    { new: true }
  );
  if (!claimed) {
    const existing = await Invoice.findOne(filter).select('status issuingAt');
    if (!existing) throw new IssueError(404, 'Invoice not found', 'NOT_FOUND');
    if (existing.status === 'draft') throw new IssueError(409, 'This invoice is already being issued.', 'ISSUE_IN_PROGRESS');
    throw new IssueError(409, 'Only a draft invoice can be issued.', 'NOT_DRAFT');
  }

  try {
    if (await transactions.supportsTransactions()) {
      for (let attempt = 1; ; attempt += 1) {
        const session = await mongoose.startSession();
        try {
          let issued;
          await session.withTransaction(async () => { issued = await writeIssued(claimed, claimAt, { session }); });
          return issued;
        } catch (error) {
          if (transactions.isTransactionUnsupported(error)) { transactions.markTransactionsUnsupported(); break; }
          if (Invoice.isNumberTaken(error) && attempt < NUMBER_ATTEMPTS) continue;
          throw error;
        } finally {
          await session.endSession();
        }
      }
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await writeIssued(claimed, claimAt);
      } catch (error) {
        if (Invoice.isNumberTaken(error) && attempt < NUMBER_ATTEMPTS) continue;
        throw error;
      }
    }
  } catch (error) {
    // Release the claim so the draft can be issued again.
    await Invoice.updateOne({ _id: claimed._id, status: 'draft', issuingAt: claimAt }, { $unset: { issuingAt: 1 } }).catch(() => {});
    throw error;
  }
}

module.exports = { issueInvoice, IssueError, STALE_CLAIM_MS };
