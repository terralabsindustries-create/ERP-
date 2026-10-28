const AccountTransaction = require('../models/AccountTransaction');
const { orgMemberIds } = require('./accessScope');

// New entries belong to the business directly. Older entries had only the
// creator's userId; include those while that login still exists.
async function accountScope(user) {
  if (!user.dataScope) return { userId: user._id };
  return {
    $and: [{ $or: [
      { dataScope: user.dataScope },
      { dataScope: { $exists: false }, userId: { $in: await orgMemberIds(user) } }
    ] }]
  };
}

// Before a login is removed, tag its old account entries with the business so
// the owner and accountant keep the ledger history and balances.
async function preserveAccountHistory(user) {
  if (!user?.dataScope) return;
  await AccountTransaction.updateMany(
    { userId: user._id, dataScope: { $exists: false } },
    { $set: { dataScope: user.dataScope } }
  );
}

module.exports = { accountScope, preserveAccountHistory };
