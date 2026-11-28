# Printing ERP — Upgrade Audit (initial findings)

**Date:** 27 Nov 2026 · **Repository state audited:** `main` @ `39087e9` plus uncommitted work in the tree.
**Stack:** React 18 + Vite + TanStack Query (client), Express 4 + Mongoose 8 (backend), MongoDB (Atlas in production, standalone locally), Electron wrapper. ~100k lines across `backend/src` and `client/src`; 46 page components, 48 API routers, 49 models.
**Baseline tests:** backend 47 suites / 745 tests — 744 passed, 1 failed (`job-ticket-gst`, passed on re-run: load-sensitive while a benchmark ran concurrently). Client node tests: all passed.

This audit verified each reported issue against the code before changing anything. Status key: **V** verified working · **B** implemented but broken · **P** partially implemented · **M** missing · **X** blocked by an external dependency.

## 1. Reported issues — verification and root cause

| Reported issue | Status | Root cause (file) |
|---|---|---|
| `/auth/me` ~14 s; lists ~24 s; Jobs/Counter Jobs/Notifications/Subscription timing out at 30 s | **B** | See `printing-erp-performance-report.md` §3: sequential page-by-page customer loads (Customers, and Jobs for an unused prop), 1.4 MB job payloads polled by Dashboard/Board, a collection scan for job→invoice population, missing tenant sort indexes, two extra queries on every request for the plan entitlement, one 2.2 MB bundle. Production hosting/region not inspectable. |
| Failed requests shown as empty lists ("No jobs found", "The counter queue is clear") | **B** | Every list page caught load errors with a toast and left `[]` in state, so the empty state rendered. `AuthContext` also signed users out when `/auth/me` merely timed out. |
| `/api/razorpay/plans` and `/subscription` requested repeatedly; old order re-checked | **B** | `PlanPromptDialog` mounted `usePlanCheckout`, whose effect depended on `refreshUser` (recreated on every auth-context render) → refetch; it also synced the 3 newest open orders with Razorpay on every app load. Server had no throttle. |
| Dashboard shows Enquiry jobs; Production Board starts at Order Confirmed | **P** | The board's default "Shop floor" view filtered out `inquiry` and `quotation_sent`; counts were computed client-side from at most 500 jobs. |
| "Awaiting dispatch" = 1 with nothing in Ready | **B** | Dashboard counted *Delivery records* scheduled/in transit (`routes/dashboard.js`), the board counts *jobs* in status `completed` (Ready to Dispatch). Different entities, same label. |
| Priority "Medium" in form vs "Normal" in list | **B** | Display labels only: `PRIORITY_STYLES.medium.label = "Normal"` (and in counter-job, delivery, rush and task meta). Stored values were already `low/medium/high/urgent` everywhere (schema enums) — no data migration needed. |
| Invoice popup shows US dates | **B** | `ViewInvoiceDialog` used `toLocaleDateString()` (browser default locale); 6 other places too; PDFs used `en-GB` "14/11/2026". |
| Estimator Reset shows "Custom size" with visiting-card values | **B** | `reset()` in `PrintEstimator.tsx` hard-coded `setProductId("custom")` and did not reset job name/paper/unit. |
| Empty grey box above Cancel / Create Job | **B** | The totals `Card` (`bg-muted/50`, padded) rendered unconditionally in `CreateJobDialog.tsx`; with no items it was an empty grey box. |
| Customer-name search finds customers and invoices but not jobs | **B** | Header search called `/jobs?search=`, which matched only title/description; the user's text was also used as a raw regex (regex injection / ReDoS risk). Failed searches showed "No results". |
| Drafts consume official invoice numbers | **B** | `Invoice.createNumbered` numbered every invoice at creation (default status `draft`). |
| Issued invoices editable / deletable | **B** | `PUT /api/invoices/:id` re-priced any invoice; `DELETE` hard-deleted any invoice without payments. |

## 2. Additional defects found during the audit

| Defect | Severity | File |
|---|---|---|
| Invoice cancellation date and reason were **never stored** (route set fields the schema did not define) | High (audit trail) | `models/Invoice.js` |
| Deleting a draft invoice did **not return the stock** its creation had taken | High (inventory) | `routes/invoices.js` |
| Job list search interpreted user text as a regular expression | Medium (security) | `routes/jobs.js` |
| `Invoice.jobId` unindexed → every job list scanned all invoices of all businesses | High (performance) | `models/Invoice.js` |
| Sending a draft by email/WhatsApp generated the customer's PDF *before* issuing it | High (compliance, once drafts carry draft identifiers) | `routes/invoices.js` |
| Amount in words drops amounts ≥ 100 crore and ignores paise | Low | `services/PDFService.js` (not fixed) |

## 3. Requirement inventory (initial status)

| Area | Initial status | Notes |
|---|---|---|
| Server-side pagination | P | APIs paginate; Customers and Job Tickets pages load everything and filter client-side. |
| Loading/error/empty states | B | See §1. |
| Subscription & Razorpay | P | Server side sound (signature checks, idempotent settlement, webhook event claim, reconciler). Client duplication and re-verification issues. |
| Job status workflow & history | P | Fixed 11-status model with `flowHistory`; no transition validation (any status → any status). |
| GST invoice maths, CGST/SGST/IGST | V | `utils/billing.js`, tests. |
| Credit / debit notes | M | |
| Issued-document protection | B | |
| Invoice numbering | B | Per-tenant atomic counter (`NumberSequence`), monthly `INV-YYYYMM-####`; drafts consumed numbers; no configurable series; no FY reset. |
| GST reports (GSTR-1/3B, HSN summary, registers) | M | Only a monthly GST-by-rate figure in Reports. |
| E-invoice (IRN), e-way bill | M / X | Need GSP/IRP and EWB API credentials. |
| Tally export | M | |
| Invoice document fields | P | HSN, rate, tax split, amount in words (Indian), bank/QR present; no place of supply, shipping address distinct from billing, reverse charge, round-off. |
| Settings (company, numbering, defaults, SMTP, notifications, templates, backup) | P | Company, bank, payment QR, WhatsApp, reminder settings exist; SMTP is env-only; no numbering, templates or backup UI. |
| Job tickets: artwork, operators, detailed specs, quotation link, delivery address, deadlines | P | Single handler assignment; generic `printSpecs`; proofs module has files; quotation→invoice exists (not quotation→job); `dueDate` exists. |
| Duplicate / recurring / statements / bulk actions | M | |
| Automated browser E2E | M | None in repo. |

## 4. Priorities applied

P0 first (performance, error states, subscription requests, invoice protection, numbering, credit/debit notes, security), then P1 fixes that were small and well-understood (board/dashboard consistency, search, priority, dates, estimator, grey box). Everything else is in the continuation checklist (`printing-erp-feature-checklist.md`).

## 5. Business decisions needed

1. **Issued invoices are now locked** (amounts, customer, date). Corrections go through credit/debit notes or cancellation. This changes how staff work; confirm before release.
2. **Draft identifiers**: new drafts show `DRAFT-00001` until issued. Existing drafts that already hold an `INV-` number keep it when issued (not renumbered).
3. **Credit-note permission**: raising/issuing notes needs the new action *Invoicing: Credit & Debit Notes*. Admins have it; the Accountant starter role receives it on upgrade; other roles must be granted it.
4. Invoice series format (`INV-YYYYMM-####`, monthly) was kept. Whether to move to an FY-reset or configurable series needs the accountant's decision.
5. GST compliance items (GSTR exports, e-invoice, e-way bill) need a tax professional's review and GSP credentials.
