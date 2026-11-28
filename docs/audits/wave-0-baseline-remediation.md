# Wave 0: baseline remediation report (27 Nov 2026)

Nothing committed, pushed or deployed. No production credentials or data used. All verification on isolated local databases.

## 1. Original findings
Audit baseline: 19/56 F (33.9%); backend 745 tests passing; frontend 9 passing, 1 failing.

## 2. Already resolved before this work (found in the working tree)
Performance indexes and entitlement cache, job-board counts from one rule (enquiries included, awaiting dispatch = Ready to Dispatch), single priority scale (Medium, not Normal), global search by customer name, Razorpay order-check rate limit, `useLoader`/`ErrorState` error states, estimator reset to saved defaults. Each has an existing test (`performance-and-pipeline`, `global-search`) or one added now (`priority`, `print-estimate`, Playwright error/retry).

## 3. Confirmed root causes
| Task | Cause |
|---|---|
| 1 | Test listed `https://api.carbonprintflow.com/api` as a refused loopback URL; it is a valid hosted URL (the same test file accepts it elsewhere) |
| 2 | `Customer.updateStats` summed `Job.estimatedCost` as revenue |
| 3 | Not reproduced locally (see performance-comparison.md); latency scales with DB round trips |
| 4 | Legacy module-only grants carried destructive/privilege actions |
| 5 | Admin-deletable audit rows; sparse coverage (no payroll, no reversal reasons) |
| 6 | Failed undo steps were only `console.error`'d; no durable record, alert or idempotency on invoice/stock |
| extra | `Settings.getOrCreateSettings` race (duplicate key → 500 on concurrent first invoices) |

## 4. Changes
Customer financials service; append-only audit log (+retention script, `auditContext`, `audit()` helper); `TransactionJournal`, journalled `inTransaction`, `IdempotencyRecord` + `Idempotency-Key`; reconciliation service/routes/permission; migration runner and 3 versioned migrations; endpoint-matrix generator; explicit-only permissions; Settings race fix; export date formatting; client: `npm test`, Playwright suite, new unit tests, audit-log UI delete removed.

## 5. Files (new unless marked)
Backend: `services/customerFinancials.js`, `services/reconciliation.js`, `routes/reconciliation.js`, `models/{TransactionJournal,IdempotencyRecord}.js`, `middleware/idempotency.js`, `utils/{audit,auditContext}.js`, `migrations/runner.js`, `migrations/versions/001-003`, `scripts/{migrate,audit-retention,e2e-seed}.js`, `scripts/audit/endpoint-matrix.js`; modified: `models/{Customer,ActivityLog,Settings}.js`, `routes/{customers,activityLog,payroll,payments,invoices,inventory}.js`, `utils/transactions.js`, `middleware/{requirePermission,moduleGuard,auth}.js`, `services/{paymentLedger,invoiceCreation,InventoryService}.js`, `config/permissions.js`, `app.js`.
Tests: `customer-financials, audit-trail, audit-coverage, tenant-isolation, transaction-reliability, reconciliation, migrations`. Client: `e2e/smoke.spec.ts`, `playwright.config.ts`, `tests/{print-estimate,priority}.test.mjs`; modified `vite-config.test.mjs`, `ActivityLog.tsx`, `exportUtils.ts`, `package.json`.

## 6. Migrations introduced
001-add-datascope (irreversible, additive), 002-indexes (additive), 003-recompute-customer-financials (reversible from backup). **Not run against any real database.** Run `node scripts/migrate.js plan --uri <staging copy>` first.

## 7. Tests
Frontend `npm test`: 34/34. Playwright: 15/15 (isolated stack). Backend: last full run 1,034 pass / 5 fail across `invoice-integrity` and `party-deactivation`; both suites pass 28/28 when run alone. Earlier full runs showed other suites failing under load, each passing alone. Cause attributed to machine load and thousands of leftover test databases slowing index builds (a peer session cleaned some). **A fully green single full run has not been observed**; run it on an idle machine/CI with `jest -i` before release. Note: other work (GST reports, party deactivation, statutory payroll) by another session is present in the same tree and is included in those counts but not reviewed by me.

## 8. Performance
See performance-comparison.md. Local simulation only; no production claim.

## 9. Remaining blockers
Production MongoDB topology unknown (`db.hello()`); no staging performance run; legacy-grant behaviour change needs business sign-off; dashboard/`jobs.js` "monthly revenue" still uses `estimatedCost`; audit immutability is application-level only; 77 mutating routes lack a static scope reference (isolation proven for financial/inventory/job/payroll/HR/user kinds only); Task 10 items not independently re-verified: New Job Ticket empty grey container, `Jobs.tsx`/`Subscription.tsx` date formats; peer-owned GST/payroll changes unreviewed.

## 10. Completion
20/56 F = **35.7%** (only the estimator calculator moved, U→F, on hand-checked tests).

## 11. Release readiness: **CONDITIONAL GO** (not releasable until the conditions hold)
Conditions: one green full backend run on an idle runner; sign-off on explicit-only permissions; production topology confirmed; migrations planned on a staging copy; staging latency run.

## 12. Prerequisites for Wave 1
Above conditions; reconciliation report reviewed on real data (expect findings); DB-level audit protection (role or export); idempotency on quotation→invoice; CI running `npm test`, `jest -i` and `test:e2e`.
