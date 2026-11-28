# Endpoint-to-permission verification matrix

Generated from the live Express app by `backend/scripts/audit/endpoint-matrix.js` (re-run it; do not hand-edit the table). Columns: the mount's `moduleGuard` requirement for that method, any route-level `requirePermission`, whether the mount sits behind `protect`, and a **static heuristic** for a tenant-scope reference in the handler (`REVIEW` = none found, needs a human look; it is not proof of a hole). Behavioural proof is in `backend/tests/tenant-isolation.test.js` (133 cases: another business's admin names A's id on every financial/inventory/job/payroll/HR/user mutation → 403/404 and A's record is unchanged).

## Findings and fixes
| Finding | Fix |
|---|---|
| Legacy module-only grants carried every action, including Delete, Delete User, Create Login, Edit Permissions, Correct Balance, Credit & Debit Notes, Process Payroll, Adjust Stock | `EXPLICIT_ONLY_ACTIONS` in `requirePermission.js`: those must now be granted explicitly. **Behaviour change:** old logins that relied on this lose those actions until re-saved with explicit actions. Needs business sign-off before release. |
| `DELETE /activity-log/:id` let admins delete audit rows | Always 405 `AUDIT_IMMUTABLE`; model hooks refuse every update/delete path |
| 23 unauthenticated routes | All are intended-public (login/register/OTP/reset, invitation, portal token routes, proof-share signed links, WhatsApp webhook, `/email/test-public` which 404s outside development). None mutate tenant data without their own token/signature |
| Mutating routes flagged REVIEW (77) | Spot-checked by the isolation test for all financial/inventory/job/payroll/HR/user kinds. Remaining ones are personal/utility routes (tasks, time entries, notifications, email/WhatsApp send, portal) — **not individually proven; listed as remaining work** |
| No reconciliation permission | New module `Reconciliation` (View / Resolve) |

## Not covered
Tasks/time-entry/notification personal routes, WhatsApp/email send routes, and the portal are scoped by their own logic and only partly exercised by the isolation test.

