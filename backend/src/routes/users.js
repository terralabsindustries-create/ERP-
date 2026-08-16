const express = require('express');
const { body, query } = require('express-validator');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { protect, authorize } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { ALL_PERMISSIONS, pruneOrphanedActions } = require('../config/permissions');
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
const { createTransporter, getFromAddress, sendMailErrorResponse } = require('../utils/mailer');

const router = express.Router();

// An admin is minted by signup and owns one dataScope. Inside that scope they can
// hand out a limited number of manager/staff logins.
const MAX_STAFF_LOGINS = parseInt(process.env.MAX_STAFF_LOGINS, 10) || 5;

// Everyone in the admin's dataScope except the admins themselves occupies a seat.
const staffSeatQuery = (user) => ({
  ...(user.dataScope ? { dataScope: user.dataScope } : { createdBy: user._id }),
  role: { $ne: 'admin' }
});

// Validation rules. No password here — invited users choose their own.
const userValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('fullName').notEmpty().withMessage('Full name is required').trim(),
  body('phone').optional({ checkFalsy: true }).isMobilePhone().withMessage('Valid phone number required'),
  body('role').optional().isIn(['admin', 'manager', 'staff', 'viewer']).withMessage('Invalid role'),
  body('department').optional().trim(),
  body('isActive').optional().isBoolean().withMessage('isActive must be boolean')
];

const updateUserValidation = [
  body('email').optional({ checkFalsy: true }).isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('fullName').optional().notEmpty().withMessage('Full name is required').trim(),
  body('phone').optional({ checkFalsy: true }).isMobilePhone().withMessage('Valid phone number required'),
  body('role').optional().isIn(['admin', 'manager', 'staff']).withMessage('Role must be admin, manager, or staff'),
  body('isActive').optional().isBoolean().withMessage('isActive must be boolean')
];

// @route   GET /api/users
// @desc    Get all users in the same dataScope (admin/manager only)
// @access  Private
router.get('/', protect, authorize('admin', 'manager'), [
  query('role').optional().isIn(['admin', 'manager', 'staff', 'viewer']),
  query('isActive').optional().isBoolean(),
  query('search').optional().trim(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const {
      role,
      isActive,
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

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
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

    res.status(200).json({
      status: 'success',
      data: {
        users,
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
    // Users can only view their own profile unless they're admin/manager
    const canView = req.user.role === 'admin' || req.user.role === 'manager' || req.user._id.toString() === req.params.id;

    if (!canView) {
      return res.status(403).json({
        status: 'error',
        message: 'Not authorized to view this user'
      });
    }

    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
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
router.post('/', protect, authorize('admin', 'manager'), userValidation, async (req, res) => {
  try {
    const { email, fullName, phone, role = 'staff', department, companyName, isActive = true, permissions = [] } = req.body;

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
        message: 'Admin accounts can only be created through signup. Choose the manager or staff role.'
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

    // Staff and Manager use explicitly selected permissions, with Dashboard always on.
    let finalPermissions = permissions || [];
    if (!finalPermissions.includes('Dashboard')) {
      finalPermissions = ['Dashboard', ...finalPermissions];
    }
    // Drop any action whose module was not granted.
    finalPermissions = pruneOrphanedActions(finalPermissions);

    // An invitation that can't be delivered is useless, so fail before writing
    // anything if the mail transport isn't usable.
    const transporter = createTransporter();

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
        from: getFromAddress(userData.companyName || process.env.COMPANY_NAME || 'SerpY ERP'),
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

    // No HR record yet, on purpose: an invitation that is never accepted must
    // not show up on the Employees page or in headcount. The record is created
    // when the invite is accepted (see POST /api/auth/invitation/:token/accept).

    // Log activity
    await ActivityLog.logActivity({
      action: isReinvite ? 'User Re-invited' : 'User Invited',
      description: `${fullName} (${email}) ${isReinvite ? 're-invited' : 'invited'} as ${role} with ${finalPermissions.length} permissions`,
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
router.post('/:id/resend-invitation', protect, authorize('admin', 'manager'), async (req, res) => {
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

    const transporter = createTransporter();

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
      from: getFromAddress(user.companyName || process.env.COMPANY_NAME || 'SerpY ERP'),
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
router.put('/:id', protect, updateUserValidation, async (req, res) => {
  try {
    const { email, fullName, phone, role, companyName, isActive, permissions } = req.body;

    // Users can only update their own profile unless they're admin/manager
    const canUpdate = req.user.role === 'admin' || req.user.role === 'manager' || req.user._id.toString() === req.params.id;

    if (!canUpdate) {
      return res.status(403).json({
        status: 'error',
        message: 'Not authorized to update this user'
      });
    }

    // Only admin can change role and active status
    if ((role || isActive !== undefined) && req.user.role !== 'admin') {
      return res.status(403).json({
        status: 'error',
        message: 'Only admin can change user role and status'
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
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

    const updateData = {};
    if (email) updateData.email = email;
    if (fullName) updateData.fullName = fullName;
    if (phone) updateData.phone = phone;
    if (companyName) updateData.companyName = companyName;
    if (req.user.role === 'admin' || req.user.role === 'manager') {
      if (role) updateData.role = role;
      if (isActive !== undefined) updateData.isActive = isActive;
      if (permissions && Array.isArray(permissions)) {
        // Admin gets all permissions automatically
        // Staff and Manager roles use selected permissions
        if (role === 'admin') {
          updateData.permissions = [...ALL_PERMISSIONS];
        } else {
          // Staff and Manager: use selected permissions
          let finalPerms = permissions || [];
          // Ensure Dashboard is always included
          if (!finalPerms.includes('Dashboard')) {
            finalPerms = ['Dashboard', ...finalPerms];
          }
          updateData.permissions = pruneOrphanedActions(finalPerms);
        }
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
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

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

        await createTransporter().sendMail({
          from: getFromAddress(updatedUser.companyName || process.env.COMPANY_NAME || 'SerpY ERP'),
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

    // Log activity
    await ActivityLog.logActivity({
      action: 'User Updated',
      description: `User ${updatedUser.fullName} profile updated${permissions ? ` with ${permissions.length} permissions` : ''}`,
      entityType: 'user',
      entityId: updatedUser._id,
      entityName: updatedUser.fullName,
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      actionType: 'update',
      changes: {
        before: { email: user.email, fullName: user.fullName, role: user.role, isActive: user.isActive, permissions: user.permissions },
        after: updateData,
        fields: Object.keys(updateData)
      },
      
      severity: 'low',
      userId: req.user._id,
      dataScope: req.user.dataScope,
    });

    res.status(200).json({
      status: 'success',
      message: `User updated successfully.${invitationNote}`,
      data: { user: updatedUser }
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
], async (req, res) => {
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

    const user = await User.findById(req.params.id);
    if (!user) {
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
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    await User.findByIdAndDelete(req.params.id);

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
router.put('/:id/toggle-status', protect, authorize('admin'), async (req, res) => {
  try {
    // Prevent admin from deactivating themselves
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot deactivate your own account'
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
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
router.get('/stats/summary', protect, authorize('admin', 'manager'), async (req, res) => {
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
