# Printing ERP — Implementation Report

**Date:** 27 Nov 2026 · **Branch:** `main`, uncommitted working tree (nothing committed, pushed or deployed).
Companion documents: `printing-erp-upgrade-audit.md` (findings), `printing-erp-performance-report.md` (measurements), `printing-erp-feature-checklist.md` (continuation list).

> **Note on the working tree.** While this batch was in progress, other changes appeared in the same tree that this batch did not make (GSTIN validation, customer financial figures, quotation linking, attendance at sign-in, paper-stock helpers — e.g. `services/customerFinancials.js`, `utils/gstin.js`, `utils/autoAttendance.js`, `services/quotationLink.js`, edits to `routes/auth.js`, `routes/settings.js`, `routes/vendors.js`, customer/vendor dialogs). They were left untouched. The full backend suite below was run with both sets of changes present.

## A. Executive summary

| | |
|---|---|
| Original status | Functionally broad (~45 screens) but slow on a remote database, showed failed loads as empty data, let issued invoices be edited/deleted, numbered drafts from the official series, and had no credit/debit notes. |
| Current status | P0 performance, error-state, subscription and invoice-integrity work is in place with automated tests; credit/debit notes exist end-to-end (API, PDF, UI). GST returns, e-invoice, e-way bill, Tally, Settings expansion, advanced job tickets and P2 business features are **not** done. |
| Requirements audited | 68 (matrix below) |
| Already implemented and verified before this work | GST line maths, Razorpay server-side verification/idempotency, tenant scoping and module guards, estimator maths |
| Bugs confirmed | 17 (11 reported + 6 found) |
| Bugs fixed | 16 (amount-in-words ≥ 100 crore not fixed) |
| Missing features implemented | Credit/debit notes; draft identifiers + number-at-issue; job board endpoint; unified global search; request timing; index migration |
| Partially complete | Error states (≈25 of ~37 screens), credit/debit notes (no GST-report or journal integration), invoice document improvements, date formatting (tenant time zone not wired to Settings) |
| Blocked | E-invoice, e-way bill (credentials); production performance verification (no access) |
| Tests | Backend **54 suites / 805 tests, all passing** (was 47 / 745). Client node tests **23 / 23** passing. |

## B. Requirement verification matrix

Final status values: **VC** Verified Complete · **IV** Implemented, Not Fully Verified · **PC** Partially Complete · **M** Missing · **BL** Blocked · **N/A**.

### Bug fixes
| Requirement | Initial | Root cause | Implementation | Files | Test evidence | Final |
|---|---|---|---|---|---|---|
| Failed loads shown as empty (all modules) | B | catch → toast, state left `[]` | `ErrorState` / `StaleDataBanner` / `PageErrorBoundary`; `DataTable` `error`+`onRetry`; wired into Jobs, Counter Jobs, Production Board, Customers, Invoices, Quotations, Payments, Inventory, Purchase Bills/Orders, Vendors, Delivery, Rush Orders, Proofing, Accounts, Activity Log, Attendance, Leaves, Payroll, Employees, Discounts, Staff tasks, Costs (jobs), HSN/SAC, Notifications (bell + panel), Subscription, header search, session check | `components/common/LoadState.tsx`, `components/data/DataTable.tsx`, `hooks/useLoader.ts`, pages listed | Type-check, build; no browser test | **PC** |
| Timeout on `/auth/me` signed the user out | B | token cleared on any error | Only 401 clears the session; otherwise a Retry screen | `contexts/AuthContext.tsx`, `components/auth/ProtectedRoute.tsx` | none automated | IV |
| Repeated plans/subscription requests, old order re-checked | B | unstable deps; sync-on-load | Shared React Query cache (plans 6 h, subscription 5 min); prompt decides from `/auth/me` and fetches only when it opens; only orders started in this browser session are re-checked, once; double-click guard on buy | `usePlanCheckout.ts`, `PlanPromptDialog.tsx`, `Subscription.tsx` | none automated (client) | IV |
| Razorpay status check throttling | — | each check hits Razorpay | Atomic per-order claim; ≤1 call per 30 s per order | `services/subscriptionService.js`, `models/SubscriptionPurchase.js` | `performance-and-pipeline.test.js` (3 concurrent → 1 call) | VC |
| Enquiry jobs visible on Production Board | P | floor view filtered them out | "Pre-production" column (Enquiry + Quote Sent) on the shop-floor view; stage counts from server | `utils/jobMetrics.js`, `routes/jobs.js` (`/board`), `pages/ProductionBoard.tsx`, `lib/printWorkflow.ts` | API counts tested; UI not browser-tested | IV |
| Awaiting dispatch ≠ Ready stage | B | counted Delivery records | "Awaiting dispatch" = jobs in Ready to Dispatch (one rule); deliveries shown as "Deliveries in progress" | `routes/dashboard.js`, `pages/Dashboard.tsx` | `performance-and-pipeline.test.js` | VC |
| Priority Medium/Normal | B | display labels | One scale Low/Medium/High/Urgent across jobs, board, counter jobs, deliveries, rush orders, tasks; `normalizePriority` for legacy "normal"/"rush" | `lib/priority.ts`, metas | Stored enums verified; no UI test | IV |
| Date formatting | B | browser-default locale | `fmtDate` "14 Nov 2026", `fmtTime` "10:30 AM", `fmtDateTime`, Asia/Kolkata, `setDisplayTimeZone`; PDFs "14 Nov 2026" | `lib/format.ts`, 7 components, `PDFService.js` | PDF layout tests updated & passing | IV (tenant TZ not wired) |
| Estimator Reset | B | hard-coded "custom" | `initialEstimatorState()` used by first load and Reset | `lib/estimatorPresets.ts`, `pages/PrintEstimator.tsx` | `client/tests/print-estimator.test.mjs` | VC |
| Empty grey box | B | totals card always rendered | Render only with items/design charge | `components/jobs/CreateJobDialog.tsx` | none automated | IV |
| Customer search misses jobs | B | jobs searched title only; raw regex | `GET /api/search` (customers, their jobs/quotations/invoices, POs), literal matching, permission-filtered; job list search also matches customer/company/item | `routes/search.js`, `routes/jobs.js`, `components/layout/Header.tsx` | `global-search.test.js` (6 tests incl. tenant isolation) | VC |
| Cancellation reason/date not stored | B (found) | fields not in schema | Added `cancelledAt`, `cancellationReason`, `cancelledBy` | `models/Invoice.js` | lifecycle test | VC |
| Draft delete kept stock deducted | B (found) | no restore on delete | Restore stock when a draft is deleted | `routes/invoices.js` | none automated | IV |
| Regex injection in job search | B (found) | raw `$regex` | Escaped | `routes/jobs.js` | search test (literal `.*`) | IV |

