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

/**
 * Runs `work` as one unit. Where the database has transactions, `work` runs
 * inside one (and may be re-run on a transient write conflict, so it must
 * start from scratch each time). On a standalone MongoDB it runs directly and,
 * if it throws, the undo steps it registered run newest first before the
 * error is passed on. `work` receives { session, onUndo }; every write in it
 * passes `session`, and every write registers how to reverse it.
 *
 * `label` names the operation in the log line written when an undo step
 * itself fails — that is a record someone must correct by hand.
 */
async function inTransaction(work, { label = 'Change' } = {}) {
  if (await supportsTransactions()) {
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

  const undo = [];
  try {
    return await work({ session: null, onUndo: (step) => undo.push(step) });
  } catch (error) {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (undoError) {
        console.error(`${label.toUpperCase()} NOT FULLY UNDONE — check the records it touched:`, undoError.message);
      }
    }
    throw error;
  }
}

module.exports = { supportsTransactions, markTransactionsUnsupported, isTransactionUnsupported, inTransaction };
