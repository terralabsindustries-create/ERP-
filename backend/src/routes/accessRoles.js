const express = require('express');
const mongoose = require('mongoose');
const { body, param, validationResult } = require('express-validator');
const AccessRole = require('../models/AccessRole');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { ROLE_PRESETS } = require('../config/rolePresets');
const { orgScope } = require('../utils/accessScope');
const { VIEW_ALL_ROLES, normalisePermissions, grantsBeyondOwn, grantProblem } = require('../utils/userAccess');

/*
  Roles: named permission sets for one business ("Designer", "Accountant"…).
  Reading needs User Management; changing needs User Management: Edit
  Permissions (both checked in app.js). A role's permissions are copied onto
  every login that holds it, and saving the role updates them all at once.
*/

const router = express.Router();

const rejectInvalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ status: 'error', message: errors.array()[0].msg, errors: errors.array() });
  return true;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const roleValidation = [
  body('name').isString().trim().notEmpty().withMessage('Give the role a name').isLength({ max: 60 }).withMessage('Role names are limited to 60 characters'),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 300 }).withMessage('Descriptions are limited to 300 characters'),
  body('baseRole').isIn(['manager', 'accountant', 'staff']).withMessage('Choose manager, accountant or staff as the account type'),
  body('permissions').isArray().withMessage('Permissions must be a list'),
  body('canViewAllData').optional().isBoolean()
];

