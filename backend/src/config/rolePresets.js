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

/**
 * Bumped when a starter role changes, so businesses that already have the
 * starter roles get the change once (utils/upgradePresetRoles.js) without
 * undoing edits the owner made since.
 */
const PRESET_VERSION = 2;

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
    description: 'Job tickets, quotations, invoices, payments and reminders, purchase bills, accounts, reports, attendance and WhatsApp. Sees everyone\'s billing records; the profit & loss report stays with the owner.',
    baseRole: 'accountant',
    canViewAllData: true,
    grant: {
      Customers: ['View'],
      Jobs: ['View'],
      Quotations: ['View', 'Convert to Invoice'],
      Invoicing: ALL,
      'Invoicing (View No GST)': ALL,
      Payments: ALL,
      'Payment Reminders': ALL,
      'Purchase Bills': ALL,
      Vendors: ['View'],
      Accounts: ALL,
      Reports: ALL,
      Attendance: ['View'],
      WhatsApp: ALL,
      'HSN Codes': ['View'],
      'SAC Codes': ['View']
    },
    // What upgradePresetRoles changes on an Accountant role made from an
    // earlier version of this preset.
    upgrades: {
      2: {
        add: { Jobs: ['View'], Quotations: ['View', 'Convert to Invoice'], Attendance: ['View'], WhatsApp: ALL },
        remove: ['Cost & Profit']
      }
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

/** The permissions a grant ({ module: actions | ALL }) stands for. */
function grantPermissions(grant) {
  const perms = [];
  for (const [module, actions] of Object.entries(grant)) {
    perms.push(module);
    if (actions === ALL) perms.push(...actionsForModule(module));
    else perms.push(...actions.map((a) => actionName(module, a)));
  }
  return perms;
}

/** The permission list for a preset: Dashboard, each module and its actions. */
const presetPermissions = (preset) => [...new Set(['Dashboard', ...grantPermissions(preset.grant)])];

/**
 * The changes to apply to a role made from preset `name` at `fromVersion`, as
 * permission lists: { add, remove }. Removing a module removes its actions.
 */
function presetUpgrade(name, fromVersion) {
  const preset = PRESETS.find((p) => p.name === name);
  const add = [];
  const remove = [];
  for (let v = (fromVersion || 1) + 1; v <= PRESET_VERSION; v++) {
    const step = preset?.upgrades?.[v];
    if (!step) continue;
    add.push(...grantPermissions(step.add || {}));
    for (const module of step.remove || []) remove.push(module, ...actionsForModule(module));
  }
  return { add, remove };
}

module.exports = {
  PRESET_VERSION,
  presetUpgrade,
  ROLE_PRESETS: PRESETS.map(({ grant, upgrades, ...rest }) => ({
    ...rest,
    canViewAllData: rest.canViewAllData === true,
    permissions: presetPermissions({ grant }),
    presetVersion: PRESET_VERSION
  }))
};
