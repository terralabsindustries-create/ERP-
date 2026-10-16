import {
  LayoutDashboard,
  SquareKanban,
  Calendar,
  Users,
  Calculator,
  ClipboardList,
  Zap,
  Ticket,
  Store,
  ScanEye,
  Timer,
  Truck,
  FileText,
  Bell,
  Landmark,
  Layers,
  Factory,
  ReceiptText,
  UserCog,
  Contact,
  CalendarCheck,
  CalendarOff,
  BadgeIndianRupee,
  Hash,
  Percent,
  BadgePercent,
  MessageSquare,
  Receipt,
  Wallet,
  BarChart3,
  Link2,
  UsersRound,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Shown when the login has this permission (or any one of several). */
  permission?: string | string[];
  /** Only for the admin and logins with "Can view all staff data" (the API enforces the same). */
  orgViewOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The app's navigation, ordered the way a print job flows: win the work,
 * produce it, bill it, keep the shop stocked and staffed.
 * Each item is shown only to users holding its permission.
 */
export const NAVIGATION: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", href: "/", icon: LayoutDashboard, permission: "Dashboard" },
      { title: "Production Board", href: "/production", icon: SquareKanban, permission: "Jobs" },
      { title: "Calendar", href: "/calendar", icon: Calendar, permission: "Calendar" },
    ],
  },
  {
    label: "Sales & Estimating",
    items: [
      { title: "Customers", href: "/customers", icon: Users, permission: "Customers" },
      { title: "Print Estimator", href: "/estimator", icon: Calculator, permission: "Quotations" },
      { title: "Quotations", href: "/quotations", icon: ClipboardList, permission: "Quotations" },
      { title: "Discounts", href: "/discounts", icon: BadgePercent, permission: "Discounts" },
      { title: "Customer Portal", href: "/portal", icon: Link2, permission: "Customer Portal" },
      { title: "Rush Orders", href: "/emergency-orders", icon: Zap, permission: "Emergency Orders" },
    ],
  },
  {
    label: "Production",
    items: [
      { title: "Job Tickets", href: "/jobs", icon: Ticket, permission: "Jobs" },
      { title: "Counter Jobs", href: "/walk-in-jobs", icon: Store, permission: "Walk-In Jobs" },
      { title: "Proofing", href: "/proofing", icon: ScanEye, permission: "Job Proofing" },
      { title: "Design Time", href: "/designer-timer", icon: Timer, permission: "Designer Timer" },
      { title: "Dispatch", href: "/delivery", icon: Truck, permission: "Delivery" },
    ],
  },
  {
    label: "Billing & Finance",
    items: [
      { title: "Invoices", href: "/invoices", icon: FileText, permission: "Invoicing" },
      { title: "Payments", href: "/payments", icon: Wallet, permission: "Payments" },
      { title: "Payment Reminders", href: "/payment-reminders", icon: Bell, permission: "Payment Reminders" },
      { title: "Accounts", href: "/accounts", icon: Landmark, permission: "Accounts" },
      { title: "Cost & Profit", href: "/costs", icon: TrendingUp, permission: "Cost & Profit" },
      { title: "Reports", href: "/reports", icon: BarChart3, permission: "Reports" },
    ],
  },
  {
    label: "Materials & Purchase",
    items: [
      { title: "Paper & Stock", href: "/inventory", icon: Layers, permission: "Inventory" },
      { title: "Suppliers", href: "/vendors", icon: Factory, permission: "Vendors" },
      { title: "Purchase Orders", href: "/purchase-orders", icon: ShoppingCart, permission: ["Inventory", "Purchase Bills", "Vendors"] },
      { title: "Purchase Bills", href: "/purchase-bills", icon: ReceiptText, permission: "Purchase Bills" },
    ],
  },
  {
    label: "People",
    items: [
      { title: "Team Overview", href: "/team", icon: UsersRound, permission: "Staff & Tasks", orgViewOnly: true },
      { title: "Staff & Tasks", href: "/staff", icon: UserCog, permission: "Staff & Tasks" },
      { title: "Employees", href: "/employees", icon: Contact, permission: "Human Resources" },
      { title: "Attendance", href: "/attendance", icon: CalendarCheck, permission: "Human Resources" },
      { title: "Leave Requests", href: "/leaves", icon: CalendarOff, permission: "Human Resources" },
      { title: "Payroll", href: "/payroll", icon: BadgeIndianRupee, permission: "Payroll" },
    ],
  },
  {
    label: "Setup",
    items: [
      { title: "Users & Roles", href: "/users", icon: ShieldCheck, permission: "User Management" },
      { title: "WhatsApp", href: "/whatsapp", icon: MessageSquare, permission: "WhatsApp" },
      { title: "HSN Codes", href: "/hsn-codes", icon: Hash, permission: "HSN Codes" },
      { title: "SAC Codes", href: "/sac-codes", icon: Percent, permission: "SAC Codes" },
    ],
  },
];

/** Pages reachable from the user menu rather than the sidebar. */
const OTHER_PAGES: Record<string, { group: string; title: string }> = {
  "/settings": { group: "Account", title: "Settings" },
  "/activity-log": { group: "Account", title: "Activity Log" },
};

/** The group and page title for a path, for the header breadcrumb. */
export function findPage(pathname: string): { group: string; title: string } | null {
  for (const group of NAVIGATION) {
    const item = group.items.find((i) => i.href === pathname);
    if (item) return { group: group.label, title: item.title };
  }
  if (pathname.startsWith("/tasks/")) return { group: "People", title: "Task" };
  return OTHER_PAGES[pathname] || null;
}
