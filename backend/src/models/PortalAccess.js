const mongoose = require('mongoose');

/**
 * A customer portal link issued by staff. Only the SHA-256 hash of the link's
 * token is stored, so a database leak cannot be replayed into portal access.
 * Revoking or letting the link expire also ends every session opened with it.
 */
const portalAccessSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
    index: true
  },
  customerName: {
    type: String,
    trim: true
  },
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    select: false
  },
  expiresAt: {
    type: Date,
    required: true
  },
  revokedAt: Date,
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastUsedAt: Date,
  useCount: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdByName: String,
  // The business the customer belongs to.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true
  }
}, {
  timestamps: true
});

portalAccessSchema.virtual('state').get(function () {
  if (this.revokedAt) return 'revoked';
  if (this.expiresAt < new Date()) return 'expired';
  return 'active';
});

portalAccessSchema.set('toJSON', {
  virtuals: true,
  // Never send the token hash out, even on a freshly created document.
  transform: (doc, ret) => {
    delete ret.tokenHash;
    return ret;
  }
});

module.exports = mongoose.model('PortalAccess', portalAccessSchema);
