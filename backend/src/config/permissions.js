/**
 * Permission catalogue.
 *
 * Two levels, the same shape Shopify uses for staff permissions:
 *   - a MODULE grants access to a section of the app (this is what the sidebar
 *     and route guards check, and what every existing user already has)
 *   - an ACTION grants a specific capability inside that module and is only
 *     meaningful when its module is also granted
 *
 * Action strings are namespaced as "<Module>: <Action>" so a permission check
 * stays a plain string comparison and no existing check has to change.
 */

const PERMISSION_TREE = [
  { module: 'Dashboard', actions: [] },

  { module: 'Customers', actions: ['View', 'Create & Edit', 'Delete', 'Export'] },
  { module: 'Jobs', actions: ['View', 'Create & Edit', 'Delete', 'Change Status'] },
  { module: 'Quotations', actions: ['View', 'Create & Edit', 'Delete', 'Send Email', 'Change Status', 'Convert to Invoice'] },
  { module: 'Invoicing', actions: ['View', 'Create & Edit', 'Delete', 'Send Email', 'Record Payment', 'Download PDF'] },
  { module: 'Invoicing (View No GST)', actions: [] },

  { module: 'Calendar', actions: ['View', 'Create & Edit', 'Delete'] },
  { module: 'Inventory', actions: ['View', 'Create & Edit', 'Delete', 'Adjust Stock', 'View Cost'] },
  { module: 'HSN Codes', actions: ['View', 'Create & Edit', 'Delete'] },
  { module: 'SAC Codes', actions: ['View', 'Create & Edit', 'Delete'] },

  { module: 'Vendors', actions: ['View', 'Create & Edit', 'Delete'] },
  { module: 'Purchase Bills', actions: ['View', 'Create & Edit', 'Delete', 'Record Payment'] },

  { module: 'Staff & Tasks', actions: ['View', 'Assign Tasks', 'Manage Schedule'] },
  { module: 'Human Resources', actions: ['View', 'Create & Edit', 'Delete', 'View Salary', 'Manage Leaves'] },
  { module: 'Payroll', actions: ['View', 'Process Payroll', 'Export'] },

  { module: 'Delivery', actions: ['View', 'Create & Edit', 'Update Status'] },
  { module: 'Emergency Orders', actions: ['View', 'Create & Edit'] },
  { module: 'Cost & Profit', actions: ['View', 'Export'] },

  { module: 'Payments', actions: ['View', 'Record Payment', 'Delete'] },
  { module: 'Accounts', actions: ['View', 'Create & Edit', 'Delete'] },
  { module: 'Reports', actions: ['View', 'Export'] },

  { module: 'Designer Timer', actions: ['View', 'Track Time'] },
  { module: 'Discounts', actions: ['View', 'Create & Edit', 'Delete'] },
  { module: 'Job Proofing', actions: ['View', 'Approve', 'Reject'] },
  { module: 'WhatsApp', actions: ['View', 'Send Messages'] },
  { module: 'Payment Reminders', actions: ['View', 'Send Reminders'] },
  { module: 'Walk-In Jobs', actions: ['View', 'Create & Edit'] },
  { module: 'Customer Portal', actions: ['View', 'Manage Access'] },

  { module: 'Activity Log', actions: ['View', 'Export'] },
  { module: 'User Management', actions: ['View', 'Create Login', 'Edit Permissions', 'Delete User'] },
  { module: 'Settings', actions: ['View', 'Edit'] }
];

const actionName = (module, action) => `${module}: ${action}`;

const MODULE_PERMISSIONS = PERMISSION_TREE.map(g => g.module);

const ACTION_PERMISSIONS = PERMISSION_TREE.flatMap(g =>
  g.actions.map(a => actionName(g.module, a))
);

// Everything an admin gets.
const ALL_PERMISSIONS = [...MODULE_PERMISSIONS, ...ACTION_PERMISSIONS];

// Actions belonging to a module, used to drop orphaned actions when a module
// is revoked.
const actionsForModule = (module) => {
  const group = PERMISSION_TREE.find(g => g.module === module);
  return group ? group.actions.map(a => actionName(module, a)) : [];
};

/**
 * Remove any action whose parent module is not granted, so a stored permission
 * list can never imply access to a section the user cannot open.
 */
const pruneOrphanedActions = (permissions = []) => {
  const granted = new Set(permissions);
  return permissions.filter(p => {
    if (!p.includes(': ')) return true;
    const module = p.slice(0, p.indexOf(': '));
    return granted.has(module);
  });
};

module.exports = {
  PERMISSION_TREE,
  MODULE_PERMISSIONS,
  ACTION_PERMISSIONS,
  ALL_PERMISSIONS,
  actionsForModule,
  pruneOrphanedActions
};
