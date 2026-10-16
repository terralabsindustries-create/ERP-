/**
 * Server-side permission gate for a whole API module, mounted in app.js in
 * front of the module's router. It closes the gap where a route only checked
 * that the caller was logged in, so any login could read or change a module the
 * sidebar hid from them.
 *
 *   moduleGuard({
 *     read:   'Payments',                    // GET / HEAD
 *     write:  'Payments: Record Payment',    // POST / PUT / PATCH
 *     remove: 'Payments: Delete',            // DELETE (defaults to write)
 *     rules: [                               // checked first, in order
 *       { method: 'GET', path: /^\/mine$/, allow: AUTHENTICATED },
 *     ]
 *   })
 *
 * A requirement is a permission string, an array (any one of them is enough),
 * AUTHENTICATED (any logged-in user; the route itself narrows what they see),
 * or a function (user, req) => boolean. Permission strings follow
 * requirePermission's rules, including the legacy "module without actions"
 * grant, so existing logins keep what they could already do.
 */
const { userCan } = require('./requirePermission');

const AUTHENTICATED = Symbol('authenticated');

const allowed = (user, req, requirement) => {
  if (requirement === AUTHENTICATED) return true;
  if (typeof requirement === 'function') return requirement(user, req) === true;
  if (Array.isArray(requirement)) return requirement.some((p) => userCan(user, p));
  if (typeof requirement === 'string') return userCan(user, requirement);
  return false; // nothing configured: deny rather than guess
};

const describe = (requirement) =>
  Array.isArray(requirement) ? requirement.join(' or ') : typeof requirement === 'string' ? requirement : 'access';

function moduleGuard({ read, write, remove, rules = [] }) {
  return (req, res, next) => {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return next();

    const rule = rules.find(
      (r) => (!r.method || [].concat(r.method).includes(method)) && r.path.test(req.path)
    );

    let requirement;
    if (rule) requirement = rule.allow;
    else if (method === 'GET' || method === 'HEAD') requirement = read;
    else if (method === 'DELETE') requirement = remove ?? write;
    else requirement = write;

    if (req.user && allowed(req.user, req, requirement)) return next();

    return res.status(403).json({
      status: 'error',
      message: 'You do not have permission to do this.',
      code: 'PERMISSION_DENIED',
      required: describe(requirement)
    });
  };
}

module.exports = { moduleGuard, AUTHENTICATED };
