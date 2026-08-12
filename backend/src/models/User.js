const mongoose = require('mongoose');
const { ALL_PERMISSIONS } = require('../config/permissions');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    // Invited users have no password until they accept their invitation and
    // choose one themselves — the admin never sets it for them.
    required: [
      function () { return this.status !== 'invited'; },
      'Password is required'
    ],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false // Don't include password in queries by default
  },
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'operator', 'designer', 'accountant', 'staff'],
    default: 'operator'
  },
  avatar: {
    type: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Lifecycle of the login itself: 'invited' until the invitation link has been
  // used to set a password, 'active' once it has. Separate from isActive, which
  // is the admin's enable/disable switch on an already-established account.
  status: {
    type: String,
    enum: ['invited', 'active'],
    default: 'active',
    index: true
  },
  invitation: {
    // Only the SHA-256 hash of the token is stored — the raw token exists in
    // the invitation email and nowhere else, so a database leak cannot be
    // replayed into an account takeover.
    tokenHash: {
      type: String,
      select: false,
      index: true
    },
    expiresAt: {
      type: Date
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    invitedAt: {
      type: Date
    },
    acceptedAt: {
      type: Date
    }
  },
  lastLogin: {
    type: Date
  },
  companyName: {
    type: String,
    trim: true
  },
  // Captured on the invitation form and held here until the invite is accepted,
  // at which point it seeds the new HR record.
  department: {
    type: String,
    trim: true
  },
  dataScope: {
    type: String,
    index: true,
    description: 'Unique identifier for data isolation. Users with same dataScope share data. Will be auto-generated if missing.'
  },
  permissions: [
    {
      type: String,
      // Modules plus their granular actions - see src/config/permissions.js
      enum: ALL_PERMISSIONS
    }
  ],
  subscription: {
    isActive: {
      type: Boolean,
      default: false
    },
    plan: {
      type: String,
      enum: ['free', 'basic', 'premium', 'enterprise']
    },
    startDate: {
      type: Date
    },
    endDate: {
      type: Date
    },
    autoRenew: {
      type: Boolean,
      default: false
    },
    lastOrderId: {
      type: String,
      trim: true
    },
    lastPaymentId: {
      type: String,
      trim: true
    }
  },
  preferences: {
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light'
    },
    language: {
      type: String,
      default: 'en'
    },
    notifications: {
      email: {
        type: Boolean,
        default: true
      },
      whatsapp: {
        type: Boolean,
        default: true
      },
      dashboard: {
        type: Boolean,
        default: true
      }
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  this.password = await bcrypt.hash(this.password, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12);
  next();
});

// Instance method to check password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Instance method to generate profile
userSchema.methods.generateProfile = function () {
  return {
    id: this._id,
    email: this.email,
    fullName: this.fullName,
    phone: this.phone,
    role: this.role,
    avatar: this.avatar,
    companyName: this.companyName,
    dataScope: this.dataScope,
    permissions: this.permissions || [],
    isActive: this.isActive,
    status: this.status,
    invitationExpiresAt: this.invitation ? this.invitation.expiresAt : undefined,
    preferences: this.preferences,
    subscription: this.subscription,
    lastLogin: this.lastLogin,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

// Update last login
userSchema.methods.updateLastLogin = function () {
  this.lastLogin = new Date();
  return this.save({ validateBeforeSave: false });
};

module.exports = mongoose.model('User', userSchema);
