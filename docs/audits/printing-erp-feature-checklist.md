# Printing ERP — Feature Checklist & Continuation Plan

> **Phase 2 update (27 Nov 2026, evening):** see `printing-erp-phase-2-completion-report.md` for the current status. Since this list was written: items 2 (error states), 3 (server-side pagination), 4 (credit/debit notes in reports), 8 (GST reports), 9 (configurable numbering), 11 (statements), 14 (Tally export, import-untested) and 17 (recurring invoices) are done; 18 (bulk actions) is partial; 20–21 (e-invoice / e-way bill) have their workflow built but stay blocked on provider credentials. Several other items were built by parallel sessions (receipts, PO returns/PDF, payroll selection + PF/ESI, job-edit restrictions, paper sheets, GSTIN validation, audit trail).

**As of 27 Nov 2026.** ☑ verified by automated test · ◐ implemented, needs browser/manual verification · ☐ not done · ⛔ blocked.
Repository state: all changes are **uncommitted** on `main`. Backend 54 suites / 805 tests pass; client node tests 23/23 pass; client type-check and production build pass. Lint: 349 errors (348 before — all pre-existing `no-explicit-any`, +1 net).

## Done in this batch

- ☑ Indexes (16) + create-only migration `backend/migrations/2026-11-27-performance-and-lifecycle-indexes.js`
- ☑ Cached, parallel plan entitlement; ☑ Razorpay status-check throttle
- ☑ `GET /api/jobs/board` (stage counts + light cards); ☑ Dashboard "Awaiting dispatch" = Ready to Dispatch
- ☑ Job list: parallel count, no invoice line items; ☑ `Server-Timing` + slow-request JSON log
- ☑ `GET /api/search` global search (customers → their jobs, quotations, invoices; POs)
- ☑ Draft identifiers, number at issue, concurrency-safe; ☑ issued invoices locked / not deletable; ☑ cancellation who/when/why stored
- ☑ Credit & debit notes (API, limits, FY series, idempotency, PDF, permission)
- ☑ Estimator: centralized initial state, Reset fixed, ₹4,850.19 / 48-up regression tests
- ◐ Error / stale-data states on ~25 screens; ◐ session check no longer logs out on timeout
- ◐ Lazy-loaded routes + page error boundaries (bundle −71 % gzip)
- ◐ Plan data via shared query cache; prompt fetches lazily; no Razorpay re-check on every load
- ◐ Pre-production column on Production Board; ◐ priority labels Low/Medium/High/Urgent; ◐ Indian date/time formatting (app + PDFs)
- ◐ Empty grey box removed; ◐ Credit/debit note dialog and invoice-list actions (drafts-only edit/delete)

## Continuation checklist (priority order)

### P0 — finish before release
1. ☐ **Browser smoke test on staging** of every screen in the release conditions (implementation report §F), with a forced API failure (e.g. block `/api/jobs`) to confirm ErrorState/Retry and stale banners.
2. ☐ **Remaining error states**: Payment Reminders, WhatsApp, Calendar, Team Overview, Reports, Customer Portal (staff), Users/Roles/Teams tabs, Task detail, Designer Timer, Settings, Costs (cost list tab), Discounts (second table), Staff (team section). Pattern: `loadError` state + `DataTable error/onRetry` or `ErrorState`.
3. ☐ **Server-side pagination/filtering** for Customers (needs `view`, `gst`, `tag` filters and a `/customers/stats/summary` endpoint for the metric bar) and Job Tickets (status/priority/search server-side). AC: list API < 500 ms; page never downloads all rows.
4. ☐ **Credit/debit notes in reports**: subtract/add in the existing monthly GST figure and customer revenue; CN/DN register. AC: report totals reconcile with issued notes (test).
5. ☐ Browser E2E harness (Playwright) for the 16 mandatory scenarios; at minimum timeout ≠ empty state and no duplicate plan requests on navigation.
6. ☐ Wire `setDisplayTimeZone` to a Settings time-zone field (fall back to Asia/Kolkata).

### P1
7. ☐ Job status transition rules (allowed next stages per role) and board drag-drop validation; keep `flowHistory`.
8. ☐ GST reports: GSTR-1 (B2B, B2CL, B2CS, CDNR, CDNUR, HSN), GSTR-3B summary, sales/purchase registers, HSN/SAC summary; FY/month/quarter filters; CSV/Excel; JSON only after checking the current GSTN offline-tool schema. Clearly labelled "report, not a filing".
9. ☐ Configurable document numbering (prefix/suffix/padding/FY reset) per document type in Settings, without renumbering issued documents; one series per GST registration if branches are added.
10. ☐ Invoice document: place of supply, separate shipping address, reverse-charge flag, configurable round-off, amounts in words incl. paise and ≥ 100 crore.
11. ☐ Customer statement / ledger PDF (opening balance, invoices, payments, credit/debit notes incl. unapplied credit, running and closing balance, ageing).
12. ☐ Quotation → job conversion with source links and duplicate-conversion guard.
13. ☐ Job ticket: delivery/billing addresses, multiple operator roles, detailed print specs reusing estimator inputs, artwork attachments (private storage, signed downloads, versioning, tenant isolation test).
14. ☐ Tally XML export (masters + vouchers) with mapping preview and export history.
15. ☐ Settings sections: SMTP per business (encrypted credentials, test email, delivery log), notification preferences, document templates, data export.

### P2
16. ☐ Duplicate invoice/quotation/job (reset numbers, payments, filing ids).
17. ☐ Recurring invoices (scheduler with a unique per-period key to prevent duplicates across restarts/instances).
18. ☐ Bulk actions with per-record permission checks and partial-failure reporting.
19. ☐ Backup/restore (encrypted, tenant-scoped, restore verified only in an isolated environment).
20. ⛔ E-invoice (IRN/QR) — needs IRP/GSP sandbox credentials.
21. ⛔ E-way bill — needs EWB API credentials.

## Known limitations of what was delivered
- A credit note above the invoice's outstanding balance is kept as **unapplied customer credit** on the note; there is no refund/apply-to-another-invoice flow yet.
- Without MongoDB transactions (standalone server), a crash between taking an official number and saving can skip one number; the gap is visible and never reused. Atlas (replica set) uses a transaction and has no gap.
- Sales-return credit notes do not put stock back.
- The migration's dry-run reports the text index on Customer as "missing" because MongoDB stores text index keys differently; re-running is harmless.
- `client/dist` was overwritten once by a development-mode build during this work (it is git-ignored build output; rebuild before deploying from it).
