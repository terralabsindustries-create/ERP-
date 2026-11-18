const mongoose = require('mongoose');
const PaymentAccount = require('../models/PaymentAccount');
const { LedgerError } = require('../services/paymentLedger');

/** The payment accounts of a login's business. */
const paymentAccountScope = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/** Cash is received into a cash account; every other method into a bank or wallet account. */
const fitsMethod = (kind, method) => (method === 'cash' ? kind === 'cash' : kind !== 'cash');

/**
 * Checks the account a payment says it was received into, and returns it.
 *
 * - It must belong to the caller's business.
 * - A new choice must be active (an existing payment keeps an account that
 *   was deactivated since).
 * - Cash goes into a cash account; other methods into a bank or wallet.
 * - Once the business has any active account, a new payment must name one.
 *   A business with none set up records payments as before (by method).
 *
 * @returns the account (lean), or null when none applies.
 */
async function resolveReceivingAccount(user, { paymentAccountId, paymentMethod, current = null, required }) {
  if (!paymentAccountId) {
    if (required && (await PaymentAccount.exists({ ...paymentAccountScope(user), isActive: true }))) {
      throw new LedgerError('Choose the account the payment was received into', 400, 'PAYMENT_ACCOUNT_REQUIRED');
    }
    return null;
  }
  if (!mongoose.isValidObjectId(String(paymentAccountId))) throw new LedgerError('Choose a valid payment account', 400, 'PAYMENT_ACCOUNT_INVALID');
  const account = await PaymentAccount.findOne({ _id: paymentAccountId, ...paymentAccountScope(user) }).lean();
  if (!account) throw new LedgerError('Payment account not found', 404, 'PAYMENT_ACCOUNT_NOT_FOUND');
  if (!account.isActive && String(current || '') !== String(account._id)) {
    throw new LedgerError(`${account.nickname} is inactive. Choose another account or reactivate it.`, 400, 'PAYMENT_ACCOUNT_INACTIVE');
  }
  if (paymentMethod && !fitsMethod(account.kind, paymentMethod)) {
    throw new LedgerError(
      paymentMethod === 'cash'
        ? `A cash payment is received into a cash account, not ${account.nickname}.`
        : `${account.nickname} is a cash account; a ${paymentMethod.replace('_', ' ')} payment is received into a bank or wallet account.`,
      400,
      'PAYMENT_ACCOUNT_MISMATCH'
    );
  }
  return account;
}

module.exports = { paymentAccountScope, fitsMethod, resolveReceivingAccount };
