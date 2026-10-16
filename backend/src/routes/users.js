const express = require('express');
const mongoose = require('mongoose');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const Team = require('../models/Team');
const ActivityLog = require('../models/ActivityLog');
const { protect, authorize } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { pruneOrphanedActions } = require('../config/permissions');
const { canViewAllStaffData } = require('../utils/dataScopeHelper');
const { userCan, requirePermission } = require('../middleware/requirePermission');
const { orgScope } = require('../utils/accessScope');
const { VIEW_ALL_ROLES, manageableBy, accessFromRole, grantProblem } = require('../utils/userAccess');
const { setUserTeams, teamsByUser, teamsInOrg } = require('../utils/teamMembership');
const {
  syncEmployeeForUser,
  syncEmployeeStatusForUser,
  unlinkEmployeeForUser
} = require('../utils/employeeSync');
const {
  createInvitationToken,
  buildAcceptUrl,
  getInvitationEmailTemplate,
  INVITATION_EXPIRY_HOURS
} = require('../utils/invitationUtils');
// Called through the module so tests can stand in for the mail transport.
const mailer = require('../utils/mailer');

const { getFromAddress, sendMailErrorResponse } = mailer;

const router = express.Router();

// An admin is minted by signup and owns one dataScope. Inside that scope they can
// hand out a limited number of manager/staff logins.
const MAX_STAFF_LOGINS = parseInt(process.env.MAX_STAFF_LOGINS, 10) || 20;

// Everyone in the admin's dataScope except the admins themselves occupies a seat.
const staffSeatQuery = (user) => ({
  ...(user.dataScope ? { dataScope: user.dataScope } : { createdBy: user._id }),
  role: { $ne: 'admin' }
});

// A login may only be read or changed by people in the same business. Without
// this, an admin or manager could address any user id in the database.
const inSameBusiness = (actor, target) =>
  !!target && (
    String(target._id) === String(actor._id) ||
    (actor.dataScope ? target.dataScope === actor.dataScope : String(target.createdBy) === String(actor._id))
  );

/*
  Who may do what here (the admin passes every check):
    list and read logins     managers (as before) or User Management
    invite, resend invite    User Management: Create Login
    change someone's role, permissions, teams or active status
                             User Management: Edit Permissions, and only for
                             people who hold no access the editor lacks
    delete a login           the admin only (unchanged)
  Nobody but the admin changes their own access.
*/
const canListUsers = (req, res, next) => {
  if (['admin', 'manager'].includes(req.user.role) || userCan(req.user, 'User Management')) return next();
  return res.status(403).json({ status: 'error', message: 'You do not have permission to access User Management.', code: 'PERMISSION_DENIED', required: 'User Management' });
};

/** A role in the caller's business, or null. */
const findRole = (user, id) => (mongoose.isValidObjectId(id) ? AccessRole.findOne({ _id: id, ...orgScope(user) }) : null);

/** All of these team ids belong to the caller's business. */
async function validTeams(user, teamIds) {
  if (!Array.isArray(teamIds)) return false;
  const found = await teamsInOrg(user, teamIds);
  return found.length === new Set(teamIds.map(String)).size;
}

// Validation rules. No password here — invited users choose their own.
const userValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('fullName').notEmpty().withMessage('Full name is required').trim(),
  body('phone').optional({ values: 'falsy' }).matches(/^\+?[\d\s()-]{7,20}$/).withMessage('Enter a valid phone number'),
  body('role').optional({ values: 'falsy' }).isIn(['admin', 'manager', 'accountant', 'staff', 'viewer']).withMessage('Invalid role'),
  body('department').optional({ values: 'falsy' }).trim(),
  body('isActive').optional({ values: 'falsy' }).isBoolean().withMessage('isActive must be boolean')
];

const updateUserValidation = [
  body('email').optional({ values: 'falsy' }).isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('fullName').optional({ values: 'falsy' }).notEmpty().withMessage('Full name is required').trim(),
  body('phone').optional({ values: 'falsy' }).matches(/^\+?[\d\s()-]{7,20}$/).withMessage('Enter a valid phone number'),
  body('role').optional({ values: 'falsy' }).isIn(['admin', 'manager', 'accountant', 'staff']).withMessage('Role must be admin, manager, accountant or staff'),
  body('isActive').optional({ values: 'falsy' }).isBoolean().withMessage('isActive must be boolean')
];

