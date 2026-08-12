const express = require('express');
const { body } = require('express-validator');
const User = require('../models/User');
const OTP = require('../models/OTP');
const { protect, sendTokenResponse } = require('../middleware/auth');
const crypto = require('crypto');
const { generateOTP, hashOTP, verifyOTP, getOTPEmailTemplate } = require('../utils/otpUtils');
const { createTransporter, getFromAddress, sendMailErrorResponse } = require('../utils/mailer');
const { hashInvitationToken } = require('../utils/invitationUtils');
const { syncEmployeeForUser } = require('../utils/employeeSync');

const router = express.Router();

// How long a signup OTP must sit before another can be requested.
const OTP_RESEND_COOLDOWN_SECONDS = 60;

// Validation rules
const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('fullName').notEmpty().withMessage('Full name is required').trim(),
];

const sendOTPValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('fullName').notEmpty().withMessage('Full name is required').trim(),
  body('phone').optional({ checkFalsy: true }).isMobilePhone().withMessage('Please provide a valid phone number'),
  body('companyName').optional().trim(),
];

const verifyOTPValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('fullName').notEmpty().withMessage('Full name is required').trim(),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').notEmpty().withMessage('Password is required'),
];

// @route   POST /api/auth/send-otp
// @desc    Send OTP for email verification
// @access  Public
router.post('/send-otp', sendOTPValidation, async (req, res) => {
  try {
    // Check for validation errors
    const { validationResult } = require('express-validator');
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      console.log('Send OTP Validation errors:', errors.array());
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, fullName, phone, companyName } = req.body;

    // Signup mints a brand new admin account — an email that already has one
    // must go through login, not through a second signup.
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        status: 'error',
        message: 'An account already exists with this email. Please sign in instead.'
      });
    }

    // One code per minute per address. The UI counts the same 60 seconds down,
    // but the limit lives here so it can't be skipped by reloading the page.
    const lastOTP = await OTP.findOne({ email, type: 'signup' }).sort({ createdAt: -1 });
    if (lastOTP) {
      const elapsed = Math.floor((Date.now() - lastOTP.createdAt.getTime()) / 1000);
      if (elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
        const retryAfter = OTP_RESEND_COOLDOWN_SECONDS - elapsed;
        return res.status(429).json({
          status: 'error',
          message: `Please wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} before requesting another code.`,
          retryAfter
        });
      }
    }

    // Fail before touching the DB if email can't be delivered anyway.
    const transporter = createTransporter();

    // Delete any existing OTPs for this email
    await OTP.deleteMany({ email, type: 'signup' });

    // Generate new OTP
    const otp = generateOTP();
    const hashedOTP = hashOTP(otp);

    // Store OTP in database
    await OTP.create({
      email,
      otp: hashedOTP,
      type: 'signup',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });

    // Send OTP via email
    const emailTemplate = getOTPEmailTemplate(otp, fullName);

    const mailOptions = {
      from: getFromAddress('SerpY ERP'),
      to: email,
      subject: 'Verify Your Email - SerpY ERP',
      html: emailTemplate.html,
      text: emailTemplate.text
    };

    await transporter.sendMail(mailOptions);

    console.log('✅ OTP sent successfully to:', email);

    res.status(200).json({
      status: 'success',
      message: 'OTP sent successfully. Please check your email.',
      data: {
        email,
        expiresIn: 10 // minutes
      }
    });

  } catch (error) {
    sendMailErrorResponse(res, error, 'Send OTP');
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP and create user account
// @access  Public
router.post('/verify-otp', verifyOTPValidation, async (req, res) => {
  try {
    // Check for validation errors
    const { validationResult } = require('express-validator');
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      console.log('OTP Validation errors:', errors.array());
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, otp, password, fullName, phone, companyName } = req.body;

    // Re-check before burning the OTP: the account may have been created between
    // send-otp and now. Signup never logs an existing account in.
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        status: 'error',
        message: 'An account already exists with this email. Please sign in instead.'
      });
    }

    // Find and validate OTP
    const otpRecord = await OTP.findOne({
      email,
      type: 'signup',
      isUsed: false
    });

    if (!otpRecord) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or expired OTP. Please request a new OTP.'
      });
    }

    // Check if OTP is expired
    if (otpRecord.isExpired()) {
      return res.status(400).json({
        status: 'error',
        message: 'OTP has expired. Please request a new OTP.'
      });
    }

    // Check if attempts exceeded
    if (otpRecord.isAttemptsExceeded()) {
      return res.status(400).json({
        status: 'error',
        message: 'Too many incorrect attempts. Please request a new OTP.'
      });
    }

    // Verify OTP
    const isOTPValid = verifyOTP(otp, otpRecord.otp);
    if (!isOTPValid) {
      await otpRecord.incrementAttempts();
      const remainingAttempts = otpRecord.maxAttempts - otpRecord.attempts;
      
      return res.status(400).json({
        status: 'error',
        message: `Invalid OTP. ${remainingAttempts} attempts remaining.`
      });
    }

    // Mark OTP as used
    otpRecord.isUsed = true;
    await otpRecord.save();

    // Generate unique dataScope for new admin
    const dataScope = `scope_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

    // Create user with default subscription (30-day trial)
    const user = await User.create({
      email,
      password,
      fullName,
      phone,
      companyName,
      role: 'admin', // First user is admin
      dataScope, // Each admin gets their own unique dataScope
      subscription: {
        isActive: true,
        plan: 'free',
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        autoRenew: false
      }
    });

    // Generate token and send response
    sendTokenResponse(user, 201, res, 'Account created successfully!');

  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error during OTP verification',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Verification failed'
    });
  }
});

// @route   POST /api/auth/register
// @desc    Register a new user (legacy - for backward compatibility)
// @access  Public
router.post('/register', registerValidation, async (req, res) => {
  try {
    const { email, password, fullName, phone, companyName } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        status: 'error',
        message: 'An account already exists with this email. Please sign in instead.'
      });
    }

    // Generate unique dataScope for new admin
    // Format: scope_<timestamp>_<random>
    const dataScope = `scope_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

    // Create user with default subscription (30-day trial)
    const user = await User.create({
      email,
      password,
      fullName,
      phone,
      companyName,
      role: 'admin', // First user is admin
      dataScope, // Each admin gets their own unique dataScope
      subscription: {
        isActive: true,
        plan: 'free',
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        autoRenew: false
      }
    });

    // Generate token and send response
    sendTokenResponse(user, 201, res, 'User registered successfully');

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error during registration'
    });
  }
});

