const { orgScope } = require('./accessScope');
const { canViewAllStaffData } = require('./dataScopeHelper');

/*
  Which job tickets a login may see.

  A designer sees only the job tickets they created. The creator is the job's
  `userId` (with `createdBy`), set from the authenticated login when the job is
  created and never taken from a request, so it cannot be claimed.

  Every other login of the business — admin, manager, accountant, operator,
  staff — sees all of the business's job tickets, as before; so does a
  designer whose login has "Can view all staff data" (canViewAllData), the
  existing grant for seeing the whole team's records.

  Seeing a job is not permission to change it: editing, status changes,
  invoicing and deleting still need their own permissions on top of this.
*/
// Every login except the admin sees only the job tickets it created unless its
// "Can view all data" switch (User Management) is on.
const ownJobsOnly = (user) => user.role !== 'admin' && !canViewAllStaffData(user);

/** Filter for the job tickets a login may see (spread into a query or a $match). */
const jobScope = (user) => (ownJobsOnly(user) ? { ...orgScope(user), userId: user._id } : orgScope(user));

module.exports = { jobScope, ownJobsOnly };