// @route   GET /api/users
// @desc    Get all users in the same dataScope (admin/manager only)
// @access  Private
router.get('/', protect, canListUsers, [
  query('role').optional({ values: 'falsy' }).isIn(['all', 'admin', 'manager', 'accountant', 'staff', 'viewer']),
  query('isActive').optional({ values: 'falsy' }).isBoolean(),
  query('status').optional({ values: 'falsy' }).isIn(['all', 'active', 'invited', 'inactive']),
  query('accessRole').optional({ values: 'falsy' }).isString(),
  query('team').optional({ values: 'falsy' }).isMongoId(),
  query('search').optional({ values: 'falsy' }).trim(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 })
], validate, async (req, res) => {
  try {
    const {
      role,
      isActive,
      status,
      accessRole,
      team,
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query - filter by dataScope to ensure data isolation
    // Fallback to filtering by createdBy if dataScope is missing (during migration)
    const query = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { createdBy: req.user._id };

    if (role && role !== 'all') {
      query.role = role;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    // Invited = hasn't set a password yet; inactive = switched off by the admin.
    if (status === 'invited') query.status = 'invited';
    if (status === 'active') Object.assign(query, { status: { $ne: 'invited' }, isActive: { $ne: false } });
    if (status === 'inactive') Object.assign(query, { status: { $ne: 'invited' }, isActive: false });

    // "custom" = permissions set one by one rather than from a role.
    if (accessRole === 'custom') Object.assign(query, { accessRole: null, role: { $ne: 'admin' } });
    else if (accessRole && mongoose.isValidObjectId(accessRole)) query.accessRole = accessRole;

    if (team) {
      const t = await Team.findOne({ _id: team, ...orgScope(req.user) }).select('members').lean();
      query._id = { $in: t ? t.members : [] };
    }

    if (search) {
      const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { fullName: { $regex: pattern, $options: 'i' } },
        { email: { $regex: pattern, $options: 'i' } },
        { phone: { $regex: pattern, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Execute query
    const users = await User.find(query)
      .select('-password')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count
    const totalUsers = await User.countDocuments(query);
    const teams = await teamsByUser(req.user, users.map((u) => u._id));

    res.status(200).json({
      status: 'success',
      data: {
        users: users.map((u) => ({
          ...u.toJSON(),
          invitation: u.status === 'invited' && u.invitation ? { expiresAt: u.invitation.expiresAt, invitedAt: u.invitation.invitedAt } : undefined,
          teams: teams[String(u._id)] || []
        })),
        pagination: {
          current: parseInt(page),
          total: Math.ceil(totalUsers / limit),
          count: users.length,
          totalUsers
        }
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching users'
    });
  }
});

// @route   GET /api/users/:id
// @desc    Get single user
// @access  Private
router.get('/:id', protect, async (req, res) => {
  try {
    // Users can only view their own profile unless they manage logins
    const canView = ['admin', 'manager'].includes(req.user.role) || userCan(req.user, 'User Management') || req.user._id.toString() === req.params.id;

    if (!canView) {
      return res.status(403).json({
        status: 'error',
        message: 'Not authorized to view this user'
      });
    }

    const user = await User.findById(req.params.id).select('-password');

    if (!inSameBusiness(req.user, user)) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: { user }
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching user'
    });
  }
});

// @route   POST /api/users
// @desc    Invite a new user (admin/manager). The account is created in the
//          'invited' state and activated when the recipient sets their password.
// @access  Private
router.post('/', protect, requirePermission('User Management: Create Login'), userValidation, validate, async (req, res) => {
  try {
    const { email, fullName, phone, department, companyName, isActive = true, permissions = [], accessRoleId, teamIds = [] } = req.body;
    let { role = 'staff', canViewAllData = false } = req.body;

    // An address that is still sitting on an unaccepted invitation isn't really
    // taken — inviting it again should replace that invitation rather than be
    // refused. Only a live account (or one in another tenant) is a conflict.
    const existingUser = await User.findOne({ email });
    const isReinvite = !!existingUser &&
      existingUser.status === 'invited' &&
      (!req.user.dataScope || existingUser.dataScope === req.user.dataScope);

    if (existingUser && !isReinvite) {
      return res.status(409).json({
        status: 'error',
        message: 'An account already exists with this email'
      });
    }

    // Only the signup flow mints admins. Logins created here are manager/staff.
    if (role === 'admin') {
      return res.status(403).json({
        status: 'error',
        message: 'Admin accounts can only be created through signup. Choose the manager, accountant or staff role.'
      });
    }

    // Enforce the seat limit before creating anything. A re-invite reuses the
    // seat the pending invitation already holds, so it is exempt.
    const seatsUsed = await User.countDocuments(staffSeatQuery(req.user));
    if (!isReinvite && seatsUsed >= MAX_STAFF_LOGINS) {
      return res.status(403).json({
        status: 'error',
        message: `Staff limit reached — an admin can create up to ${MAX_STAFF_LOGINS} staff/manager logins. Delete an existing login to free a slot.`
      });
    }

    // With a role, the role decides the account type and permissions; without
    // one ("Custom access") they come from the form, with Dashboard always on.
    let roleAccess = null;
    if (accessRoleId) {
      const accessRole = await findRole(req.user, accessRoleId);
      if (!accessRole) {
        return res.status(400).json({ status: 'error', message: 'That role no longer exists. Choose another one.' });
      }
      roleAccess = accessFromRole(accessRole);
      role = roleAccess.role;
      canViewAllData = roleAccess.canViewAllData;
    }

    let finalPermissions = roleAccess ? roleAccess.permissions : permissions || [];
    if (!finalPermissions.includes('Dashboard')) {
      finalPermissions = ['Dashboard', ...finalPermissions];
    }
    // Drop any action whose module was not granted.
    finalPermissions = pruneOrphanedActions(finalPermissions);

    const problem = grantProblem(req.user, { permissions: finalPermissions, canViewAllData });
    if (problem) {
      return res.status(403).json({ status: 'error', message: problem, code: 'PERMISSION_DENIED' });
    }

    if (teamIds.length && !(await validTeams(req.user, teamIds))) {
      return res.status(400).json({ status: 'error', message: 'One of the chosen teams no longer exists.' });
    }

    // An invitation that can't be delivered is useless, so fail before writing
    // anything if the mail transport isn't usable.
    const transporter = mailer.createTransporter();

    const invitation = createInvitationToken();

    // Assign dataScope: new users inherit the creator's (admin's) dataScope
    // This ensures staff/managers created by an admin can access that admin's data
    const userData = {
      email,
      fullName,
      phone,
      role,
      department,
      companyName: companyName || req.user.companyName,
      isActive,
      permissions: finalPermissions,
      canViewAllData: canViewAllData === true && VIEW_ALL_ROLES.includes(role),
      accessRole: roleAccess ? roleAccess.accessRole : null,
      accessRoleName: roleAccess ? roleAccess.accessRoleName : undefined,
      // No password: the invitee sets one through their one-time link.
      status: 'invited',
      invitation: {
        tokenHash: invitation.tokenHash,
        expiresAt: invitation.expiresAt,
        invitedBy: req.user._id,
        invitedAt: new Date()
      }
    };

    // Only add dataScope if admin has one (post-migration)
    if (req.user.dataScope) {
      userData.dataScope = req.user.dataScope;
    }

    // Re-inviting overwrites the pending record — including any detail the
    // admin corrected on the form — and the new token voids the old link.
    const user = isReinvite
      ? await User.findByIdAndUpdate(existingUser._id, userData, { new: true, runValidators: true })
      : await User.create(userData);

    // Send the invitation. If the mail bounces on a brand new account it would
    // be unreachable, so roll it back and report the failure to the admin.
    try {
      const emailContent = getInvitationEmailTemplate({
        fullName,
        email,
        role,
        department,
        companyName: userData.companyName || process.env.COMPANY_NAME,
        acceptUrl: buildAcceptUrl(invitation.token)
      });

      await transporter.sendMail({
        from: getFromAddress(userData.companyName || process.env.COMPANY_NAME || 'Terralabs ERP'),
        to: email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text
      });
    } catch (mailError) {
      // Only undo what this request created; a pre-existing pending invitation
      // stays put so the admin can retry with Resend invitation.
      if (!isReinvite) await User.findByIdAndDelete(user._id);
      return sendMailErrorResponse(res, mailError, 'Send invitation');
    }

    await setUserTeams(req.user, user._id, teamIds);

    // No HR record yet, on purpose: an invitation that is never accepted must
    // not show up on the Employees page or in headcount. The record is created
    // when the invite is accepted (see POST /api/auth/invitation/:token/accept).

    // Log activity
    await ActivityLog.logActivity({
      action: isReinvite ? 'User Re-invited' : 'User Invited',
      description: `${fullName} (${email}) ${isReinvite ? 're-invited' : 'invited'} as ${roleAccess ? `"${roleAccess.accessRoleName}"` : `${role} with ${finalPermissions.length} permissions`}`,
      entityType: 'user',
      entityId: user._id,
      entityName: fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: isReinvite ? 'update' : 'create',
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.invitation;

    res.status(201).json({
      status: 'success',
      message: isReinvite
        ? `A new invitation was sent to ${email}, replacing the pending one. It expires in ${INVITATION_EXPIRY_HOURS} hours.`
        : `Invitation sent to ${email}. It expires in ${INVITATION_EXPIRY_HOURS} hours.`,
      data: {
        user: userResponse,
        invitationExpiresAt: invitation.expiresAt
      }
    });

  } catch (error) {
    // No usable mail transport: say so rather than a generic server error.
    if (error.code === 'EMAIL_NOT_CONFIGURED' || error.code === 'EAUTH') {
      return sendMailErrorResponse(res, error, 'Send invitation');
    }
    console.error('Create user error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while inviting user'
    });
  }
});

// @route   POST /api/users/:id/resend-invitation
// @desc    Issue a fresh invitation link for a user who hasn't accepted yet
// @access  Private/Admin/Manager
router.post('/:id/resend-invitation', protect, requirePermission('User Management: Create Login'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user || (req.user.dataScope && user.dataScope !== req.user.dataScope)) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    if (user.status !== 'invited') {
      return res.status(400).json({
        status: 'error',
        message: 'This user has already set up their account.'
      });
    }

    const transporter = mailer.createTransporter();

    // Any previously mailed link stops working the moment we store a new hash.
    const invitation = createInvitationToken();
    user.invitation = {
      tokenHash: invitation.tokenHash,
      expiresAt: invitation.expiresAt,
      invitedBy: req.user._id,
      invitedAt: new Date()
    };
    await user.save({ validateBeforeSave: false });

    const emailContent = getInvitationEmailTemplate({
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      companyName: user.companyName || req.user.companyName || process.env.COMPANY_NAME,
      acceptUrl: buildAcceptUrl(invitation.token)
    });

    await transporter.sendMail({
      from: getFromAddress(user.companyName || process.env.COMPANY_NAME || 'Terralabs ERP'),
      to: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text
    });

    await ActivityLog.logActivity({
      action: 'Invitation Resent',
      description: `Invitation resent to ${user.fullName} (${user.email})`,
      entityType: 'user',
      entityId: user._id,
      entityName: user.fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    res.status(200).json({
      status: 'success',
      message: `Invitation resent to ${user.email}. It expires in ${INVITATION_EXPIRY_HOURS} hours.`,
      data: { invitationExpiresAt: invitation.expiresAt }
    });

  } catch (error) {
    if (error.code === 'EMAIL_NOT_CONFIGURED' || error.code === 'EAUTH') {
      return sendMailErrorResponse(res, error, 'Resend invitation');
    }
    console.error('Resend invitation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while resending the invitation'
    });
  }
});

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private
router.put('/:id', protect, updateUserValidation, validate, async (req, res) => {
  try {
    const { email, fullName, phone, role, companyName, isActive, permissions, canViewAllData, teamIds } = req.body;
    const hasRoleField = Object.prototype.hasOwnProperty.call(req.body, 'accessRoleId');
    const accessRoleId = req.body.accessRoleId;

    const isSelf = req.user._id.toString() === req.params.id;
    const changesAccess =
      role !== undefined || isActive !== undefined || Array.isArray(permissions) ||
      canViewAllData !== undefined || hasRoleField || Array.isArray(teamIds);

    // Anyone may edit their own name and phone. Changing another login, or
    // anyone's access, needs User Management: Edit Permissions.
    if (!isSelf && !userCan(req.user, 'User Management: Edit Permissions')) {
      return res.status(403).json({
        status: 'error',
        message: 'You do not have permission to change other logins.',
        code: 'PERMISSION_DENIED',
        required: 'User Management: Edit Permissions'
      });
    }
    if (isSelf && changesAccess && req.user.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: "You can't change your own access. Ask the admin." });
    }

    const user = await User.findById(req.params.id);
    if (!inSameBusiness(req.user, user)) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // The admin account is the business owner: its role and status are fixed,
    // and only the admin may edit it.
    if (user.role === 'admin') {
      if (!isSelf) {
        return res.status(403).json({ status: 'error', message: 'Only the admin can change the admin account.' });
      }
      if ((role && role !== 'admin') || hasRoleField || isActive === false) {
        return res.status(403).json({ status: 'error', message: "The admin account always has full access; its role can't be changed." });
      }
    } else if (!isSelf) {
      const manageable = manageableBy(req.user, user);
      if (!manageable.ok) return res.status(403).json({ status: 'error', message: manageable.message, code: 'PERMISSION_DENIED' });
    }

    // Closing the back door on the seat limit: a manager/staff login cannot be
    // promoted into an admin, which would carry unlimited seats of its own.
    if (role === 'admin' && user.role !== 'admin') {
      return res.status(403).json({
        status: 'error',
        message: 'Users cannot be promoted to admin. Admin accounts are created through signup only.'
      });
    }

    // Check if email is being changed and if it already exists
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({
          status: 'error',
          message: 'An account already exists with this email'
        });
      }
    }

    if (Array.isArray(teamIds) && !(await validTeams(req.user, teamIds))) {
      return res.status(400).json({ status: 'error', message: 'One of the chosen teams no longer exists.' });
    }

    const updateData = {};
    const unset = {};
    if (email) updateData.email = email;
    if (fullName) updateData.fullName = fullName;
    if (phone) updateData.phone = phone;
    if (companyName) updateData.companyName = companyName;

    if (user.role !== 'admin') {
      if (isActive !== undefined) updateData.isActive = isActive;

      if (hasRoleField && accessRoleId) {
        // Give the login a role: account type and permissions come from it.
        const accessRole = await findRole(req.user, accessRoleId);
        if (!accessRole) return res.status(400).json({ status: 'error', message: 'That role no longer exists. Choose another one.' });
        const access = accessFromRole(accessRole);
        const problem = grantProblem(req.user, access);
        if (problem) return res.status(403).json({ status: 'error', message: problem, code: 'PERMISSION_DENIED' });
        Object.assign(updateData, access);
      } else if (Array.isArray(permissions) || hasRoleField) {
        // Custom access: permissions set one by one, no role attached.
        const finalRole = role || user.role;
        const finalPerms = Array.isArray(permissions)
          ? pruneOrphanedActions(permissions.includes('Dashboard') ? permissions : ['Dashboard', ...permissions])
          : user.permissions;
        const wantsViewAll = canViewAllData !== undefined ? canViewAllData === true : user.canViewAllData === true;
        const finalViewAll = wantsViewAll && VIEW_ALL_ROLES.includes(finalRole);
        const problem = grantProblem(req.user, {
          permissions: finalPerms,
          // Only a change towards seeing all data needs the right to grant it.
          canViewAllData: finalViewAll && user.canViewAllData !== true
        });
        if (problem) return res.status(403).json({ status: 'error', message: problem, code: 'PERMISSION_DENIED' });
        Object.assign(updateData, { role: finalRole, permissions: finalPerms, canViewAllData: finalViewAll, accessRole: null });
        unset.accessRoleName = 1;
      } else if (role || canViewAllData !== undefined) {
        // Account type or the view-all switch on its own (older clients).
        const finalRole = role || user.role;
        const wantsViewAll = canViewAllData !== undefined ? canViewAllData === true : user.canViewAllData === true;
        const finalViewAll = wantsViewAll && VIEW_ALL_ROLES.includes(finalRole);
        if (finalViewAll && user.canViewAllData !== true && !canViewAllStaffData(req.user)) {
          return res.status(403).json({ status: 'error', message: 'Only the admin can allow a login to view all staff data.' });
        }
        updateData.role = finalRole;
        updateData.canViewAllData = finalViewAll;
      }
    }

    // Correcting the address of someone who hasn't accepted yet: the link that
    // went to the old address must stop working, and the new address needs one.
    const emailChangedForInvitee =
      user.status === 'invited' && email && email !== user.email;
    let reissuedInvitation = null;

    if (emailChangedForInvitee) {
      reissuedInvitation = createInvitationToken();
      updateData.invitation = {
        tokenHash: reissuedInvitation.tokenHash,
        expiresAt: reissuedInvitation.expiresAt,
        invitedBy: req.user._id,
        invitedAt: new Date()
      };
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updateData, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, runValidators: true }
    ).select('-password');

    if (Array.isArray(teamIds)) await setUserTeams(req.user, updatedUser._id, teamIds);

    let invitationNote = '';
    if (reissuedInvitation) {
      try {
        const emailContent = getInvitationEmailTemplate({
          fullName: updatedUser.fullName,
          email: updatedUser.email,
          role: updatedUser.role,
          companyName: updatedUser.companyName || req.user.companyName || process.env.COMPANY_NAME,
          acceptUrl: buildAcceptUrl(reissuedInvitation.token)
        });

        await mailer.createTransporter().sendMail({
          from: getFromAddress(updatedUser.companyName || process.env.COMPANY_NAME || 'Terralabs ERP'),
          to: updatedUser.email,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text
        });
        invitationNote = ' A new invitation was sent to the updated address.';
      } catch (mailError) {
        // The address change stands; the admin can retry with Resend invitation.
        console.error('Invitation re-send after email change failed:', mailError.message);
        invitationNote = ' The invitation could not be emailed — use Resend invitation to try again.';
      }
    }

    // Keep the linked employee's identity fields in step with the login.
    await syncEmployeeForUser(updatedUser, req.user).catch(err =>
      console.error('Employee sync (update user) failed:', err.message)
    );
    if (updateData.isActive !== undefined && updateData.isActive !== user.isActive) {
      await syncEmployeeStatusForUser(updatedUser).catch(err =>
        console.error('Employee sync (status) failed:', err.message)
      );
    }

    const accessNote = updateData.accessRoleName
      ? ` — role "${updateData.accessRoleName}"`
      : Array.isArray(updateData.permissions)
        ? ` — custom access, ${updateData.permissions.length} permissions`
        : '';

    // Log activity
    await ActivityLog.logActivity({
      action: 'User Updated',
      description: `User ${updatedUser.fullName} updated${accessNote}`,
      entityType: 'user',
      entityId: updatedUser._id,
      entityName: updatedUser.fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: {
        before: { email: user.email, fullName: user.fullName, role: user.role, isActive: user.isActive, permissions: user.permissions, accessRoleName: user.accessRoleName },
        after: { ...updateData, invitation: undefined },
        fields: Object.keys(updateData).filter((k) => k !== 'invitation')
      },
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    const teams = await teamsByUser(req.user, [updatedUser._id]);
    res.status(200).json({
      status: 'success',
      message: `User updated successfully.${invitationNote}`,
      data: { user: { ...updatedUser.toJSON(), teams: teams[String(updatedUser._id)] || [] } }
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating user'
    });
  }
});

