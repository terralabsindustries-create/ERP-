/**
 * Closing a business: what happens when the owner (the admin login) deletes
 * their own account. The business goes with them, permanently — every login
 * in it, every record it owns and the files it uploaded. The owner's email is
 * then free to sign up again from scratch.
 *
 * Records belong to the business when they carry its dataScope, or (older
 * records and models without dataScope) when one of its logins created them.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Make sure every model is registered before we walk them.
const MODELS_DIR = path.join(__dirname, '..', 'models');
for (const file of fs.readdirSync(MODELS_DIR)) {
  if (file.endsWith('.js')) require(path.join(MODELS_DIR, file));
}

const User = require('../models/User');
const OTP = require('../models/OTP');
const NumberSequence = require('../models/NumberSequence');

// Fields that point a record at the login that made it or the business.
const MEMBER_FIELDS = ['userId', 'createdBy', 'businessId'];
// Handled separately below.
const SKIP = new Set(['User', 'OTP', 'NumberSequence']);

const UPLOADS_ROOT = path.resolve(process.cwd(), 'uploads');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The filter for a model's records that belong to the business, or null. */
function businessFilter(model, dataScope, memberIds) {
  const or = [];
  if (dataScope && model.schema.path('dataScope')) or.push({ dataScope });
  for (const field of MEMBER_FIELDS) {
    if (model.schema.path(field)) or.push({ [field]: { $in: memberIds } });
  }
  return or.length ? { $or: or } : null;
}

/** Remove uploaded files kept on this server's disk (never outside uploads/). */
async function removeLocalFiles(model, filter) {
  if (!model.schema.path('fileUrl')) return;
  const docs = await model.find(filter).select('fileUrl storageProvider').lean();
  for (const doc of docs) {
    if (!doc.fileUrl || (doc.storageProvider && doc.storageProvider !== 'local')) continue;
    const target = path.resolve(process.cwd(), String(doc.fileUrl).replace(/^\/+/, ''));
    if (!target.startsWith(UPLOADS_ROOT + path.sep)) continue;
    await fs.promises.unlink(target).catch(() => {});
  }
}

/**
 * Permanently delete the owner's business. Returns how many records went,
 * per model, for the log line.
 */
async function closeBusiness(owner) {
  const dataScope = owner.dataScope || null;
  const members = await User.find(dataScope ? { dataScope } : { _id: owner._id }).select('_id email').lean();
  const memberIds = members.map((m) => m._id);
  if (!memberIds.some((id) => String(id) === String(owner._id))) memberIds.push(owner._id);

  const removed = {};
  for (const name of mongoose.modelNames()) {
    if (SKIP.has(name)) continue;
    const model = mongoose.model(name);
    const filter = businessFilter(model, dataScope, memberIds);
    if (!filter) continue;
    await removeLocalFiles(model, filter);
    const { deletedCount } = await model.deleteMany(filter);
    if (deletedCount) removed[name] = deletedCount;
  }

  // Invoice / bill number counters keyed by the business or its logins.
  const prefixes = [dataScope, ...memberIds.map(String)].filter(Boolean).map(escapeRegex);
  await NumberSequence.deleteMany({ _id: { $regex: `^[^:]+:(${prefixes.join('|')}):` } });

  await OTP.deleteMany({ email: { $in: members.map((m) => m.email).filter(Boolean) } });
  const { deletedCount: logins } = await User.deleteMany({ _id: { $in: memberIds } });
  removed.User = logins;
  return removed;
}

module.exports = { closeBusiness, businessFilter };