### Performance
| Requirement | Initial | Implementation | Evidence | Final |
|---|---|---|---|---|
| Evidence-based indexes + safe migration | B | 16 indexes; create-only migration | `explain-before/after.txt`; migration dry-run/run/re-run locally | VC |
| Remove sequential queries | B | parallel page+count; dashboard parallel | bench | VC |
| Entitlement per-request cost | B | cached, parallel, invalidated | test + bench (255 → 86 ms) | VC |
| Payload reduction | B | no line items in job list; `/jobs/board` | bench (1.38 MB → 0.69 MB; board replaces 500-job polling) | VC |
| Structured performance logging | M | `Server-Timing` + `slow_request` JSON | test | VC |
| Frontend code splitting | M | lazy routes | build: 597 → 171 KB gzip entry | VC |
| Request dedupe, cancellation, retry/backoff | P | GET dedupe, abort signals, React Query defaults | type-check only | IV |
| Connection pool configuration | P | min/max pool, idle, zlib | not load-tested in production | IV |
| Server-side pagination for Customers & Job Tickets pages | P | not converted (parallel page fetch instead) | — | M |
| Browser timing targets (initial < 2 s, nav < 300 ms) | — | — | not measured | M |
| Production confirmation of fixes | — | — | no access | BL |

### GST & compliance
| Requirement | Initial | Implementation | Evidence | Final |
|---|---|---|---|---|
| 6.1 Credit & debit notes | M | Model, service, routes, PDF, dialog; line-level qty/value; CGST/SGST/IGST at original rate; limits vs issued notes; draft/issued/cancelled; own FY series `CN-2627-0001`/`DN-…`; idempotency key; audit log; permission | `invoice-lifecycle-credit-notes.test.js` (12 note tests), `invoice-payment-status.test.js` | **PC** — not yet in GST reports; no accounting journal (the app has a cashbook, not a GL); sales-return restocking not done |
| 6.2 Protect issued documents | B | Issued: amounts/customer/date locked (409 `INVOICE_ISSUED_LOCKED`); delete only drafts; cancel keeps number with who/when/why; balance = total + debit notes − applied credit − paid | lifecycle tests | VC |
| 6.3 Draft numbers / number at issue / concurrency | B | `DRAFT-#####` series; official number at issue via claim + atomic counter (transaction where available); legacy drafts keep their number; email/WhatsApp of a draft issues it first | lifecycle tests (consecutive, 10 concurrent, double-issue) | VC |
| 6.3 Configurable / FY series per GST registration | M | — | — | M |
| 6.4 GST reports | M | — | — | M |
| 6.5 E-invoice | M | — | needs IRP/GSP credentials | BL |
| 6.6 E-way bill | M | — | needs EWB credentials | BL |
| 6.7 Tally export | M | — | — | M |
| 6.8 Invoice document improvements | P | Indian date format on PDFs | layout tests | PC |

