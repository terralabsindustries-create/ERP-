/**
 * Starter roles for a print shop, created the first time a business opens the
 * Roles screen. They are ordinary roles afterwards: the owner can rename, edit
 * or delete them.
 *
 * `grant` lists modules with the actions to include; `true` means every action
 * in that module. Permission names come from config/permissions.js.
 */
const { actionsForModule } = require('./permissions');

const actionName = (module, action) => `${module}: ${action}`;

const ALL = true;

const PRESETS = [
  {
    name: 'Shop manager',
    description: 'Runs the floor day to day: jobs, customers, quotes, billing, dispatch and the team. Sees everyone\'s records.',
    baseRole: 'manager',
    canViewAllData: true,
    grant: {
      Customers: ['View', 'Create & Edit', 'Export'],
      Jobs: ['View', 'Create & Edit', 'Change Status'],
      Quotations: ['View', 'Create & Edit', 'Send Email', 'Change Status', 'Convert to Invoice'],
      Invoicing: ['View', 'Create & Edit', 'Send Email', 'Record Payment', 'Download PDF'],
      Payments: ['View', 'Record Payment'],
      Calendar: ['View', 'Create & Edit'],
      Inventory: ['View', 'Create & Edit', 'Adjust Stock'],
      'Staff & Tasks': ALL,
      Delivery: ALL,
      'Emergency Orders': ALL,
      'Job Proofing': ALL,
      'Walk-In Jobs': ALL,
      'Customer Portal': ALL,
      'Payment Reminders': ['View'],
      Reports: ['View']
    }
  },
  {
    name: 'Accountant',
    description: 'Invoices, payments, purchase bills, accounts and GST reports. Sees everyone\'s billing records.',
    baseRole: 'accountant',
    canViewAllData: true,
    grant: {
      Customers: ['View'],
      Invoicing: ALL,
      'Invoicing (View No GST)': ALL,
      Payments: ALL,
      'Payment Reminders': ALL,
      'Purchase Bills': ALL,
      Vendors: ['View'],
      Accounts: ALL,
      Reports: ALL,
      'Cost & Profit': ['View'],
      'HSN Codes': ['View'],
      'SAC Codes': ['View']
    }
  },
  {
    name: 'Front desk',
    description: 'Takes enquiries and counter jobs, prepares quotations and books job tickets.',
    baseRole: 'staff',
    grant: {
      Customers: ['View', 'Create & Edit'],
      Quotations: ['View', 'Create & Edit', 'Send Email'],
      Jobs: ['View', 'Create & Edit'],
      'Walk-In Jobs': ALL,
      Calendar: ['View'],
      'Customer Portal': ['View']
    }
  },
  {
    name: 'Designer',
    description: 'Pre-press: works on the jobs and proofs assigned to them and logs design time.',
    baseRole: 'staff',
    grant: {
      Jobs: ['View', 'Change Status'],
      'Job Proofing': ['View'],
      'Designer Timer': ALL
    }
  },
  {
    name: 'Press operator',
    description: 'Production: moves jobs through press and finishing and checks paper and stock.',
    baseRole: 'staff',
    grant: {
      Jobs: ['View', 'Change Status'],
      'Walk-In Jobs': ['View'],
      Inventory: ['View']
    }
  },
  {
    name: 'Dispatch',
    description: 'Packs and delivers finished jobs and updates delivery status.',
    baseRole: 'staff',
    grant: {
      Jobs: ['View'],
      Delivery: ['View', 'Update Status']
    }
  }
];

/** The permission list for a preset: Dashboard, each module and its actions. */
function presetPermissions(preset) {
  const perms = ['Dashboard'];
  for (const [module, actions] of Object.entries(preset.grant)) {
    perms.push(module);
    if (actions === ALL) perms.push(...actionsForModule(module));
    else perms.push(...actions.map((a) => actionName(module, a)));
  }
  return [...new Set(perms)];
}

module.exports = {
  ROLE_PRESETS: PRESETS.map(({ grant, ...rest }) => ({ ...rest, canViewAllData: rest.canViewAllData === true, permissions: presetPermissions({ grant }) }))
};
