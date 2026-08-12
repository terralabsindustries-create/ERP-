/**
 * Route-level permission enforcement.
 *
 * Usage:  router.post('/', protect, requirePermission('Customers: Create & Edit'), handler)
 *
 * Rules, in order:
 *   1. Admins bypass everything (this is how the app has always worked).
 *   2. The parent MODULE must be granted, else 403.
 *   3. If the user has at least one action stored for that module, the specific
 *      action must be granted too.
 *   4. If the user has the module but NO actions for it, every action is
 *      allowed. These are logins created before granular actions existed —
 *      enforcing strictly would silently strip abilities they already had.
 *      Re-saving such a user through Create Login gives them explicit actions
 *      and moves them onto rule 3.
 */

const moduleOf = (permission) => {
  const i = permission.indexOf(': ');
  return i === -1 ? permission : permission.slice(0, i);
};

const userCan = (user, permission) => {
  if (!user) return false;
  if (user.role === 'admin') return true;

  const granted = user.permissions || [];
  const module = moduleOf(permission);

  if (!granted.includes(module)) return false;
  if (module === permission) return true;

  const hasAnyActionForModule = granted.some(p => p.startsWith(`${module}: `));
  if (!hasAnyActionForModule) return true; // legacy grant — see rule 4

  return granted.includes(permission);
};

const requirePermission = (permission) => (req, res, next) => {
  if (userCan(req.user, permission)) return next();

  return res.status(403).json({
    status: 'error',
    message: `You do not have permission to ${permission.includes(': ') ? permission.slice(permission.indexOf(': ') + 2).toLowerCase() : 'access'} in ${moduleOf(permission)}.`,
    code: 'PERMISSION_DENIED',
    required: permission
  });
};

module.exports = { requirePermission, userCan, moduleOf };
