/**
 * Shapes and labels for User Management: logins, roles (named permission sets)
 * and teams. Backend: routes/users.js, routes/accessRoles.js, routes/teams.js.
 */
import { PERMISSION_TREE } from "@/lib/permissions";

export type BaseRole = "manager" | "accountant" | "staff";

export interface TeamRef {
  _id: string;
  name: string;
}

export interface ManagedUser {
  _id: string;
  fullName: string;
  email: string;
  phone?: string;
  role: BaseRole | "admin" | string;
  status?: "invited" | "active";
  isActive?: boolean;
  department?: string;
  permissions: string[];
  canViewAllData?: boolean;
  accessRole?: string | null;
  accessRoleName?: string | null;
  teams: TeamRef[];
  lastLogin?: string;
  createdAt?: string;
  invitation?: { expiresAt?: string; invitedAt?: string };
}

export interface AccessRoleRecord {
  _id: string;
  name: string;
  description?: string;
  baseRole: BaseRole;
  permissions: string[];
  canViewAllData: boolean;
  preset?: boolean;
  userCount: number;
  /** Whether the signed-in login may save or delete this role. */
  editable: boolean;
  updatedAt?: string;
}

export interface TeamRecord {
  _id: string;
  name: string;
  description?: string;
  members: { _id: string; fullName: string; email?: string; role?: string; accessRoleName?: string | null; isActive?: boolean; status?: string }[];
  lead?: { _id: string; fullName: string } | null;
}

export const BASE_ROLES: Record<BaseRole, { label: string; description: string }> = {
  staff: { label: "Staff", description: "Sees only their own tasks and the records they create." },
  manager: { label: "Manager", description: "Can be allowed to see everyone's records and manage the team." },
  accountant: { label: "Accountant", description: "Can be allowed to see everyone's billing records." }
};

/** Roles that may be allowed to see all staff data (staff never can). */
export const VIEW_ALL_ROLES: BaseRole[] = ["manager", "accountant"];

/**
 * How each permission module appears to people: the name used in the sidebar
 * and a one-line hint. The permission names themselves are unchanged.
 */
export const MODULE_INFO: Record<string, { label: string; hint: string }> = {
  Dashboard: { label: "Dashboard", hint: "Home screen; always on" },
  Calendar: { label: "Calendar", hint: "Shop calendar and events" },
  Customers: { label: "Customers", hint: "Customer records and history" },
  Quotations: { label: "Quotations & estimator", hint: "Print estimates and quotes" },
  "Customer Portal": { label: "Customer Portal", hint: "Personal links for customers" },
  "Emergency Orders": { label: "Rush Orders", hint: "Urgent orders" },
  Discounts: { label: "Discounts", hint: "Discount rules and customer pricing" },
  Jobs: { label: "Job Tickets", hint: "Jobs and the production board" },
  "Walk-In Jobs": { label: "Counter Jobs", hint: "Walk-in jobs at the counter" },
  "Job Proofing": { label: "Proofing", hint: "Proofs sent for approval" },
  "Designer Timer": { label: "Design Time", hint: "Time logged on design work" },
  Delivery: { label: "Dispatch", hint: "Deliveries and their status" },
  Invoicing: { label: "Invoices", hint: "Invoices and their payments" },
  "Invoicing (View No GST)": { label: "Older No GST bills", hint: "See bills marked No GST before GST was removed" },
  Payments: { label: "Payments", hint: "Money received from customers" },
  "Payment Reminders": { label: "Payment Reminders", hint: "Reminders for unpaid invoices" },
  Accounts: { label: "Accounts", hint: "Cash, bank and ledger" },
  Reports: { label: "Reports", hint: "Monthly sales and design charges" },
  "Cost & Profit": { label: "Cost & Profit", hint: "Job costing and margins" },
  Inventory: { label: "Paper & Stock", hint: "Stock, units and categories" },
  Vendors: { label: "Suppliers", hint: "Supplier records" },
  "Purchase Bills": { label: "Purchase Bills", hint: "Bills from suppliers" },
  "HSN Codes": { label: "HSN Codes", hint: "Goods tax codes" },
  "SAC Codes": { label: "SAC Codes", hint: "Service tax codes" },
  "Staff & Tasks": { label: "Staff & Tasks", hint: "Assign tasks, schedules, team overview" },
  "Human Resources": { label: "Employees & HR", hint: "Employees, attendance, leave" },
  Payroll: { label: "Payroll", hint: "Salaries and payslips" },
  WhatsApp: { label: "WhatsApp", hint: "Messages to customers" },
  "User Management": { label: "Users & Roles", hint: "Logins, roles and teams" },
  Settings: { label: "Settings", hint: "Business settings" },
  "Activity Log": { label: "Activity Log", hint: "Who did what, when" }
};

/** Modules grouped the way the sidebar is. */
export const PERMISSION_AREAS: { label: string; modules: string[] }[] = [
  { label: "Overview", modules: ["Dashboard", "Calendar"] },
  { label: "Sales & estimating", modules: ["Customers", "Quotations", "Customer Portal", "Emergency Orders", "Discounts"] },
  { label: "Production", modules: ["Jobs", "Walk-In Jobs", "Job Proofing", "Designer Timer", "Delivery"] },
  { label: "Billing & finance", modules: ["Invoicing", "Invoicing (View No GST)", "Payments", "Payment Reminders", "Accounts", "Reports", "Cost & Profit"] },
  { label: "Materials & purchase", modules: ["Inventory", "Vendors", "Purchase Bills", "HSN Codes", "SAC Codes"] },
  { label: "People", modules: ["Staff & Tasks", "Human Resources", "Payroll"] },
  { label: "Admin & setup", modules: ["User Management", "Settings", "Activity Log", "WhatsApp"] }
];

// Any module added to the catalogue later still shows up, under "Other".
const grouped = new Set(PERMISSION_AREAS.flatMap((a) => a.modules));
const ungrouped = PERMISSION_TREE.map((g) => g.module).filter((m) => !grouped.has(m));
if (ungrouped.length) PERMISSION_AREAS.push({ label: "Other", modules: ungrouped });

export const moduleLabel = (module: string) => MODULE_INFO[module]?.label || module;

/** The sections a permission list opens, in sidebar order, Dashboard left out. */
export function grantedModules(permissions: string[]): string[] {
  const set = new Set(permissions);
  return PERMISSION_AREAS.flatMap((a) => a.modules).filter((m) => m !== "Dashboard" && set.has(m));
}

export type UserState = "owner" | "invited" | "inactive" | "active";

/** Filters on the Users tab. */
export interface UserFilters {
  q: string;
  role: string; // "all" | role id | "custom" | "owner"
  team: string; // "all" | team id
  status: string; // "all" | "active" | "invited" | "inactive"
}

export const NO_FILTERS: UserFilters = { q: "", role: "all", team: "all", status: "all" };

export function userState(u: ManagedUser): UserState {
  if (u.role === "admin") return "owner";
  if (u.status === "invited") return "invited";
  if (u.isActive === false) return "inactive";
  return "active";
}

export const initials = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";
