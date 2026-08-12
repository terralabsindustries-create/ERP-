/**
 * Permission catalogue — must stay in step with
 * backend/src/config/permissions.js (same modules, same action names).
 *
 * A MODULE grants access to a section of the app. An ACTION grants a specific
 * capability inside it and only applies when its module is granted too.
 * Actions are namespaced "<Module>: <Action>" so permission checks stay simple
 * string comparisons.
 */

export interface PermissionGroup {
  module: string;
  actions: string[];
}

export const PERMISSION_TREE: PermissionGroup[] = [
  { module: "Dashboard", actions: [] },

  { module: "Customers", actions: ["View", "Create & Edit", "Delete", "Export"] },
  { module: "Jobs", actions: ["View", "Create & Edit", "Delete", "Change Status"] },
  { module: "Quotations", actions: ["View", "Create & Edit", "Delete", "Send Email", "Change Status", "Convert to Invoice"] },
  { module: "Invoicing", actions: ["View", "Create & Edit", "Delete", "Send Email", "Record Payment", "Download PDF"] },
  { module: "Invoicing (View No GST)", actions: [] },

  { module: "Calendar", actions: ["View", "Create & Edit", "Delete"] },
  { module: "Inventory", actions: ["View", "Create & Edit", "Delete", "Adjust Stock", "View Cost"] },
  { module: "HSN Codes", actions: ["View", "Create & Edit", "Delete"] },
  { module: "SAC Codes", actions: ["View", "Create & Edit", "Delete"] },

  { module: "Vendors", actions: ["View", "Create & Edit", "Delete"] },
  { module: "Purchase Bills", actions: ["View", "Create & Edit", "Delete", "Record Payment"] },

  { module: "Staff & Tasks", actions: ["View", "Assign Tasks", "Manage Schedule"] },
  { module: "Human Resources", actions: ["View", "Create & Edit", "Delete", "View Salary", "Manage Leaves"] },
  { module: "Payroll", actions: ["View", "Process Payroll", "Export"] },

  { module: "Delivery", actions: ["View", "Create & Edit", "Update Status"] },
  { module: "Emergency Orders", actions: ["View", "Create & Edit"] },
  { module: "Cost & Profit", actions: ["View", "Export"] },

  { module: "Payments", actions: ["View", "Record Payment", "Delete"] },
  { module: "Accounts", actions: ["View", "Create & Edit", "Delete"] },
  { module: "Reports", actions: ["View", "Export"] },

  { module: "Designer Timer", actions: ["View", "Track Time"] },
  { module: "Discounts", actions: ["View", "Create & Edit", "Delete"] },
  { module: "Job Proofing", actions: ["View", "Approve", "Reject"] },
  { module: "WhatsApp", actions: ["View", "Send Messages"] },
  { module: "Payment Reminders", actions: ["View", "Send Reminders"] },
  { module: "Walk-In Jobs", actions: ["View", "Create & Edit"] },
  { module: "Customer Portal", actions: ["View", "Manage Access"] },

  { module: "Activity Log", actions: ["View", "Export"] },
  { module: "User Management", actions: ["View", "Create Login", "Edit Permissions", "Delete User"] },
  { module: "Settings", actions: ["View", "Edit"] },
];

export const actionName = (module: string, action: string) => `${module}: ${action}`;

export const MODULE_PERMISSIONS = PERMISSION_TREE.map((g) => g.module);

export const ACTION_PERMISSIONS = PERMISSION_TREE.flatMap((g) =>
  g.actions.map((a) => actionName(g.module, a))
);

export const ALL_PERMISSIONS = [...MODULE_PERMISSIONS, ...ACTION_PERMISSIONS];

export const actionsForModule = (module: string) => {
  const group = PERMISSION_TREE.find((g) => g.module === module);
  return group ? group.actions.map((a) => actionName(module, a)) : [];
};

/** Drop actions whose module is not granted. */
export const pruneOrphanedActions = (permissions: string[]) => {
  const granted = new Set(permissions);
  return permissions.filter((p) => {
    if (!p.includes(": ")) return true;
    return granted.has(p.slice(0, p.indexOf(": ")));
  });
};