// @route   PUT /api/users/:id/password
// @desc    Change user password
// @access  Private
router.put('/:id/password', protect, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], validate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Users can only change their own password unless they're admin
    const canChangePassword = req.user.role === 'admin' || req.user._id.toString() === req.params.id;

    if (!canChangePassword) {
      return res.status(403).json({
        status: 'error',
        message: 'Not authorized to change this password'
      });
    }

    const user = await User.findById(req.params.id).select('+password');
    if (!inSameBusiness(req.user, user)) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Verify current password (unless admin is changing someone else's password)
    if (req.user._id.toString() === req.params.id) {
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({
          status: 'error',
          message: 'Current password is incorrect'
        });
      }
    }

    // Update password - pre-save hook will hash it
    user.password = newPassword;
    await user.save();

    // Log activity
    await ActivityLog.logActivity({
      action: 'Password Changed',
      description: `Password changed for user ${user.fullName}`,
      entityType: 'user',
      entityId: user._id,
      entityName: user.fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    res.status(200).json({
      status: 'success',
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while changing password'
    });
  }
});

// @route   DELETE /api/users/:id
// @desc    Delete user (admin only)
// @access  Private
router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    // Prevent admin from deleting themselves
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot delete your own account'
      });
    }

    const user = await User.findById(req.params.id);
    if (!inSameBusiness(req.user, user)) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    await User.findByIdAndDelete(req.params.id);
    await setUserTeams(req.user, user._id, []);

    // Keep the employee record (payroll/attendance history points at it) but
    // unlink it from the deleted login and mark it inactive.
    await unlinkEmployeeForUser(req.params.id).catch(err =>
      console.error('Employee sync (delete user) failed:', err.message)
    );

    // Log activity
    await ActivityLog.logActivity({
      action: 'User Deleted',
      description: `User ${user.fullName} (${user.email}) deleted`,
      entityType: 'user',
      entityId: user._id,
      entityName: user.fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'delete',
      
      severity: 'high',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    res.status(200).json({
      status: 'success',
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while deleting user'
    });
  }
});

