const AccessRole = require('../models/AccessRole');
const User = require('../models/User');
const { PRESET_VERSION, presetUpgrade } = require('../config/rolePresets');
const { normalisePermissions } = require('./userAccess');

/**
 * Bring starter roles made from an older version of the presets up to date,
 * once per role: the permissions a newer version adds are granted, the ones it
 * drops are taken away, and everyone holding the role gets the result (as
 * saving the role on the Roles screen does). Anything else the owner changed
 * on the role is left as it is. Safe to run on every start.
 */
async function upgradePresetRoles() {
  const roles = await AccessRole.find({
    preset: true,
    $or: [{ presetVersion: { $exists: false } }, { presetVersion: { $lt: PRESET_VERSION } }]
  });
  let upgraded = 0;
  for (const role of roles) {
    // A renamed starter Accountant role is still recognised by its account type.
    const name = role.baseRole === 'accountant' ? 'Accountant' : role.name;
    const { add, remove } = presetUpgrade(name, role.presetVersion || 1);
    const permissions = normalisePermissions([...role.permissions.filter((p) => !remove.includes(p)), ...add]);
    const changed = permissions.length !== role.permissions.length || permissions.some((p) => !role.permissions.includes(p));

    role.permissions = permissions;
    role.presetVersion = PRESET_VERSION;
    await role.save();
    if (!changed) continue;

    await User.updateMany(
      { accessRole: role._id, role: { $ne: 'admin' }, ...(role.dataScope ? { dataScope: role.dataScope } : {}) },
      { $set: { role: role.baseRole, permissions: role.permissions, canViewAllData: role.canViewAllData, accessRoleName: role.name } }
    );
    upgraded++;
  }
  return { checked: roles.length, upgraded };
}

module.exports = { upgradePresetRoles };
