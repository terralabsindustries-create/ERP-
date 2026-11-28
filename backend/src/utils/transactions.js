const mongoose = require('mongoose');

/**
 * Whether the connected MongoDB can run multi-document transactions.
 *
 * A replica set member or a sharded cluster's mongos can (MongoDB Atlas is
 * always one of these); a standalone server — the usual local install — cannot.
 * The server is asked once per client connection. MONGODB_TRANSACTIONS=off
 * turns transactions off, for a deployment where they must not be used.
 *
 * Code that writes several documents together checks this and, without
 * transactions, falls back to steps it can undo (see
 * services/invoiceCreation.js).
 */
const known = new WeakMap();

async function supportsTransactions(connection = mongoose.connection) {
  if (/^(off|false|0|no)$/i.test(process.env.MONGODB_TRANSACTIONS || '')) return false;
  const client = connection.getClient();
  if (known.has(client)) return known.get(client);

  let supported = false;
  try {
    const hello = await connection.db.admin().command({ hello: 1 });
    supported = Boolean((hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null);
  } catch {
    supported = false;
  }
  known.set(client, supported);
  return supported;
}

/** Remembers that this connection turned a transaction down after all. */
function markTransactionsUnsupported(connection = mongoose.connection) {
  known.set(connection.getClient(), false);
}

/**
 * True for the error a server without transactions gives when one is started
 * (IllegalOperation: "Transaction numbers are only allowed on a replica set
 * member or mongos"). Nothing has been written when it is raised.
 */
const isTransactionUnsupported = (error) =>
  error?.code === 20 || /Transaction numbers are only allowed|transactions are not supported/i.test(error?.message || '');

/*
  Durable safety net for the no-transaction path (see models/TransactionJournal.js).
  A journal entry is written before the work starts and removed when the work
  finishes or is completely undone. If the process dies in between it stays and
  the reconciliation report shows it as an interrupted operation. If an undo
  step fails the entry becomes `compensation_failed`, holding the original error
  and each failed step, and an alert line is logged (and posted to
  ALERT_WEBHOOK_URL when that is set). A failed undo is never reported as success.
*/
const journal = () => require('../models/TransactionJournal');
const auditCtx = () => require('./auditContext').currentContext();

async function openJournal(label) {
  try {
    const ctx = auditCtx();
    return await journal().create({ label, correlationId: ctx.correlationId, dataScope: ctx.dataScope, userId: ctx.userId });
  } catch (error) {
    // Without a journal the operation still runs, but it cannot be recovered after a crash.
    console.error(JSON.stringify({ evt: 'transaction_journal_unavailable', label, message: error.message }));
    return null;
  }
}

const closeJournal = (entry) => (entry ? journal().deleteOne({ _id: entry._id }).catch(() => {}) : null);

async function alertCompensationFailure(record) {
  console.error(JSON.stringify({ evt: 'compensation_failed', severity: 'critical', id: String(record._id), label: record.label, correlationId: record.correlationId, dataScope: record.dataScope, undoErrors: record.undoErrors, originalError: record.originalError }));
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url || typeof fetch !== 'function') return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `CRITICAL: ${record.label} failed and could not be fully undone (record ${record._id}). Review in the reconciliation report.` }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    console.error('Alert webhook failed:', error.message);
  }
}

/**
 * Runs undo steps newest first. Every step is attempted; failures are
 * collected. Returns the list of failures (empty when everything was undone).
 */
async function runUndo(steps) {
  const failures = [];
  const ordered = [...steps].reverse();
  for (let i = 0; i < ordered.length; i += 1) {
    try {
      await ordered[i]();
    } catch (error) {
      failures.push({ step: i + 1, message: String(error.message || error).slice(0, 500) });
    }
  }
  return failures;
}

/** Records a compensation failure durably and raises the alert. Returns the record (or null if it could not be stored). */
async function recordCompensationFailure({ entry, label, error, undoErrors, total }) {
  const ctx = auditCtx();
  const fields = { label, status: 'compensation_failed', originalError: String(error?.message || error).slice(0, 500), undoErrors, undoStepsTotal: total, failedAt: new Date() };
  let record = null;
  try {
    record = entry
      ? await journal().findOneAndUpdate({ _id: entry._id }, { $set: fields }, { new: true })
      : await journal().create({ ...fields, correlationId: ctx.correlationId, dataScope: ctx.dataScope, userId: ctx.userId });
  } catch (writeError) {
    console.error(JSON.stringify({ evt: 'compensation_record_unwritable', label, message: writeError.message }));
  }
  await alertCompensationFailure(record || { _id: 'unrecorded', label, undoErrors, originalError: fields.originalError, correlationId: ctx.correlationId, dataScope: ctx.dataScope });
  return record;
}

/**
 * Runs `work` as one unit. Where the database has transactions, `work` runs
 * inside one (and may be re-run on a transient write conflict, so it must
 * start from scratch each time). On a standalone MongoDB it runs directly and,
 * if it throws, the undo steps it registered run newest first before the
 * error is passed on. `work` receives { session, onUndo }; every write in it
 * passes `session`, and every write registers how to reverse it.
 *
 * Without transactions the run is journalled (see above). If any undo step
 * fails, the passed-on error carries `compensationFailed: true` and
 * `failureId`, the journal entry is kept as `compensation_failed`, and an
 * alert is raised: it is a record someone must correct.
 */
async function inTransaction(work, { label = 'Change' } = {}) {
  if (await module.exports.supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work({ session, onUndo: () => {} });
      });
      return result;
    } catch (error) {
      if (!isTransactionUnsupported(error)) throw error;
      // The server said it had transactions but refused one; nothing was written.
      markTransactionsUnsupported();
    } finally {
      await session.endSession();
    }
  }

  const entry = await openJournal(label);
  const undo = [];
  try {
    const result = await work({ session: null, onUndo: (step) => undo.push(step) });
    await closeJournal(entry);
    return result;
  } catch (error) {
    const undoErrors = await runUndo(undo);
    if (!undoErrors.length) {
      await closeJournal(entry);
      throw error;
    }
    const record = await recordCompensationFailure({ entry, label, error, undoErrors, total: undo.length });
    error.compensationFailed = true;
    error.failureId = record ? String(record._id) : undefined;
    throw error;
  }
}

/** For hand-written step-by-step code (invoice creation): same journal and failure record. */
const compensation = { openJournal, closeJournal, runUndo, recordCompensationFailure };

module.exports = { supportsTransactions, markTransactionsUnsupported, isTransactionUnsupported, inTransaction, compensation };
