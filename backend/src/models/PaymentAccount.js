const mongoose = require('mongoose');

/*
  Where the business receives and keeps money: the cash drawer, a Paytm or
  other wallet/UPI collection account, or a bank account.

  An account holds no running balance. Its balance is worked out from the
  ledger (AccountTransaction entries linked by paymentAccountId): its opening
  balance entry, the payments received into it, money paid out of it,
  transfers and balance adjustments. So concurrent payments cannot corrupt
  it, and every figure can be traced to the entries behind it.

  `kind` decides which ledger column the money sits in on the Accounts page:
  cash → cash; bank and wallet → bank.
*/
const KINDS = ['cash', 'bank', 'wallet'];

const paymentAccountSchema = new mongoose.Schema({
  kind: { type: String, enum: KINDS, required: true },
  // What people see when choosing it: "Cash", "Paytm", "HDFC Current".
  nickname: { type: String, required: [true, 'Give the account a name'], trim: true, maxlength: 60 },
  // Unique per business, ignoring case and spacing (see nicknameKey below).
  nicknameKey: { type: String, required: true },

  // Bank accounts
  bankName: { type: String, trim: true, maxlength: 80 },
  accountHolderName: { type: String, trim: true, maxlength: 80 },
  // Stored in full for the owner's records; the API returns only the last
  // four digits unless an editor asks for the full number.
  accountNumber: { type: String, trim: true, maxlength: 34 },
  ifscCode: { type: String, trim: true, uppercase: true, maxlength: 11 },

  // Wallet / UPI collection accounts (Paytm, PhonePe, a UPI ID…)
  provider: { type: String, trim: true, maxlength: 40 },
  // The UPI ID, merchant ID or registered number the money arrives on.
  walletId: { type: String, trim: true, maxlength: 80 },

  // The balance on the opening date. Posted to the ledger as an opening
  // balance entry (openingEntryId), so every total includes it.
  openingBalance: { type: Number, default: 0 },
  openingDate: { type: Date, required: true },
  openingEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'AccountTransaction' },

  // Inactive accounts are not offered for new payments; their history stays.
  isActive: { type: Boolean, default: true },
  notes: { type: String, trim: true, maxlength: 500 },

  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  dataScope: { type: String, index: true }
}, { timestamps: true });

paymentAccountSchema.index(
  { dataScope: 1, nicknameKey: 1 },
  { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } }
);

paymentAccountSchema.statics.KINDS = KINDS;
paymentAccountSchema.statics.nicknameKey = (nickname) => String(nickname || '').trim().replace(/\s+/g, ' ').toLowerCase();
/** The Accounts page column the account's money sits in. */
paymentAccountSchema.statics.ledgerType = (kind) => (kind === 'cash' ? 'cash' : 'bank');
/** "••••4321" for an account number; nothing when there is none. */
paymentAccountSchema.statics.mask = (number) => {
  const digits = String(number || '').replace(/\s+/g, '');
  return digits ? `••••${digits.slice(-4)}` : '';
};

module.exports = mongoose.model('PaymentAccount', paymentAccountSchema);
