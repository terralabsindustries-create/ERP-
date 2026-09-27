/**
 * DataScope Helper Utility
 *
 * Provides utilities for handling data scoping to ensure data isolation
 * across users with the same dataScope (admin + their staff/managers)
 */

/**
 * Add dataScope filter to a query object
 * @param {Object} query - The existing query object
 * @param {string} dataScope - The dataScope from the authenticated user
 * @returns {Object} - The query with dataScope filter added
 */
function addDataScopeFilter(query, dataScope) {
  if (!dataScope) {
    throw new Error('DataScope is required for filtering');
  }

  return {
    ...query,
    dataScope
  };
}

/**
 * Create a dataScope query from scratch
 * @param {string} dataScope - The dataScope from the authenticated user
 * @returns {Object} - Query object with dataScope filter
 */
function createDataScopeQuery(dataScope) {
  if (!dataScope) {
    throw new Error('DataScope is required for filtering');
  }

  return { dataScope };
}

/**
 * Merge an existing query with dataScope filter
 * Ensures dataScope is always included in queries
 * @param {Object} baseQuery - The base query object
 * @param {string} dataScope - The dataScope from the authenticated user
 * @returns {Object} - Merged query with dataScope
 */
function mergeDataScopeQuery(baseQuery, dataScope) {
  if (!dataScope) {
    throw new Error('DataScope is required for filtering');
  }

  return {
    ...baseQuery,
    dataScope
  };
}

/**
 * Whether a login sees records created by every team member, or only its own.
 * The admin always does; a manager or accountant does when "Can view all staff
 * data" was ticked on their login.
 * @param {Object} user - The authenticated user
 * @returns {boolean}
 */
function canViewAllStaffData(user) {
  return user.role === 'admin' || user.canViewAllData === true;
}

/**
 * Query for the records a login may see on collections that store their
 * creator in `userId` (e.g. invoices). Staff see only what they created; the
 * admin and view-all logins see the whole dataScope.
 * @param {Object} user - The authenticated user
 * @returns {Object} - Query object to spread into a find/aggregate filter
 */
function staffScopeQuery(user) {
  if (!user.dataScope) {
    return { userId: user._id };
  }

  return canViewAllStaffData(user)
    ? { dataScope: user.dataScope }
    : { dataScope: user.dataScope, userId: user._id };
}

module.exports = {
  addDataScopeFilter,
  createDataScopeQuery,
  mergeDataScopeQuery,
  canViewAllStaffData,
  staffScopeQuery
};
