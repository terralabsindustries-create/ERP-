const crypto = require('crypto');
const mongoose = require('mongoose');

const portalSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  customerName: {
    type: String,
    required: true
  },
  customerEmail: {
    type: String
  },
  customerPhone: {
    type: String
  },
  // The portal link this session was opened with; revoking it ends the session.
  accessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PortalAccess'
  },
  expiresAt: {
    type: Date
  },
  loginTime: {
    type: Date,
    default: Date.now
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  },
  ipAddress: {
    type: String,
    trim: true
  },
  userAgent: {
    type: String,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index for efficient querying
portalSessionSchema.index({ customerId: 1 });
portalSessionSchema.index({ userId: 1 });
portalSessionSchema.index({ isActive: 1 });

// Sessions are identified by a random token held by the customer's browser;
// only its SHA-256 hash is stored in `sessionId`.
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const SESSION_HOURS = 12;

/** Open a session for a customer from a validated portal link. Returns { session, token }. */
portalSessionSchema.statics.openSession = async function ({ access, customer, ipAddress, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const linkEnds = access.expiresAt.getTime();
  const session = await this.create({
    sessionId: hashToken(token),
    customerId: customer._id,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    accessId: access._id,
    expiresAt: new Date(Math.min(Date.now() + SESSION_HOURS * 3600 * 1000, linkEnds)),
    ipAddress,
    userAgent,
    userId: access.userId
  });
  return { session, token };
};

/**
 * The active session for a token, or null. A session is only valid while it is
 * active, unexpired, and its portal link has not been revoked or expired.
 * Sessions from the old phone-number login have no link and are refused.
 */
portalSessionSchema.statics.validateSession = async function (token) {
  if (!token) return null;
  const session = await this.findOne({ sessionId: hashToken(token), isActive: true });
  if (!session || !session.accessId || !session.expiresAt || session.expiresAt < new Date()) return null;

  const PortalAccess = mongoose.model('PortalAccess');
  const access = await PortalAccess.findById(session.accessId);
  if (!access || access.revokedAt || access.expiresAt < new Date()) return null;

  session.lastActivity = new Date();
  await session.save();
  return session;
};

portalSessionSchema.statics.hashToken = hashToken;

module.exports = mongoose.model('PortalSession', portalSessionSchema);