### Settings (Phase 7) — 7.1 PC (company/tax fields exist, not expanded), 7.2–7.7 **M**.
### Job management (Phase 8 + 4.1 transitions) — status-transition validation **M**; 8.1 artwork **M** (proof files exist separately); 8.2 operator assignment **PC** (single handler); 8.3 detailed specs **PC** (generic `printSpecs`); 8.4 quotation→job **M**; 8.5 delivery address **M**; 8.6 deadlines **PC** (`dueDate`, overdue alerts exist).
### Additional business features (Phase 9) — 9.1–9.4 **M**.

### Security & data integrity
| Requirement | Evidence | Final |
|---|---|---|
| Tenant isolation on new endpoints (board, search, notes) | tests use a second business | VC |
| Role-based permission for notes | 403 test | VC |
| Idempotent note creation | concurrent duplicate test | VC |
| Concurrency-safe issue numbering | concurrent issue test | VC |
| No secrets in perf logs | log line carries method/route/status/ms only | VC |
| Literal search matching | test | IV |

### Automated testing
Unit (estimator) VC · API integration VC · DB integration VC · financial calculation VC · concurrency VC · tenant isolation VC · permission VC · regression (full suite) VC · performance harness IV (manual, not CI) · browser E2E **M**.

**Mandatory scenarios covered by automated tests (7 of 16):** dashboard/board reconcile; customer search returns jobs; estimator Reset; concurrent issuance without duplicate numbers; drafts do not consume numbers; issued invoices cannot be deleted; credit/debit notes update balances. **Not covered:** timeout ≠ empty state and stale-data retention (no browser tests), subscription request de-duplication, payment-retry duplicate orders, GST report reconciliation, recurring scheduler, artwork isolation, bulk-action permissions, statement reconciliation (features missing).

## C. Performance comparison
See `printing-erp-performance-report.md` §5 (80 ms simulated DB round trip, same seed, before = `HEAD`, after = working tree). Headline: `/auth/me` 255 → 86 ms; job list 517 → 268 ms; dashboard 534 → 272 ms; Customers page (1,500 rows) 9.4 s → 1.9 s; entry bundle 597 → 171 KB gzip.

## D. Completion summary (verified = VC rows ÷ rows in the area)

| Area | Rows | VC | IV | PC | M/BL | Verified completion |
|---|---|---|---|---|---|---|
| Bug fixes | 14 | 5 | 8 | 1 | 0 | 36 % (93 % implemented) |
| Performance optimisation | 11 | 6 | 2 | 0 | 3 | 55 % |
| GST & compliance | 9 | 2 | 0 | 2 | 5 | 22 % |
| Settings | 7 | 0 | 0 | 1 | 6 | 0 % |
| Job management | 7 | 0 | 0 | 3 | 4 | 0 % |
| Additional business features | 4 | 0 | 0 | 0 | 4 | 0 % |
| Security | 6 | 5 | 1 | 0 | 0 | 83 % |
| Automated testing | 10 | 8 | 1 | 0 | 1 | 80 % |
| **Overall** | **68** | **26** | **12** | **7** | **23** | **38 %** |

## E. External dependencies
- **GST / GSP / IRP credentials** — e-invoice IRN, signed QR, cancellation (sandbox first).
- **E-way bill API credentials**.
- **Tax professional review** — note reasons, GSTR-1 CDNR/CDNUR mapping, numbering policy.
- **Razorpay** — webhook secret configured in production; sandbox keys for verification (`.env` holds test keys).
- **Email provider** — SMTP is environment-only; a per-business configuration UI does not exist.
- **WhatsApp (Meta)** — unchanged.
- **Cloud storage** — needed for artwork uploads and backups (Cloudinary SDK is a dependency; not used for this).
- **Deployment** — run the index migration; set `PERF_SLOW_MS` as desired; confirm Atlas/EC2 regions.
- **Business approval** — the invoice-lock and draft-identifier behaviour (audit §5).

## F. Release readiness

**This batch: CONDITIONAL GO.** Conditions:
1. Owner/accountant sign-off on locking issued invoices and on draft identifiers.
2. Staging deploy with a browser smoke test of: Dashboard, Production Board (pre-production column), Job Tickets, Counter Jobs, Customers, Invoices (issue, credit note, PDF), Estimator Reset, header search, plan page — including a forced API failure to see the error/Retry states.
3. Run `backend/migrations/2026-11-27-performance-and-lifecycle-indexes.js` (create-only) off-peak, or let the server build them at start.
4. Grant *Invoicing: Credit & Debit Notes* to the roles that should raise notes.
5. Confirm production latency with `Server-Timing` / `slow_request` logs.

**The full brief: NO-GO.** GST returns, e-invoice/e-way bill, Tally export, Settings expansion, advanced job tickets, recurring invoices, statements and bulk actions are not implemented, and there is no browser E2E suite.