// @route   PUT /api/users/:id/toggle-status
// @desc    Toggle user active status (admin only)
// @access  Private
router.put('/:id/toggle-status', protect, requirePermission('User Management: Edit Permissions'), async (req, res) => {
  try {
    // Prevent admin from deactivating themselves
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot deactivate your own account'
      });
    }

    const user = await User.findById(req.params.id);
    if (!inSameBusiness(req.user, user)) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Never the admin; and a non-admin only for people they can manage.
    const manageable = manageableBy(req.user, user);
    if (!manageable.ok) {
      return res.status(403).json({ status: 'error', message: manageable.message, code: 'PERMISSION_DENIED' });
    }

    user.isActive = !user.isActive;
    await user.save();

    await syncEmployeeStatusForUser(user).catch(err =>
      console.error('Employee sync (toggle status) failed:', err.message)
    );

    // Log activity
    await ActivityLog.logActivity({
      action: 'User Status Changed',
      description: `User ${user.fullName} ${user.isActive ? 'activated' : 'deactivated'}`,
      entityType: 'user',
      entityId: user._id,
      entityName: user.fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      
      severity: 'medium',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    res.status(200).json({
      status: 'success',
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      data: { user: { ...user.toObject(), password: undefined } }
    });

  } catch (error) {
    console.error('Toggle user status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while toggling user status'
    });
  }
});

