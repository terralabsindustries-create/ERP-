/**
 * Which records a login may touch, as Mongo filters.
 *
 * Three kinds of record live in this app:
 *   1. Business records that carry `dataScope` (jobs, customers, invoices…).
 *      Filter them with orgScope().
 *   2. Business records that only carry the creator's `userId` (deliveries,
 *      proofs, discounts…). Everyone in the business shares them, so filter by
 *      "created by anyone in my business" with orgUserFilter().
 *   3. Personal work records (tasks, schedules, time entries). Staff see their
 *      own; the admin and logins with "Can view all staff data" see everyone's.
 *      See ownOrOrgUserFilter() and isOrgViewer().
 */
const User = require('../models/User');
const { canViewAllStaffData } = require('./dataScopeHelper');

/** The admin, or a manager/accountant allowed to see all staff data. */
const isOrgViewer = (user) => canViewAllStaffData(user);

/** Ids of every login in the user's business (cached on the request's user). */
async function orgMemberIds(user) {
  if (user._orgMemberIds) return user._orgMemberIds;
  const ids = user.dataScope
    ? await User.find({ dataScope: user.dataScope }).distinct('_id')
    : [user._id];
  // req.user is a fresh document per request, so this never outlives it.
  Object.defineProperty(user, '_orgMemberIds', { value: ids, enumerable: false });
  return ids;
}

/** Records that store `dataScope` (falls back to the creator for old accounts). */
const orgScope = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/** Records that only store the creator's `userId`, shared across the business. */
async function orgUserFilter(user, field = 'userId') {
  return { [field]: { $in: await orgMemberIds(user) } };
}

/** Personal records: everyone's for org viewers, otherwise only the user's own. */
async function ownOrOrgUserFilter(user, field = 'userId') {
  return isOrgViewer(user) ? orgUserFilter(user, field) : { [field]: user._id };
}

/** True when `otherUserId` is a login in the same business as `user`. */
async function isSameOrgUser(user, otherUserId) {
  if (!otherUserId) return false;
  const ids = await orgMemberIds(user);
  return ids.some((id) => id.toString() === otherUserId.toString());
}

module.exports = { isOrgViewer, orgMemberIds, orgScope, orgUserFilter, ownOrOrgUserFilter, isSameOrgUser };