// Look up an invited user from the raw token in their link. Only the hash is
// stored, so we hash what we were given and compare — the raw token is never
// written anywhere. Returns null for unknown, used, or expired invitations.
const findInvitedUserByToken = async (token) => {
  if (!token) return null;

  const user = await User.findOne({
    'invitation.tokenHash': hashInvitationToken(token)
  }).select('+invitation.tokenHash');

  if (!user) return null;
  // A used invitation has already flipped the account to 'active'.
  if (user.status !== 'invited') return null;
  if (!user.invitation || !user.invitation.expiresAt) return null;
  if (user.invitation.expiresAt.getTime() < Date.now()) return null;

  return user;
};

// @route   GET /api/auth/invitation/:token
// @desc    Validate an invitation link and describe the account it belongs to
// @access  Public
router.get('/invitation/:token', async (req, res) => {
  try {
    const user = await findInvitedUserByToken(req.params.token);

    if (!user) {
      return res.status(400).json({
        status: 'error',
        message: 'This invitation link is invalid or has expired. Ask your administrator to send a new one.'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        invitation: {
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          companyName: user.companyName,
          expiresAt: user.invitation.expiresAt
        }
      }
    });

  } catch (error) {
    console.error('Get invitation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while validating the invitation'
    });
  }
});

// @route   POST /api/auth/invitation/:token/accept
// @desc    Set the password on an invited account and activate it
// @access  Public
router.post('/invitation/:token/accept', [
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  try {
    const { validationResult } = require('express-validator');
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const user = await findInvitedUserByToken(req.params.token);

    if (!user) {
      return res.status(400).json({
        status: 'error',
        message: 'This invitation link is invalid or has expired. Ask your administrator to send a new one.'
      });
    }

    // Password is hashed by the pre-save hook. Clearing the token is what makes
    // the link one-time — replaying it will no longer match any account. The
    // paths are unset individually because assigning a fresh object to a nested
    // path merges rather than replaces, which would leave the hash behind.
    user.password = req.body.password;
    user.status = 'active';
    user.invitation.tokenHash = undefined;
    user.invitation.expiresAt = undefined;
    user.invitation.acceptedAt = new Date();
    await user.save();

    // Now that they've joined, add them to the HR directory. Attribute the row
    // to whoever invited them so it lands in the right tenant scope. A sync
    // failure must never block the account activation itself.
    const inviter = user.invitation.invitedBy
      ? await User.findById(user.invitation.invitedBy)
      : null;

    await syncEmployeeForUser(user, inviter, { department: user.department }).catch(err =>
      console.error('Employee sync (accept invitation) failed:', err.message)
    );

    res.status(200).json({
      status: 'success',
      message: 'Your password has been set. You can now sign in.',
      data: { email: user.email }
    });

  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while setting your password'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', loginValidation, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Check for user
    const user = await User.findOne({ email }).select('+password');
    
    if (!user) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid credentials'
      });
    }

    // An invited account has no password yet — there is nothing to compare.
    if (user.status === 'invited') {
      return res.status(403).json({
        status: 'error',
        message: 'Your account setup is not complete. Use the invitation link emailed to you to set a password, or ask your administrator to resend it.',
        code: 'INVITATION_PENDING'
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    
    if (!isMatch) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid credentials'
      });
    }
    
    // Update last login
    await user.updateLastLogin();
    
    // Generate token and send response
    sendTokenResponse(user, 200, res, 'Login successful');
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error during login'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current logged-in user
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    res.status(200).json({
      status: 'success',
      data: {
        user: req.user.generateProfile()
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while fetching user data'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', protect, async (req, res) => {
  try {
    res.cookie('token', 'none', {
      expires: new Date(Date.now() + 10 * 1000),
      httpOnly: true
    });
    
    res.status(200).json({
      status: 'success',
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error during logging out'
    });
  }
});

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', protect, [
  body('fullName').optional().notEmpty().trim(),
  body('phone').optional({ checkFalsy: true }).isMobilePhone(),
], async (req, res) => {
  try {
    const allowedUpdates = ['fullName', 'phone', 'companyName', 'preferences'];
    const updates = {};
    
    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key)) {
        updates[key] = req.body[key];
      }
    });
    
    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }
    );
    
    res.status(200).json({
      status: 'success',
      message: 'Profile updated successfully',
      data: {
        user: user.generateProfile()
      }
    });
    
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating profile'
    });
  }
});

// @route   PUT /api/auth/password
// @desc    Update password
// @access  Private
router.put('/password', protect, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
], async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    // Get user with password
    const user = await User.findById(req.user._id).select('+password');
    
    // Check current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        status: 'error',
        message: 'Current password is incorrect'
      });
    }
    
    // Update password
    user.password = newPassword;
    await user.save();
    
    res.status(200).json({
      status: 'success',
      message: 'Password updated successfully'
    });
    
  } catch (error) {
    console.error('Password update error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error while updating password'
    });
  }
});

// @route   GET /api/auth/users
// @desc    Get all users in the same dataScope (admin only)
// @access  Private/Admin
router.get('/users', protect, async (req, res) => {
  try {
    // Only admin and manager can view all users
    if (!['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({
        status: 'error',
        message: 'Not authorized to access this resource'
      });
    }

    // Filter by dataScope to ensure data isolation
    // Fallback to empty list if user doesn't have dataScope yet
    const query = req.user.dataScope
      ? { isActive: true, dataScope: req.user.dataScope }
      : { isActive: true, _id: null }; // Return empty results during migration

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 });

    res.status(200).json({
      status: 'success',
      data: {
        users: users.map(user => user.generateProfile())
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

module.exports = router;
