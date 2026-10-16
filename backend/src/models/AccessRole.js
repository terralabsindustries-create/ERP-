const mongoose = require('mongoose');
const { ALL_PERMISSIONS } = require('../config/permissions');

/**
 * A named set of permissions for one business, e.g. "Designer" or "Press
 * operator". Giving someone a role copies its permissions onto their login, and
 * editing the role updates everyone who holds it (routes/accessRoles.js), so the
 * permission checks keep reading the login's own list and nothing else changes.
 *
 * baseRole is the account type the holders get. It decides who can be allowed
 * to see all staff data: managers and accountants can, staff never do.
 */
const accessRoleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Role name is required'],
    trim: true,
    maxlength: [60, 'Role names are limited to 60 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [300, 'Descriptions are limited to 300 characters']
  },
  baseRole: {
    type: String,
    enum: ['manager', 'accountant', 'staff'],
    default: 'staff'
  },
  permissions: [{ type: String, enum: ALL_PERMISSIONS }],
  canViewAllData: {
    type: Boolean,
    default: false
  },
  // Created from the print-shop starter set (config/rolePresets.js); still
  // editable and deletable like any other role.
  preset: {
    type: Boolean,
    default: false
  },
  dataScope: {
    type: String,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// One role per name in a business (the route also checks case-insensitively).
accessRoleSchema.index({ dataScope: 1, name: 1 }, { unique: true, partialFilterExpression: { dataScope: { $type: 'string' } } });

module.exports = mongoose.model('AccessRole', accessRoleSchema);
