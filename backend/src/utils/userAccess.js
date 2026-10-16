/**
 * Rules for handing out access, shared by the users, roles and teams routes.
 *
 *  - The admin (business owner) holds everything and may grant anything.
 *  - Anyone else may only grant permissions they hold themselves, and may not
 *    manage a person who holds access they don't (so a manager cannot quietly
 *    edit the accountant who sees more than they do).
 *  - "Can view all staff data" can only be handed on by someone who has it, and
 *    only to managers and accountants; staff always see only their own records.
 */
const { ALL_PERMISSIONS, pruneOrphanedActions } = require('../config/permissions');
const { userCan } = require('../middleware/requirePermission');
const { canViewAllStaffData } = require('./dataScopeHelper');

const VIEW_ALL_ROLES = ['manager', 'accountant'];

/** Dashboard always on, unknown names dropped, actions without their module dropped. */
function normalisePermissions(permissions = []) {
  const known = (Array.isArray(permissions) ? permissions : []).filter((p) => ALL_PERMISSIONS.includes(p));
  return pruneOrphanedActions([...new Set(['Dashboard', ...known])]);
}

/** The permissions in `permissions` the actor does not hold (always empty for the admin). */
const grantsBeyondOwn = (actor, permissions = []) =>
  actor.role === 'admin' ? [] : permissions.filter((p) => p !== 'Dashboard' && !userCan(actor, p));

/** May the actor manage this login at all (not the admin, not someone who holds more)? */
function manageableBy(actor, target) {
  if (actor.role === 'admin') return { ok: true };
  if (target.role === 'admin') return { ok: false, message: 'Only the admin can change the admin account.' };
  if (target.canViewAllData === true && !canViewAllStaffData(actor)) {
    return { ok: false, message: `${target.fullName} can see all staff data and you can't, so only the admin can change their access.` };
  }
  const beyond = grantsBeyondOwn(actor, target.permissions || []);
  if (beyond.length) {
    return { ok: false, message: `${target.fullName} has access you don't hold (${beyond.slice(0, 3).join(', ')}${beyond.length > 3 ? '…' : ''}), so only the admin can change it.` };
  }
  return { ok: true };
}

/** The login fields a role sets. */
const accessFromRole = (role) => ({
  role: role.baseRole,
  permissions: normalisePermissions(role.permissions),
  canViewAllData: role.canViewAllData === true && VIEW_ALL_ROLES.includes(role.baseRole),
  accessRole: role._id,
  accessRoleName: role.name
});

/**
 * Whether the actor may give out this role or permission set. Returns an error
 * message, or null when it is allowed.
 */
function grantProblem(actor, { permissions = [], canViewAllData = false }) {
  const beyond = grantsBeyondOwn(actor, permissions);
  if (beyond.length) {
    return `You can only grant permissions you hold yourself (not: ${beyond.join(', ')}).`;
  }
  if (canViewAllData === true && !canViewAllStaffData(actor)) {
    return 'Only the admin, or someone who already sees all staff data, can allow a login to view all staff data.';
  }
  return null;
}

module.exports = { VIEW_ALL_ROLES, normalisePermissions, grantsBeyondOwn, manageableBy, accessFromRole, grantProblem };