// @route   GET /api/users/stats/summary
// @desc    Get user statistics for the same dataScope
// @access  Private
router.get('/stats/summary', protect, canListUsers, async (req, res) => {
  try {
    // Use dataScope if available, fallback to createdBy during migration
    const dataScopeQuery = req.user.dataScope
      ? { dataScope: req.user.dataScope }
      : { createdBy: req.user._id };

    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      usersByRole,
      recentUsers,
      staffSeatsUsed
    ] = await Promise.all([
      User.countDocuments(dataScopeQuery),
      User.countDocuments({ ...dataScopeQuery, isActive: true }),
      User.countDocuments({ ...dataScopeQuery, isActive: false }),
      User.aggregate([
        { $match: dataScopeQuery },
        { $group: { _id: '$role', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      User.find(dataScopeQuery)
        .select('-password')
        .sort({ createdAt: -1 })
        .limit(5),
      User.countDocuments(staffSeatQuery(req.user))
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalUsers,
          activeUsers,
          inactiveUsers,
          usersByRole,
          recentUsers,
          staffSeats: {
            used: staffSeatsUsed,
            limit: MAX_STAFF_LOGINS,
            remaining: Math.max(0, MAX_STAFF_LOGINS - staffSeatsUsed)
          }
        }
      }
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching user statistics'
    });
  }
});

module.exports = router;
