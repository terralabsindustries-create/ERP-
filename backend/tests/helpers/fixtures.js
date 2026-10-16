const crypto = require('crypto');
const User = require('../../src/models/User');
const { generateToken } = require('../../src/middleware/auth');
const { ALL_PERMISSIONS } = require('../../src/config/permissions');

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Create one business (dataScope) with an admin, a manager who can see all
 * staff data, and two staff members with the permissions given.
 */
async function createOrg(label, { staffPermissions = ['Dashboard'], managerPermissions } = {}) {
  const dataScope = `scope_test_${label}_${crypto.randomBytes(4).toString('hex')}`;
  const make = (role, extra = {}) =>
    User.create({
      email: `${role}-${label}-${uniq()}@example.test`,
      password: 'Passw0rd!',
      fullName: `${label.toUpperCase()} ${role}`,
      role,
      dataScope,
      companyName: `${label.toUpperCase()} Printers`,
      status: 'active',
      isActive: true,
      ...extra
    });

  const admin = await make('admin', { permissions: ALL_PERMISSIONS });
  const manager = await make('manager', {
    fullName: `${label.toUpperCase()} Manager`,
    permissions: managerPermissions || ['Dashboard', 'Jobs', 'Staff & Tasks', 'Customers', 'Invoicing', 'Payments', 'Reports'],
    canViewAllData: true
  });
  const staff1 = await make('staff', { fullName: `${label.toUpperCase()} Staff One`, permissions: staffPermissions });
  const staff2 = await make('staff', { fullName: `${label.toUpperCase()} Staff Two`, permissions: staffPermissions });

  return {
    dataScope,
    admin,
    manager,
    staff1,
    staff2,
    tokens: {
      admin: generateToken(admin._id),
      manager: generateToken(manager._id),
      staff1: generateToken(staff1._id),
      staff2: generateToken(staff2._id)
    }
  };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { createOrg, auth, uniq };