## Matrix
| Method | Path | Module guard requires | Route-level permission | Auth | Tenant-scope reference in handler |
|---|---|---|---|---|---|
| GET | `/api/access-roles` | User Management | — | yes | yes |
| POST | `/api/access-roles` | User Management: Edit Permissions | — | yes | yes |
| DELETE | `/api/access-roles/:id` | User Management: Edit Permissions | — | yes | yes |
| PUT | `/api/access-roles/:id` | User Management: Edit Permissions | — | yes | yes |
| GET | `/api/accounts/balances` | Accounts | — | yes | yes |
| GET | `/api/accounts/cheques` | Accounts | — | yes | yes |
| GET | `/api/accounts/ledger` | Accounts | — | yes | yes |
| GET | `/api/accounts/reports/export` | Accounts | — | yes | yes |
| GET | `/api/accounts/reports/summary` | Accounts | — | yes | yes |
| GET | `/api/accounts/stats/period` | Accounts | — | yes | yes |
| GET | `/api/accounts/stats/summary` | Accounts | — | yes | yes |
| GET | `/api/accounts/transactions` | Accounts | — | yes | yes |
| POST | `/api/accounts/transactions` | Accounts: Create & Edit | Accounts: Create & Edit | yes | yes |
| DELETE | `/api/accounts/transactions/:id` | Accounts: Delete | Accounts: Delete | yes | yes |
| PUT | `/api/accounts/transactions/:id` | Accounts: Create & Edit | Accounts: Create & Edit | yes | yes |
| GET | `/api/activity-log` | Activity Log | — | yes | REVIEW |
| DELETE | `/api/activity-log/:id` | custom rule | — | yes | REVIEW |
| GET | `/api/activity-log/:id` | Activity Log | — | yes | yes |
| GET | `/api/activity-log/critical` | Activity Log | — | yes | yes |
| GET | `/api/activity-log/entity/:entityType/:entityId` | Activity Log | — | yes | yes |
| GET | `/api/activity-log/export` | Activity Log | Activity Log: Export | yes | REVIEW |
| GET | `/api/activity-log/recent` | Activity Log | — | yes | yes |
| GET | `/api/activity-log/stats/summary` | Activity Log | — | yes | yes |
| GET | `/api/activity-log/user/:userId` | Activity Log | — | yes | yes |
| POST | `/api/auth/forgot-password` | — | — | NO | REVIEW |
| GET | `/api/auth/invitation/:token` | — | — | NO | REVIEW |
| POST | `/api/auth/invitation/:token/accept` | — | — | NO | REVIEW |
| POST | `/api/auth/login` | — | — | NO | REVIEW |
| POST | `/api/auth/logout` | — | — | yes | REVIEW |
| GET | `/api/auth/me` | — | — | yes | REVIEW |
| PUT | `/api/auth/password` | — | — | yes | REVIEW |
| PUT | `/api/auth/profile` | — | — | yes | REVIEW |
| POST | `/api/auth/register` | — | — | NO | yes |
| POST | `/api/auth/reset-password` | — | — | NO | REVIEW |
| POST | `/api/auth/send-otp` | — | — | NO | REVIEW |
| GET | `/api/auth/users` | — | — | yes | yes |
| POST | `/api/auth/verify-otp` | — | — | NO | yes |
| GET | `/api/calendar/events` | Calendar | — | yes | yes |
| POST | `/api/calendar/events` | Calendar: Create & Edit | — | yes | yes |
| DELETE | `/api/calendar/events/:id` | Calendar: Delete | — | yes | yes |
| GET | `/api/calendar/events/:id` | Calendar | — | yes | yes |
| PUT | `/api/calendar/events/:id` | Calendar: Create & Edit | — | yes | yes |
| PUT | `/api/calendar/events/:id/status` | Calendar: Create & Edit | — | yes | yes |
| GET | `/api/calendar/events/overdue` | Calendar | — | yes | REVIEW |
| GET | `/api/calendar/events/range/:startDate/:endDate` | Calendar | — | yes | REVIEW |
| GET | `/api/calendar/events/upcoming` | Calendar | — | yes | REVIEW |
| GET | `/api/calendar/stats/summary` | Calendar | — | yes | yes |
| GET | `/api/categories` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| POST | `/api/categories` | Inventory: Create & Edit | — | yes | yes |
| DELETE | `/api/categories/:id` | Inventory: Create & Edit | — | yes | yes |
| GET | `/api/categories/:id` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| PUT | `/api/categories/:id` | Inventory: Create & Edit | — | yes | yes |
| PATCH | `/api/categories/:id/deactivate` | Inventory: Create & Edit | — | yes | yes |
| GET | `/api/costs` | Cost & Profit | — | yes | REVIEW |
| POST | `/api/costs` | Cost & Profit | — | yes | yes |
| DELETE | `/api/costs/:id` | Cost & Profit | — | yes | REVIEW |
| GET | `/api/costs/:id` | Cost & Profit | — | yes | REVIEW |
| PUT | `/api/costs/:id` | Cost & Profit | — | yes | yes |
| GET | `/api/costs/jobs` | Cost & Profit | — | yes | yes |
| GET | `/api/costs/stats/summary` | Cost & Profit | — | yes | REVIEW |
| GET | `/api/credit-notes` | Invoicing or Accounts or Reports | — | yes | REVIEW |
| POST | `/api/credit-notes` | Invoicing: Credit & Debit Notes | — | yes | REVIEW |
| DELETE | `/api/credit-notes/:id` | Invoicing: Credit & Debit Notes | — | yes | REVIEW |
| GET | `/api/credit-notes/:id` | Invoicing or Accounts or Reports | — | yes | REVIEW |
| PUT | `/api/credit-notes/:id` | Invoicing: Credit & Debit Notes | — | yes | REVIEW |
| PATCH | `/api/credit-notes/:id/cancel` | Invoicing: Credit & Debit Notes | — | yes | REVIEW |
| PATCH | `/api/credit-notes/:id/issue` | Invoicing: Credit & Debit Notes | — | yes | REVIEW |
| GET | `/api/credit-notes/:id/pdf` | Invoicing or Accounts or Reports | — | yes | REVIEW |
| GET | `/api/credit-notes/invoice/:invoiceId/lines` | Invoicing or Accounts or Reports | — | yes | REVIEW |
| GET | `/api/customers` | Customers or Jobs or Quotations or Invoicing or Walk-In Jobs or Payments or Customer Portal or Delivery or Emergency Orders or Payment Reminders or Accounts | — | yes | yes |
| POST | `/api/customers` | Customers: Create & Edit | Customers: Create & Edit | yes | yes |
| DELETE | `/api/customers/:id` | Customers: Delete | Customers: Delete | yes | REVIEW |
| GET | `/api/customers/:id` | Customers or Jobs or Quotations or Invoicing or Walk-In Jobs or Payments or Customer Portal or Delivery or Emergency Orders or Payment Reminders or Accounts | — | yes | yes |
| PUT | `/api/customers/:id` | Customers: Create & Edit | Customers: Create & Edit | yes | yes |
| GET | `/api/customers/:id/jobs` | Customers or Jobs or Quotations or Invoicing or Walk-In Jobs or Payments or Customer Portal or Delivery or Emergency Orders or Payment Reminders or Accounts | — | yes | yes |
| PATCH | `/api/customers/:id/reactivate` | Customers: Create & Edit | Customers: Create & Edit | yes | REVIEW |
| POST | `/api/customers/:id/update-stats` | Customers: Create & Edit or Invoicing: Create & Edit or Payments: Record Payment | — | yes | yes |
| POST | `/api/customers/bulk` | Customers: Create & Edit | — | yes | yes |
| GET | `/api/customers/stats/summary` | Customers or Jobs or Quotations or Invoicing or Walk-In Jobs or Payments or Customer Portal or Delivery or Emergency Orders or Payment Reminders or Accounts | — | yes | yes |
| GET | `/api/dashboard/monthly-target` | any signed-in user | — | yes | REVIEW |
| PUT | `/api/dashboard/monthly-target` | any signed-in user | — | yes | REVIEW |
| GET | `/api/dashboard/stats` | any signed-in user | — | yes | yes |
| GET | `/api/deliveries` | Delivery | — | yes | REVIEW |
| POST | `/api/deliveries` | Delivery: Create & Edit | — | yes | yes |
| DELETE | `/api/deliveries/:id` | Delivery: Create & Edit | — | yes | REVIEW |
| GET | `/api/deliveries/:id` | Delivery | — | yes | REVIEW |
| PUT | `/api/deliveries/:id` | Delivery: Create & Edit | — | yes | REVIEW |
| PUT | `/api/deliveries/:id/status` | Delivery: Update Status | — | yes | REVIEW |
| GET | `/api/deliveries/stats/summary` | Delivery | — | yes | REVIEW |
| POST | `/api/discounts/calculate` | Discounts or Invoicing or Quotations | — | yes | yes |
| GET | `/api/discounts/customer-pricing` | Discounts or Invoicing or Quotations | — | yes | yes |
| POST | `/api/discounts/customer-pricing` | Discounts: Create & Edit | — | yes | yes |
| DELETE | `/api/discounts/customer-pricing/:id` | Discounts: Delete | — | yes | yes |
| PUT | `/api/discounts/customer-pricing/:id` | Discounts: Create & Edit | — | yes | yes |
| GET | `/api/discounts/rules` | Discounts or Invoicing or Quotations | — | yes | yes |
| POST | `/api/discounts/rules` | Discounts: Create & Edit | — | yes | yes |
| DELETE | `/api/discounts/rules/:id` | Discounts: Delete | — | yes | yes |
| PUT | `/api/discounts/rules/:id` | Discounts: Create & Edit | — | yes | yes |
| PATCH | `/api/discounts/rules/:id/active` | Discounts: Create & Edit | — | yes | yes |
| GET | `/api/discounts/stats/summary` | Discounts or Invoicing or Quotations | — | yes | yes |
| POST | `/api/email/send` | — | — | yes | REVIEW |
| POST | `/api/email/send-staff-credentials` | — | — | yes | REVIEW |
| POST | `/api/email/test` | — | — | yes | REVIEW |
| POST | `/api/email/test-public` | — | — | NO | REVIEW |
| POST | `/api/embedded-signup/exchange-token` | Settings: Edit | — | yes | REVIEW |
| DELETE | `/api/embedded-signup/reset` | Settings: Edit | — | yes | REVIEW |
| GET | `/api/embedded-signup/status` | WhatsApp or Settings | — | yes | REVIEW |
| GET | `/api/emergency-orders` | Emergency Orders | — | yes | REVIEW |
| POST | `/api/emergency-orders` | Emergency Orders: Create & Edit | — | yes | yes |
| DELETE | `/api/emergency-orders/:id` | Emergency Orders: Create & Edit | — | yes | REVIEW |
| GET | `/api/emergency-orders/:id` | Emergency Orders | — | yes | REVIEW |
| PUT | `/api/emergency-orders/:id` | Emergency Orders: Create & Edit | — | yes | REVIEW |
| POST | `/api/emergency-orders/:id/convert` | Emergency Orders: Create & Edit | — | yes | yes |
| PUT | `/api/emergency-orders/:id/status` | Emergency Orders: Create & Edit | — | yes | REVIEW |
| GET | `/api/emergency-orders/stats/summary` | Emergency Orders | — | yes | REVIEW |
| GET | `/api/files` | Jobs or Customers or Job Proofing | — | yes | yes |
| DELETE | `/api/files/:fileId` | Jobs: Create & Edit or Customers: Create & Edit or Job Proofing | — | yes | yes |
| GET | `/api/files/:id` | Jobs or Customers or Job Proofing | — | yes | yes |
| PUT | `/api/files/:id` | Jobs: Create & Edit or Customers: Create & Edit or Job Proofing | — | yes | yes |
| GET | `/api/files/:id/download` | Jobs or Customers or Job Proofing | — | yes | yes |
| GET | `/api/files/stats/summary` | Jobs or Customers or Job Proofing | — | yes | REVIEW |
| POST | `/api/files/upload` | Jobs: Create & Edit or Customers: Create & Edit or Job Proofing | — | yes | yes |
| GET | `/api/gst-reports` | Reports or Accounts | — | yes | REVIEW |
| GET | `/api/gst-reports/export` | Reports or Accounts | — | yes | REVIEW |
| GET | `/api/hr/attendance` | Human Resources or Attendance | — | yes | yes |
| POST | `/api/hr/attendance` | Human Resources: Create & Edit or Attendance: Mark Attendance | — | yes | yes |
| DELETE | `/api/hr/attendance/:id` | Human Resources: Create & Edit or Attendance: Mark Attendance | — | yes | yes |
| POST | `/api/hr/attendance/bulk` | Human Resources: Create & Edit or Attendance: Mark Attendance | — | yes | yes |
| GET | `/api/hr/attendance/summary` | Human Resources or Attendance | — | yes | yes |
| GET | `/api/hr/employees` | Human Resources or Payroll or Attendance | — | yes | yes |
| POST | `/api/hr/employees` | Human Resources: Create & Edit | Human Resources: Create & Edit | yes | yes |
| DELETE | `/api/hr/employees/:id` | Human Resources: Delete | Human Resources: Delete | yes | yes |
| GET | `/api/hr/employees/:id` | Human Resources or Payroll or Attendance | — | yes | yes |
| PUT | `/api/hr/employees/:id` | Human Resources: Create & Edit | Human Resources: Create & Edit | yes | yes |
| GET | `/api/hr/employees/stats/summary` | Human Resources or Payroll or Attendance | — | yes | yes |
| GET | `/api/hr/leaves` | Human Resources | — | yes | yes |
| POST | `/api/hr/leaves` | Human Resources: Create & Edit | — | yes | yes |
| DELETE | `/api/hr/leaves/:id` | Human Resources: Create & Edit | — | yes | yes |
| PATCH | `/api/hr/leaves/:id/status` | Human Resources: Manage Leaves | — | yes | yes |
| GET | `/api/hr/payroll` | Payroll | — | yes | yes |
| DELETE | `/api/hr/payroll/:id` | Payroll: Process Payroll | — | yes | yes |
| PUT | `/api/hr/payroll/:id` | Payroll: Process Payroll | — | yes | yes |
| PATCH | `/api/hr/payroll/:id/pay` | Payroll: Process Payroll | — | yes | yes |
| GET | `/api/hr/payroll/:id/payslip` | Payroll | — | yes | yes |
| POST | `/api/hr/payroll/generate` | Payroll: Process Payroll | — | yes | yes |
| GET | `/api/hr/payroll/stats/summary` | Payroll | — | yes | yes |
| GET | `/api/hsn-codes` | HSN Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| POST | `/api/hsn-codes` | HSN Codes: Create & Edit | — | yes | yes |
| DELETE | `/api/hsn-codes/:id` | HSN Codes: Delete | — | yes | yes |
| GET | `/api/hsn-codes/:id` | HSN Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| PUT | `/api/hsn-codes/:id` | HSN Codes: Create & Edit | — | yes | yes |
| POST | `/api/hsn-codes/bulk-import` | HSN Codes: Create & Edit | — | yes | yes |
| GET | `/api/hsn-codes/categories/list` | HSN Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| GET | `/api/hsn-codes/gst-rates/summary` | HSN Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| GET | `/api/inventory` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| POST | `/api/inventory` | Inventory: Create & Edit | Inventory: Create & Edit | yes | yes |
| DELETE | `/api/inventory/:id` | Inventory: Delete | Inventory: Delete | yes | yes |
| GET | `/api/inventory/:id` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| PUT | `/api/inventory/:id` | Inventory: Create & Edit | Inventory: Create & Edit | yes | yes |
| POST | `/api/inventory/:id/adjust` | Inventory: Adjust Stock | Inventory: Adjust Stock | yes | yes |
| GET | `/api/inventory/analytics` | Inventory | — | yes | yes |
| POST | `/api/inventory/bulk-update` | Inventory: Create & Edit | Inventory: Create & Edit | yes | yes |
| GET | `/api/inventory/movements` | Inventory | — | yes | REVIEW |
| GET | `/api/inventory/reports/category-comparison` | Inventory | — | yes | yes |
| GET | `/api/inventory/reports/critical-stock` | Inventory | — | yes | yes |
| GET | `/api/inventory/reports/low-stock` | Inventory | — | yes | yes |
| GET | `/api/inventory/reports/movement-summary` | Inventory | — | yes | yes |
| GET | `/api/inventory/reports/valuation` | Inventory | — | yes | yes |
| GET | `/api/inventory/stats` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| GET | `/api/invoices` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| POST | `/api/invoices` | Invoicing: Create & Edit | Invoicing: Create & Edit | yes | yes |
| DELETE | `/api/invoices/:id` | Invoicing: Delete | Invoicing: Delete | yes | yes |
| GET | `/api/invoices/:id` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| PUT | `/api/invoices/:id` | Invoicing: Create & Edit | Invoicing: Create & Edit | yes | yes |
| PATCH | `/api/invoices/:id/cancel` | Invoicing: Create & Edit | — | yes | yes |
| PATCH | `/api/invoices/:id/issue` | Invoicing: Create & Edit | Invoicing: Create & Edit | yes | yes |
| GET | `/api/invoices/:id/movements` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| PATCH | `/api/invoices/:id/payment-status` | Invoicing: Correct Balance | Invoicing: Correct Balance | yes | yes |
| GET | `/api/invoices/:id/pdf` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| GET | `/api/invoices/:id/print-data` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| POST | `/api/invoices/:id/send-email` | Invoicing: Send Email | Invoicing: Send Email | yes | yes |
| POST | `/api/invoices/:id/send-whatsapp` | WhatsApp: Send Messages | WhatsApp: Send Messages | yes | yes |
| GET | `/api/invoices/pending-jobs` | Invoicing or Invoicing (View No GST) or Payments or Accounts | Invoicing: Create & Edit | yes | yes |
| GET | `/api/invoices/stats/summary` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| GET | `/api/invoices/stats/views` | Invoicing or Invoicing (View No GST) or Payments or Accounts | — | yes | yes |
| GET | `/api/jobs` | Jobs or Invoicing or Quotations or Staff & Tasks or Designer Timer or Delivery or Job Proofing or Walk-In Jobs or Emergency Orders or Calendar | — | yes | yes |
| POST | `/api/jobs` | Jobs: Create & Edit | Jobs: Create & Edit | yes | yes |
| DELETE | `/api/jobs/:id` | Jobs: Delete | Jobs: Delete | yes | yes |
| GET | `/api/jobs/:id` | Jobs or Invoicing or Quotations or Staff & Tasks or Designer Timer or Delivery or Job Proofing or Walk-In Jobs or Emergency Orders or Calendar | — | yes | REVIEW |
| PUT | `/api/jobs/:id` | Jobs: Create & Edit | Jobs: Create & Edit | yes | yes |
| POST | `/api/jobs/:id/assign` | Jobs: Create & Edit | — | yes | yes |
| POST | `/api/jobs/:id/update-flow-stage` | Jobs: Change Status | — | yes | yes |
| POST | `/api/jobs/:id/update-status` | Jobs: Change Status | Jobs: Change Status | yes | yes |
| GET | `/api/jobs/board` | Jobs or Invoicing or Quotations or Staff & Tasks or Designer Timer or Delivery or Job Proofing or Walk-In Jobs or Emergency Orders or Calendar | — | yes | REVIEW |
| GET | `/api/jobs/calendar-status` | Jobs or Invoicing or Quotations or Staff & Tasks or Designer Timer or Delivery or Job Proofing or Walk-In Jobs or Emergency Orders or Calendar | — | yes | REVIEW |
| GET | `/api/jobs/mine` | any signed-in user | — | yes | yes |
| GET | `/api/jobs/staff/stats` | any signed-in user | — | yes | REVIEW |
| GET | `/api/jobs/stats/dashboard` | Jobs | — | yes | yes |
| GET | `/api/jobs/stats/summary` | Jobs or Invoicing or Quotations or Staff & Tasks or Designer Timer or Delivery or Job Proofing or Walk-In Jobs or Emergency Orders or Calendar | — | yes | REVIEW |
| GET | `/api/notifications` | any signed-in user | — | yes | REVIEW |
| POST | `/api/notifications/:id/read` | any signed-in user | — | yes | REVIEW |
| POST | `/api/notifications/read-all` | any signed-in user | — | yes | REVIEW |
| GET | `/api/payment-accounts` | Accounts or Payments or Invoicing or Walk-In Jobs | — | yes | REVIEW |
| POST | `/api/payment-accounts` | Accounts: Create & Edit | Accounts: Create & Edit | yes | yes |
| DELETE | `/api/payment-accounts/:id` | Accounts: Delete | Accounts: Delete | yes | REVIEW |
| GET | `/api/payment-accounts/:id` | Accounts or Payments or Invoicing or Walk-In Jobs | — | yes | REVIEW |
| PUT | `/api/payment-accounts/:id` | Accounts: Create & Edit | Accounts: Create & Edit | yes | yes |
| POST | `/api/payment-accounts/:id/adjust` | Accounts: Create & Edit | Accounts: Create & Edit | yes | yes |
| GET | `/api/payment-accounts/:id/ledger` | Accounts or Payments or Invoicing or Walk-In Jobs | Accounts | yes | yes |
| GET | `/api/payment-accounts/summary` | Accounts or Payments or Invoicing or Walk-In Jobs | Accounts | yes | yes |
| GET | `/api/payment-reminders` | Payment Reminders | — | yes | yes |
| GET | `/api/payment-reminders/overdue-invoices` | Payment Reminders | — | yes | yes |
| POST | `/api/payment-reminders/send-bulk` | Payment Reminders: Send Reminders | — | yes | yes |
| POST | `/api/payment-reminders/send/:invoiceId` | Payment Reminders: Send Reminders | — | yes | yes |
| GET | `/api/payment-reminders/settings` | Payment Reminders | — | yes | REVIEW |
| PUT | `/api/payment-reminders/settings` | Settings: Edit | — | yes | REVIEW |
| GET | `/api/payment-reminders/stats` | Payment Reminders | — | yes | yes |
| GET | `/api/payments` | Payments | — | yes | REVIEW |
| POST | `/api/payments` | Payments: Record Payment or Invoicing: Record Payment or Accounts: Create & Edit | — | yes | yes |
| DELETE | `/api/payments/:id` | Payments: Delete | Payments: Delete | yes | REVIEW |
| GET | `/api/payments/:id` | Payments | — | yes | REVIEW |
| PUT | `/api/payments/:id` | Payments: Record Payment | Payments: Record Payment | yes | yes |
| PUT | `/api/payments/:id/allocations` | Payments: Record Payment | Payments: Record Payment | yes | yes |
| GET | `/api/payments/:id/receipt` | Payments | — | yes | REVIEW |
| GET | `/api/payments/stats/summary` | Payments | — | yes | REVIEW |
| GET | `/api/portal/access` | — | Customer Portal | yes | yes |
| POST | `/api/portal/access` | — | Customer Portal: Manage Access | yes | yes |
| DELETE | `/api/portal/access/:id` | — | Customer Portal: Manage Access | yes | yes |
| GET | `/api/portal/customer-data` | — | — | NO | REVIEW |
| GET | `/api/portal/deliveries` | — | — | NO | REVIEW |
| GET | `/api/portal/files` | — | — | NO | REVIEW |
| GET | `/api/portal/files/:id/download` | — | — | NO | REVIEW |
| GET | `/api/portal/invoices` | — | — | NO | REVIEW |
| POST | `/api/portal/login` | — | — | NO | REVIEW |
| POST | `/api/portal/logout` | — | — | NO | REVIEW |
| GET | `/api/portal/orders` | — | — | NO | REVIEW |
| POST | `/api/portal/session` | — | — | NO | REVIEW |
| GET | `/api/portal/stats/summary` | — | — | NO | REVIEW |
| POST | `/api/portal/upload-file` | — | — | NO | REVIEW |
| GET | `/api/proof-share/:proofId/:fileId/:expires/:signature` | — | — | NO | REVIEW |
| GET | `/api/proofs` | Job Proofing | — | yes | yes |
| POST | `/api/proofs` | Job Proofing | — | yes | yes |
| DELETE | `/api/proofs/:id` | Job Proofing | — | yes | yes |
| GET | `/api/proofs/:id` | Job Proofing | — | yes | yes |
| PUT | `/api/proofs/:id` | Job Proofing | — | yes | REVIEW |
| PUT | `/api/proofs/:id/approve` | Job Proofing: Approve | — | yes | REVIEW |
| POST | `/api/proofs/:id/comments` | Job Proofing | — | yes | REVIEW |
| PUT | `/api/proofs/:id/reject` | Job Proofing: Reject | — | yes | REVIEW |
| POST | `/api/proofs/:id/send` | Job Proofing | — | yes | REVIEW |
| POST | `/api/proofs/:id/send-email` | Job Proofing | — | yes | REVIEW |
| GET | `/api/proofs/:id/share-links` | Job Proofing | — | yes | REVIEW |
| POST | `/api/proofs/:id/versions` | Job Proofing | — | yes | REVIEW |
| GET | `/api/proofs/stats/summary` | Job Proofing | — | yes | REVIEW |
| GET | `/api/purchase-bills` | Purchase Bills | — | yes | REVIEW |
| POST | `/api/purchase-bills` | Purchase Bills: Create & Edit | Purchase Bills: Create & Edit | yes | yes |
| DELETE | `/api/purchase-bills/:id` | Purchase Bills: Delete | Purchase Bills: Delete | yes | REVIEW |
| GET | `/api/purchase-bills/:id` | Purchase Bills | — | yes | REVIEW |
| PUT | `/api/purchase-bills/:id` | Purchase Bills: Create & Edit | Purchase Bills: Create & Edit | yes | yes |
| GET | `/api/purchase-bills/:id/pdf` | Purchase Bills | — | yes | REVIEW |
| GET | `/api/purchase-bills/from-orders` | Purchase Bills | Purchase Bills: Create & Edit | yes | REVIEW |
| POST | `/api/purchase-bills/generate` | Purchase Bills: Create & Edit | Purchase Bills: Create & Edit | yes | yes |
| GET | `/api/purchase-bills/stats/summary` | Purchase Bills | — | yes | REVIEW |
| GET | `/api/purchase-orders` | Inventory or Purchase Bills or Vendors | — | yes | yes |
| POST | `/api/purchase-orders` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | yes |
| DELETE | `/api/purchase-orders/:id` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | REVIEW |
| GET | `/api/purchase-orders/:id` | Inventory or Purchase Bills or Vendors | — | yes | REVIEW |
| PUT | `/api/purchase-orders/:id` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | yes |
| GET | `/api/purchase-orders/:id/pdf` | Inventory or Purchase Bills or Vendors | — | yes | REVIEW |
| POST | `/api/purchase-orders/:id/receipts/:receiptId/reverse` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | yes |
| POST | `/api/purchase-orders/:id/receive` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | yes |
| POST | `/api/purchase-orders/:id/send-email` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | REVIEW |
| PATCH | `/api/purchase-orders/:id/status` | Inventory: Create & Edit or Purchase Bills: Create & Edit | — | yes | REVIEW |
| GET | `/api/purchase-orders/stats/summary` | Inventory or Purchase Bills or Vendors | — | yes | yes |
| GET | `/api/quotations` | Quotations | — | yes | yes |
| POST | `/api/quotations` | Quotations: Create & Edit | Quotations: Create & Edit | yes | yes |
| DELETE | `/api/quotations/:id` | Quotations: Delete | Quotations: Delete | yes | yes |
| GET | `/api/quotations/:id` | Quotations | — | yes | yes |
| PUT | `/api/quotations/:id` | Quotations: Create & Edit | Quotations: Create & Edit | yes | yes |
| POST | `/api/quotations/:id/convert-to-invoice` | Quotations: Convert to Invoice | Quotations: Convert to Invoice | yes | yes |
| GET | `/api/quotations/:id/pdf` | Quotations | — | yes | yes |
| POST | `/api/quotations/:id/send-email` | Quotations: Send Email | Quotations: Send Email | yes | yes |
| POST | `/api/quotations/:id/send-whatsapp` | WhatsApp: Send Messages | WhatsApp: Send Messages | yes | yes |
| PATCH | `/api/quotations/:id/status` | Quotations: Change Status | Quotations: Change Status | yes | yes |
| POST | `/api/razorpay/create-order` | — | — | yes | REVIEW |
| GET | `/api/razorpay/order/:orderId` | — | — | yes | REVIEW |
| POST | `/api/razorpay/order/:orderId/cancel` | — | — | yes | REVIEW |
| POST | `/api/razorpay/order/:orderId/sync` | — | — | yes | REVIEW |
| GET | `/api/razorpay/plans` | — | — | yes | REVIEW |
| GET | `/api/razorpay/subscription` | — | — | yes | REVIEW |
| POST | `/api/razorpay/verify-payment` | — | — | yes | REVIEW |
| GET | `/api/reconciliation` | Reconciliation | Reconciliation: View | yes | yes |
| POST | `/api/reconciliation/resolve` | Reconciliation: Resolve | Reconciliation: Resolve | yes | yes |
| GET | `/api/reports/customers` | Reports | Reports | yes | yes |
| GET | `/api/reports/customers/:customerId/invoices` | Reports | Reports | yes | yes |
| GET | `/api/reports/dashboard` | Reports | — | yes | REVIEW |
| GET | `/api/reports/design-charges` | Reports | Reports | yes | REVIEW |
| GET | `/api/reports/revenue` | Reports | Reports | yes | REVIEW |
| POST | `/api/reports/revenue/email` | Reports: Export | Reports: Export | yes | yes |
| GET | `/api/reports/vendors` | Reports | Reports, Purchase Bills | yes | REVIEW |
| GET | `/api/reports/vendors/:vendorId/bills` | Reports | Reports, Purchase Bills | yes | REVIEW |
| GET | `/api/sac-codes` | SAC Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| POST | `/api/sac-codes` | SAC Codes: Create & Edit | — | yes | yes |
| DELETE | `/api/sac-codes/:id` | SAC Codes: Delete | — | yes | yes |
| GET | `/api/sac-codes/:id` | SAC Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| PUT | `/api/sac-codes/:id` | SAC Codes: Create & Edit | — | yes | yes |
| POST | `/api/sac-codes/bulk-import` | SAC Codes: Create & Edit | — | yes | yes |
| GET | `/api/sac-codes/categories/list` | SAC Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| GET | `/api/sac-codes/gst-rates/summary` | SAC Codes or Invoicing or Quotations or Jobs or Inventory or Purchase Bills | — | yes | yes |
| GET | `/api/search` | any signed-in user | — | yes | yes |
| GET | `/api/settings` | any signed-in user | — | yes | REVIEW |
| PUT | `/api/settings` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/business` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/company` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/custom-fields` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/integrations` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/notifications` | any signed-in user | — | yes | yes |
| POST | `/api/settings/reset` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/security` | Settings: Edit | — | yes | yes |
| PUT | `/api/settings/theme` | any signed-in user | — | yes | yes |
| PUT | `/api/staff/:staffId/email` | User Management or Staff & Tasks | — | yes | yes |
| PUT | `/api/staff/:staffId/password` | User Management or Staff & Tasks | — | yes | yes |
| GET | `/api/staff/:staffId/schedule` | any signed-in user | — | yes | REVIEW |
| POST | `/api/staff/:staffId/schedule` | Staff & Tasks: Manage Schedule | — | yes | yes |
| DELETE | `/api/staff/:staffId/schedule/:scheduleId` | Staff & Tasks: Manage Schedule | — | yes | REVIEW |
| PUT | `/api/staff/:staffId/schedule/:scheduleId` | Staff & Tasks: Manage Schedule | — | yes | REVIEW |
| GET | `/api/staff/list` | Staff & Tasks | — | yes | yes |
| GET | `/api/staff/schedule/overview` | Staff & Tasks | — | yes | yes |
| GET | `/api/tasks` | any signed-in user | — | yes | REVIEW |
| POST | `/api/tasks` | any signed-in user | — | yes | yes |
| DELETE | `/api/tasks/:id` | any signed-in user | — | yes | REVIEW |
| GET | `/api/tasks/:id` | any signed-in user | — | yes | REVIEW |
| PUT | `/api/tasks/:id` | any signed-in user | — | yes | yes |
| POST | `/api/tasks/:id/comments` | any signed-in user | — | yes | REVIEW |
| PUT | `/api/tasks/:id/progress` | any signed-in user | — | yes | REVIEW |
| PUT | `/api/tasks/:id/status` | any signed-in user | — | yes | yes |
| POST | `/api/tasks/:id/time-entries` | any signed-in user | — | yes | REVIEW |
| GET | `/api/tasks/analytics` | any signed-in user | — | yes | REVIEW |
| GET | `/api/tasks/assignees` | any signed-in user | — | yes | REVIEW |
| GET | `/api/tasks/by-priority/:priority` | any signed-in user | — | yes | REVIEW |
| GET | `/api/tasks/by-staff/:staffId` | any signed-in user | — | yes | yes |
| GET | `/api/tasks/overdue` | any signed-in user | — | yes | REVIEW |
| GET | `/api/tasks/stats` | any signed-in user | — | yes | REVIEW |
| GET | `/api/team/members/:userId` | custom rule | — | yes | yes |
| GET | `/api/team/overview` | custom rule | — | yes | yes |
| GET | `/api/teams` | User Management or Staff & Tasks | — | yes | yes |
| POST | `/api/teams` | User Management: Edit Permissions | — | yes | yes |
| DELETE | `/api/teams/:id` | User Management: Edit Permissions | — | yes | yes |
| PUT | `/api/teams/:id` | User Management: Edit Permissions | — | yes | yes |
| GET | `/api/time-entries` | Designer Timer or Staff & Tasks | — | yes | REVIEW |
| POST | `/api/time-entries` | Designer Timer: Track Time | — | yes | yes |
| DELETE | `/api/time-entries/:id` | Designer Timer: Track Time | — | yes | REVIEW |
| GET | `/api/time-entries/:id` | Designer Timer or Staff & Tasks | — | yes | REVIEW |
| PUT | `/api/time-entries/:id` | Designer Timer: Track Time | — | yes | REVIEW |
| POST | `/api/time-entries/:id/pause` | Designer Timer: Track Time | — | yes | REVIEW |
| POST | `/api/time-entries/:id/resume,/:id/start` | Designer Timer: Track Time | — | yes | REVIEW |
| POST | `/api/time-entries/:id/stop` | Designer Timer: Track Time | — | yes | REVIEW |
| GET | `/api/time-entries/active` | Designer Timer or Staff & Tasks | — | yes | REVIEW |
| GET | `/api/time-entries/people` | Designer Timer or Staff & Tasks | — | yes | REVIEW |
| POST | `/api/time-entries/start` | Designer Timer: Track Time | — | yes | yes |
| GET | `/api/time-entries/stats/summary` | Designer Timer or Staff & Tasks | — | yes | REVIEW |
| GET | `/api/units` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| POST | `/api/units` | Inventory: Create & Edit | — | yes | yes |
| DELETE | `/api/units/:id` | Inventory: Create & Edit | — | yes | yes |
| GET | `/api/units/:id` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| PUT | `/api/units/:id` | Inventory: Create & Edit | — | yes | yes |
| PATCH | `/api/units/:id/deactivate` | Inventory: Create & Edit | — | yes | yes |
| GET | `/api/units/type/:type` | Inventory or Jobs or Quotations or Invoicing or Purchase Bills or Walk-In Jobs | — | yes | yes |
| GET | `/api/users` | — | — | yes | yes |
| POST | `/api/users` | — | User Management: Create Login | yes | yes |
| DELETE | `/api/users/:id` | — | — | yes | yes |
| GET | `/api/users/:id` | — | — | yes | REVIEW |
| PUT | `/api/users/:id` | — | — | yes | yes |
| PUT | `/api/users/:id/password` | — | — | yes | yes |
| POST | `/api/users/:id/resend-invitation` | — | User Management: Create Login | yes | yes |
| PUT | `/api/users/:id/toggle-status` | — | User Management: Edit Permissions | yes | yes |
| POST | `/api/users/me/delete-account` | — | — | yes | yes |
| GET | `/api/users/stats/summary` | — | — | yes | yes |
| GET | `/api/vendors` | Vendors or Purchase Bills or Inventory | — | yes | yes |
| POST | `/api/vendors` | Vendors: Create & Edit | Vendors: Create & Edit | yes | yes |
| DELETE | `/api/vendors/:id` | Vendors: Delete | Vendors: Delete | yes | yes |
| GET | `/api/vendors/:id` | Vendors or Purchase Bills or Inventory | — | yes | yes |
| PUT | `/api/vendors/:id` | Vendors: Create & Edit | Vendors: Create & Edit | yes | yes |
| POST | `/api/vendors/:id/communication` | Vendors: Create & Edit | — | yes | yes |
| PATCH | `/api/vendors/:id/deactivate` | Vendors: Create & Edit | Vendors: Create & Edit | yes | REVIEW |
| POST | `/api/vendors/:id/payment` | Purchase Bills: Record Payment or Vendors: Create & Edit | — | yes | yes |
| GET | `/api/vendors/:id/performance` | Vendors or Purchase Bills or Inventory | — | yes | yes |
| PUT | `/api/vendors/:id/performance` | Vendors: Create & Edit | — | yes | yes |
| PATCH | `/api/vendors/:id/reactivate` | Vendors: Create & Edit | Vendors: Create & Edit | yes | REVIEW |
| GET | `/api/vendors/analytics` | Vendors or Purchase Bills or Inventory | — | yes | REVIEW |
| GET | `/api/vendors/stats/summary` | Vendors or Purchase Bills or Inventory | — | yes | yes |
| GET | `/api/walk-in-jobs` | Walk-In Jobs | — | yes | REVIEW |
| POST | `/api/walk-in-jobs` | Walk-In Jobs: Create & Edit | — | yes | yes |
| DELETE | `/api/walk-in-jobs/:id` | Walk-In Jobs: Create & Edit | — | yes | REVIEW |
| GET | `/api/walk-in-jobs/:id` | Walk-In Jobs | — | yes | REVIEW |
| PUT | `/api/walk-in-jobs/:id` | Walk-In Jobs: Create & Edit | — | yes | REVIEW |
| PUT | `/api/walk-in-jobs/:id/assign` | Walk-In Jobs: Create & Edit | — | yes | REVIEW |
| PUT | `/api/walk-in-jobs/:id/invoice` | Walk-In Jobs: Create & Edit | — | yes | yes |
| PUT | `/api/walk-in-jobs/:id/quality-check` | Walk-In Jobs: Create & Edit | — | yes | REVIEW |
| PUT | `/api/walk-in-jobs/:id/status` | Walk-In Jobs: Create & Edit | — | yes | REVIEW |
| GET | `/api/walk-in-jobs/operators` | Walk-In Jobs | — | yes | REVIEW |
| GET | `/api/walk-in-jobs/stats/summary` | Walk-In Jobs | — | yes | REVIEW |
| GET | `/api/whatsapp/account` | — | — | yes | REVIEW |
| GET | `/api/whatsapp/meta-templates` | — | — | yes | REVIEW |
| POST | `/api/whatsapp/meta-templates` | — | — | yes | REVIEW |
| DELETE | `/api/whatsapp/meta-templates/:name` | — | — | yes | REVIEW |
| POST | `/api/whatsapp/send` | — | — | yes | REVIEW |
| GET | `/api/whatsapp/settings` | — | — | yes | REVIEW |
| POST | `/api/whatsapp/settings` | — | — | yes | REVIEW |
| GET | `/api/whatsapp/starter-templates` | — | — | yes | REVIEW |
| GET | `/api/whatsapp/webhook` | — | — | NO | REVIEW |
| POST | `/api/whatsapp/webhook` | — | — | NO | REVIEW |

Total routes: 411. Not behind auth: 23. Mutating routes flagged REVIEW: 77.
