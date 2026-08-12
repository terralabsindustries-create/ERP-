/**
 * Keeps the Employee (HR) directory in step with login accounts.
 *
 * Every User created through User Management is a member of the team, so they
 * should appear on the Employees page without being re-entered by hand. The
 * Employee document owns all HR data (salary, department, bank details); this
 * module only ever writes the identity fields that the login account is the
 * source of truth for — name, email, phone, and active/inactive status.
 */

const Employee = require('../models/Employee');

const ROLE_DESIGNATIONS = {
  admin: 'Admin',
  manager: 'Manager',
  operator: 'Operator',
  designer: 'Designer',
  accountant: 'Accountant',
  staff: 'Staff'
};

// Tenant scope for a user: dataScope when present, else the owning admin's id.
const scopeFor = (user, actor) => {
  const dataScope = user.dataScope || (actor && actor.dataScope);
  return dataScope ? { dataScope } : { userId: (actor && actor._id) || user._id };
};

/**
 * Create or update the Employee row that mirrors a login account.
 *
 * Resolution order, so we never create a duplicate for someone HR already added:
 *   1. an Employee already linked to this user
 *   2. an unlinked Employee with the same email in the same tenant -> adopt it
 *   3. otherwise create a new one
 *
 * @param {Object} user  the User document that was created or updated
 * @param {Object} actor the admin/manager performing the action
 * @param {Object} [seed] values used only when creating a new row, e.g.
 *                        { department } captured on the invitation form
 * @returns {Promise<Object|null>} the synced Employee, or null if skipped
 */
async function syncEmployeeForUser(user, actor, seed = {}) {
  if (!user) return null;

  // Someone who was invited but hasn't accepted yet is not on the team, so they
  // must not appear in the HR directory or in headcount. The record is created
  // when they accept their invitation and the account becomes active.
  if (user.status === 'invited') return null;

  const scope = scopeFor(user, actor);
  const status = user.isActive === false ? 'inactive' : 'active';

  let employee = await Employee.findOne({ ...scope, linkedUserId: user._id });

  if (!employee && user.email) {
    employee = await Employee.findOne({
      ...scope,
      email: String(user.email).toLowerCase(),
      linkedUserId: { $in: [null, undefined] }
    });
  }

  if (employee) {
    // Existing row: refresh only the fields the login owns. Salary, department
    // and every other HR field stay exactly as HR entered them.
    employee.linkedUserId = user._id;
    employee.name = user.fullName || employee.name;
    employee.email = user.email || employee.email;
    if (user.phone) employee.phone = user.phone;
    employee.status = status;
    await employee.save();
    return employee;
  }

  return Employee.create({
    ...scope,
    name: user.fullName || user.email,
    email: user.email,
    phone: user.phone,
    // Seed the designation from the role so the row isn't blank; HR is free to
    // change it afterwards and we won't overwrite it again. Same for the
    // department the admin typed on the invitation form.
    designation: ROLE_DESIGNATIONS[user.role] || user.role,
    ...(seed.department ? { department: seed.department } : {}),
    status,
    linkedUserId: user._id,
    createdBy: (actor && actor._id) || user._id,
    userId: (actor && actor._id) || user._id,
    ...(scope.dataScope ? { dataScope: scope.dataScope } : {})
  });
}

/**
 * Mirror a login's active/inactive state onto its Employee row.
 */
async function syncEmployeeStatusForUser(user) {
  if (!user) return null;
  return Employee.findOneAndUpdate(
    { linkedUserId: user._id },
    { status: user.isActive === false ? 'inactive' : 'active' },
    { new: true }
  );
}

/**
 * Called when a login is deleted. The Employee row is kept — payroll and
 * attendance history reference it — but it is unlinked and marked inactive so
 * it stops looking like an active team member with a login.
 */
async function unlinkEmployeeForUser(userId) {
  if (!userId) return null;
  return Employee.findOneAndUpdate(
    { linkedUserId: userId },
    { $set: { status: 'inactive' }, $unset: { linkedUserId: '' } },
    { new: true }
  );
}

module.exports = {
  syncEmployeeForUser,
  syncEmployeeStatusForUser,
  unlinkEmployeeForUser,
  ROLE_DESIGNATIONS
};