/** Logins holding each role, keyed by role id. */
async function holderCounts(user, roleIds) {
  const rows = await User.aggregate([
    { $match: { ...(user.dataScope ? { dataScope: user.dataScope } : {}), accessRole: { $in: roleIds } } },
    { $group: { _id: '$accessRole', count: { $sum: 1 } } }
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
}

/** The print-shop starter roles, created once per business. */
async function ensurePresets(user) {
  if (await AccessRole.exists(orgScope(user))) return;
  const docs = ROLE_PRESETS.map((p) => ({ ...p, preset: true, dataScope: user.dataScope, userId: user._id }));
  // Two first visits at once could both get here; the second insert then hits
  // the unique name index and is ignored.
  await AccessRole.insertMany(docs, { ordered: false }).catch((err) => {
    if (err.code !== 11000 && !(err.writeErrors || []).every((e) => e.code === 11000)) throw err;
  });
}

const nameTaken = async (user, name, exceptId) =>
  AccessRole.exists({
    ...orgScope(user),
    name: { $regex: `^${escapeRegex(name.trim())}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {})
  });

const logRole = (req, role, action, actionType, description, severity = 'medium', changes) =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'access_role',
    entityId: role._id,
    entityName: role.name,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    changes,
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

/** Fields from the request body, cleaned. */
const roleFields = (b) => {
  const baseRole = b.baseRole;
  return {
    name: String(b.name).trim(),
    description: b.description ? String(b.description).trim() : '',
    baseRole,
    permissions: normalisePermissions(b.permissions),
    canViewAllData: b.canViewAllData === true && VIEW_ALL_ROLES.includes(baseRole)
  };
};

// GET /api/access-roles — every role in the business with how many people hold it
router.get('/', async (req, res) => {
  try {
    await ensurePresets(req.user);
    const roles = await AccessRole.find(orgScope(req.user)).sort({ preset: -1, createdAt: 1 }).lean();
    const counts = await holderCounts(req.user, roles.map((r) => r._id));
    const [customCount, ownerCount] = await Promise.all([
      User.countDocuments({ ...(req.user.dataScope ? { dataScope: req.user.dataScope } : { _id: req.user._id }), role: { $ne: 'admin' }, accessRole: null }),
      User.countDocuments({ ...(req.user.dataScope ? { dataScope: req.user.dataScope } : { _id: req.user._id }), role: 'admin' })
    ]);
    res.json({
      status: 'success',
      data: {
        roles: roles.map((r) => ({
          ...r,
          userCount: counts[String(r._id)] || 0,
          // Whether this login could save the role as it stands.
          editable: grantsBeyondOwn(req.user, r.permissions).length === 0 && !(r.canViewAllData && grantProblem(req.user, { canViewAllData: true }))
        })),
        customCount,
        ownerCount
      }
    });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading roles' });
  }
});

// POST /api/access-roles — create a role
router.post('/', roleValidation, async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const fields = roleFields(req.body);
    const problem = grantProblem(req.user, fields);
    if (problem) return res.status(403).json({ status: 'error', message: problem, code: 'PERMISSION_DENIED' });
    if (await nameTaken(req.user, fields.name)) {
      return res.status(409).json({ status: 'error', message: `There is already a role called "${fields.name}".` });
    }

    const role = await AccessRole.create({ ...fields, dataScope: req.user.dataScope, userId: req.user._id, updatedBy: req.user._id });
    logRole(req, role, 'Role Created', 'create', `Role "${role.name}" created (${role.baseRole}, ${role.permissions.length} permissions)`);
    res.status(201).json({ status: 'success', data: { role: { ...role.toObject(), userCount: 0, editable: true } } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', message: 'There is already a role with that name.' });
    console.error('Create role error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while creating the role' });
  }
});

// PUT /api/access-roles/:id — change a role; everyone holding it is updated
router.put('/:id', [param('id').isMongoId().withMessage('Role not found'), ...roleValidation], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const role = await AccessRole.findOne({ _id: req.params.id, ...orgScope(req.user) });
    if (!role) return res.status(404).json({ status: 'error', message: 'Role not found' });

    // A role that already carries access the editor lacks can only be changed
    // by the admin; otherwise a manager could strip or reshape a senior role.
    const held = grantProblem(req.user, { permissions: role.permissions, canViewAllData: role.canViewAllData });
    if (held) {
      return res.status(403).json({ status: 'error', message: `"${role.name}" includes access you don't hold, so only the admin can change it.`, code: 'PERMISSION_DENIED' });
    }
    const fields = roleFields(req.body);
    const problem = grantProblem(req.user, fields);
    if (problem) return res.status(403).json({ status: 'error', message: problem, code: 'PERMISSION_DENIED' });
    if (await nameTaken(req.user, fields.name, role._id)) {
      return res.status(409).json({ status: 'error', message: `There is already a role called "${fields.name}".` });
    }

    const before = { name: role.name, baseRole: role.baseRole, permissions: role.permissions, canViewAllData: role.canViewAllData };
    Object.assign(role, fields, { updatedBy: req.user._id });
    await role.save();

    // Everyone on the role gets the new access on their next request.
    const result = await User.updateMany(
      { accessRole: role._id, role: { $ne: 'admin' }, ...(req.user.dataScope ? { dataScope: req.user.dataScope } : {}) },
      { $set: { role: role.baseRole, permissions: role.permissions, canViewAllData: role.canViewAllData, accessRoleName: role.name } }
    );

    const added = role.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !role.permissions.includes(p));
    logRole(
      req,
      role,
      'Role Updated',
      'update',
      `Role "${role.name}" updated: ${added.length} permission${added.length === 1 ? '' : 's'} added, ${removed.length} removed; applied to ${result.modifiedCount} login${result.modifiedCount === 1 ? '' : 's'}`,
      'medium',
      { before, after: fields, fields: Object.keys(fields) }
    );

    res.json({
      status: 'success',
      message: result.modifiedCount ? `Saved. ${result.modifiedCount} ${result.modifiedCount === 1 ? 'person has' : 'people have'} the new access now.` : 'Saved.',
      data: { role: { ...role.toObject(), userCount: result.matchedCount, editable: true }, usersUpdated: result.modifiedCount }
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ status: 'error', message: 'There is already a role with that name.' });
    console.error('Update role error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving the role' });
  }
});

// DELETE /api/access-roles/:id — only when nobody holds it
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ status: 'error', message: 'Role not found' });
    const role = await AccessRole.findOne({ _id: req.params.id, ...orgScope(req.user) });
    if (!role) return res.status(404).json({ status: 'error', message: 'Role not found' });

    const held = grantProblem(req.user, { permissions: role.permissions, canViewAllData: role.canViewAllData });
    if (held) {
      return res.status(403).json({ status: 'error', message: `"${role.name}" includes access you don't hold, so only the admin can delete it.`, code: 'PERMISSION_DENIED' });
    }
    const holders = await User.countDocuments({ accessRole: role._id });
    if (holders > 0) {
      return res.status(409).json({
        status: 'error',
        message: `${holders} ${holders === 1 ? 'person has' : 'people have'} this role. Give them another role first.`,
        code: 'ROLE_IN_USE',
        userCount: holders
      });
    }

    await role.deleteOne();
    logRole(req, role, 'Role Deleted', 'delete', `Role "${role.name}" deleted`, 'medium');
    res.json({ status: 'success', message: `Role "${role.name}" deleted` });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting the role' });
  }
});

module.exports = router;
