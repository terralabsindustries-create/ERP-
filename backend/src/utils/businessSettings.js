const mongoose = require('mongoose');
const User = require('../models/User');
const Settings = require('../models/Settings');

/*
  Settings (company name, GSTIN, bank details, invoice numbering, WhatsApp and
  e-mail connections, reminder rules) belong to the business, not to whoever
  is signed in. They are stored on the business owner's login — the admin of
  the dataScope — so a manager or staff member who prints an invoice gets the
  same letterhead as the owner, and sends WhatsApp through the same number.
*/

/** The login whose Settings document holds the business settings. */
async function settingsOwnerId(userOrId) {
  if (!userOrId) return userOrId;
  let user = userOrId;
  if (!(user && user._id && user.role)) {
    if (!mongoose.isValidObjectId(userOrId)) return userOrId;
    user = await User.findById(userOrId).select('role dataScope createdBy').lean();
    if (!user) return userOrId;
  }
  if (user.role === 'admin') return user._id;
  if (user.dataScope) {
    const owner = await User.findOne({ dataScope: user.dataScope, role: 'admin' }).sort({ createdAt: 1 }).select('_id').lean();
    if (owner) return owner._id;
  }
  // Logins made before dataScope existed: the admin who created them.
  return user.createdBy || user._id;
}

/** The business's Settings document (created with defaults on first use). */
async function businessSettings(userOrId) {
  return Settings.getOrCreateSettings(await settingsOwnerId(userOrId));
}

module.exports = { settingsOwnerId, businessSettings };
