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

module.exports = { supportsTransactions, markTransactionsUnsupported, isTransactionUnsupported };
