# Terra ERP — Phase 2 Completion Report

**Date:** 27 Nov 2026 · **Author:** session terra-erp-39 · **Repository:** `main` @ `39087e9` plus uncommitted work (nothing committed, pushed or deployed).
Companion documents: `printing-erp-upgrade-audit.md`, `printing-erp-performance-report.md`, `printing-erp-implementation-report.md`, `printing-erp-feature-checklist.md`, `printing-erp-functional-remediation-report.md` (another session), `perf/`, `browser/`.

## 0. How this phase was run

- **Three sessions worked on one tree at the same time.** Besides this one: terra-erp-c5 ("remediation": GSTIN, deactivation, receipts, PO returns/PDF, payroll selection + PF/ESI, job-edit restrictions, sales orders in progress) and terra-erp-a4 ("Wave 0": audit trail, reconciliation, idempotency, migrations runner, tenant-isolation tests). A pricing master (`PriceItem`, `pricingService`) was added by a session other than this one. Ownership was agreed by message; this session did not edit any of their files except two small additive hooks noted below. One duplicate it had built (`/api/receipts`) was removed in favour of the existing `/api/payments/:id/receipt`.
- **Test database hygiene.** The local mongod held **2,758** leftover `terralabs_test_*` databases from crashed runs; index builds took 30 s+ and caused the intermittent "Exceeded timeout for a hook" failures. Throwaway test databases older than 3 hours (2,607) were dropped; all are disposable by design (`tests/helpers/db.js`).
- **No production access.** Every test, benchmark, migration and browser run used local disposable databases. One incident to note: the first browser run started Vite with the client's `.env` (`VITE_FORCE_LOCAL=true`), which points the dev build at `https://api.carbonprintflow.com`. The headless browser's first requests went there and failed (CORS); a test token from a different signing key cannot authenticate there, and no data was read or written. The run was restarted with `VITE_FORCE_LOCAL=false`, and the browser script now **blocks and reports any request leaving localhost** (result: none). Recommend renaming that flag or defaulting it off — its name suggests "local" but it selects the production API.

## 1. Fresh baseline (start of phase)

| Check | Result |
|---|---|
| Backend Jest (full, start of phase) | 60 suites, 978/980 pass; `job-pieces` failed under concurrent edits and passed on re-run |
| Client node tests | 34/34 |
| Client type-check | clean |
| Production-mode build | builds (chunk-size warning only) |
| Browser verification | none existed for these flows |

## 2. Requirement matrix (complete original brief + phase 2)

Status values — *Implementation:* Complete / Partial / Missing / Blocked. *Verification:* API-tested / Browser-verified / Unit-tested / Unverified. "Owner" marks work of another session that this report verifies but did not build.

| Requirement | Initial status | Implementation | Verification | Evidence | Blocker |
|---|---|---|---|---|---|
| 2.1 Server-side customer pagination, search, filters, sort, counts | Missing (downloaded all) | **Complete** — `view`/`gst`/`tag`/`sortBy` (allow-listed), case-insensitive name index, `/customers/stats/summary`, debounced search, cancellation of obsolete requests (`useLoader`) | API-tested (1,500 customers) + **browser-verified** | `server-pagination.test.js`; `browser/customers-*.png` | — |
| Customer pickers without loading every customer | Partial | **Partial** — Discounts, Delivery prefill, Rush-order conversion now query the server; `CustomerSearch` already did. Remaining `listAll('/customers')` users: walk-in customer list (`lib/api/walkIn.ts`) | Type-checked | code | — |
| 2.2 Server-side job tickets (customer, status, stage group, priority, date range, overdue, search) | Partial | **Complete** — `/jobs` filters + `/jobs/stats/summary`; page fetches 25 at a time; list carries no invoice line items | API-tested + browser-verified | `server-pagination.test.js`; `browser/jobs-*.png` | — |
| 2.3 Remaining screens' error handling (12) | Partial | **Complete** for all 12 named + Costs/Staff/Discounts second tables; Settings now refuses to show a form whose load failed (saving it would overwrite real settings) | Type-checked; Jobs offline state **browser-verified** | `browser/jobs-error-state.png` | — |
| 2.4 Performance re-benchmark | — | **Complete** (local) | Measured | §4; `perf/phase2-rtt80.json` | Production numbers need access |
| 3 Draft/official numbering, immutability, cancellation reason, credit/debit notes, FY numbering | Complete (phase 1) | Re-verified | API-tested | `invoice-lifecycle-credit-notes.test.js` 20/20 | — |
| Draft deletion restores stock | Implemented, untested | unchanged | Unverified by test | — | — |
| 3.1 Job → invoice when the job has only an estimate | Buggy (empty items → 400) | **Complete** — one line from the job and its estimate is pre-filled; its GST rate must be entered | Type-checked | code | — |
| 3.2 Atomic quotation conversion | Owner: c5 | Complete (atomic claim + conditional link + rollback) | API-tested (6 concurrent → 1 invoice) | `invoices-quotations.test.js` | — |
| 3.3 Automatic GST rate | Partial | **Complete** for HSN **and SAC** masters and stock items; blank rate refused in UI and server (`''`); an *omitted* field on direct API calls still defaults to 0 (backward compatibility, documented) | Type-checked; server validation API-tested | `recurring-invoices.test.js` (GST_RATE_REQUIRED) | — |
| 4.1 GST reports: GSTR-1 (B2B, B2CL, B2CS, CDNR, CDNUR, nil, HSN B2B/B2C, docs), GSTR-3B summary, sales/purchase/note registers, month/quarter/FY, Excel + CSV, validation, reconciliation | Missing | **Complete** as working papers; **GSTN upload JSON not produced** (schema not verified) | API-tested (11) + browser-verified | `gst-reports.test.js`; `browser/gst-returns*.png` | JSON schema verification |
| Invoice place of supply / reverse charge | Missing | **Complete** (stored, derived, locked once issued) | API-tested | `gst-reports.test.js` | — |
| 4.2 E-invoice (IRN) | Missing | **Partial — infrastructure complete**: eligibility, validation, NIC v1.1 payload, provider interface, one in-flight request, never re-request a generated IRN, attempt history, 24 h cancellation rule, retry | API-tested with a test-only provider | `gst-compliance.test.js` | **Blocked: no GSP/IRP credentials; live never verified** |
| 4.3 E-way bill | Missing | **Partial — infrastructure complete**: transport validation, one active EWB per invoice, threshold is a business-entered setting (not hard-coded) | API-tested with a test-only provider | `gst-compliance.test.js` | **Blocked: no EWB credentials**; cancellation endpoint not built |
| 5 Tally export (ledgers, sales, receipts, purchases, credit/debit notes, GST ledger mapping, preview, history, duplicate warning) | Missing | **Complete** except stock items/units | API-tested | `tally-export.test.js` | **Import into Tally not tested** (no Tally available) |
| 6 Settings: document numbering (invoice series, FY series, 16-char GST limit), item-code prefix, e-invoice/EWB settings | Partial | **Complete for these**; other settings sections (templates, notification preferences, payroll preferences, inventory preferences) **Missing** | API-tested + browser-verified card | `document-numbering.test.js`; `browser/settings-numbering.png` | — |
| 7 Job ticket: editing restrictions (Owner c5), paper selection & sheet pricing (Owner c5), priority, stage tracking | Partial | Owner work verified by its tests; artwork attachments, multiple operator roles, delivery address, quotation→job **Missing** | API-tested (owner) | `job-edit-restrictions`, `job-paper-sheets` | — |
| 8 Recurring invoices (templates, schedule, pause/resume/cancel, history, catch-up, restart recovery, concurrency, failure back-off, drafts by default, optional auto-issue) | Missing | **Complete** | API-tested (9) | `recurring-invoices.test.js` | — |
| 9 Customer & supplier statements (opening, running, closing, ageing, cancelled shown outside balance, reconciliation, PDF, Excel, print) | Missing | **Complete** (supplier payments have no dates in the data model — shown per bill) | API-tested + browser-verified | `statements.test.js`; `browser/customer-statement.png` | — |
| 10 Bulk actions | Missing | **Partial** — customers (select page, export, deactivate/reactivate with per-record results), invoices (issue selected drafts). Jobs/quotations/products/POs **Missing**; no bulk delete of financial records by design | API-tested | `server-pagination.test.js`, `bulk-invoices.test.js` | — |
| 11 PO preview/PDF/send, PO returns/reversal, payment receipts | Owner: c5 | Complete per owner tests | API-tested (owner) | `purchase-order-return-suppliers`, `payment-receipts` | — |
| 12 Payroll selection, PF/ESI | Owner: c5 | Complete per owner tests | API-tested (owner) | `payroll-selection-statutory` 9/9 | Statutory values must be confirmed (see §6) |
| 12 Automatic attendance | Owner | Complete per owner tests | API-tested (owner) | `attendance-at-sign-in` 12/12 | — |
| 13 Supplier deactivate/reactivate UI | Partial (API only) | **Complete** (row actions) + supplier statement action | Type-checked | code | — |
| 13 Stock item code prefix | Buggy (`INV-` like invoices) | **Complete** (`STK-` default, configurable; existing codes untouched) | API-tested | `document-numbering.test.js` | — |
| 14 Index migration | Done (phase 1) | Re-checked; **005** added for phase-2 models (name-aware so collation variants are detected) | plan → up → up (no-op) → status on a disposable DB | §5 | Staging run needs approval |
| 15 Browser verification | Missing | **Partial** — 20 scripted checks with screenshots at 360/390/768/1024/1280 and dark mode on an isolated stack | Browser-verified | `browser/results.json`, 22 PNGs | Full workflow E2E (create/issue/pay/payroll) not scripted |
| Credit/debit notes in GST reports | Missing | **Complete** | API-tested | `gst-reports.test.js` | — |
| Phase-1 items left open: invoice template designer, backup/restore, notification preferences, artwork, quotation→job, duplicate documents | Missing | **Missing** | — | — | — |

## 3. Bugs found and fixed in this phase

1. Job → invoice from a job with only an estimated cost produced an empty invoice that the API refused.
2. Settings page: a failed load showed the form with blank defaults; saving it would have overwritten company details.
3. Purchase-bill scoping for reports: bills carry no `dataScope`; reports now use the business's logins (`orgUserFilter`).
4. Stock item codes used the invoice prefix `INV-`.
5. Credit-note creation waited on an index build at request time (up to 36 s under load) — removed; the index is built at start-up / by migration.
6. Customer search did not match GSTIN although the box says it does.
7. Task detail showed "Task not found" when the request merely failed.
8. Calendar silently showed an empty month when one of its two requests failed.

## 4. Performance (local, 80 ms simulated database round trip — not production)

| Operation | Original (`HEAD`) | Phase 1 | Phase 2 | Notes |
|---|---|---|---|---|
| `/auth/me` P50 | 255 ms | 86 ms | 93 ms | |
| Customers page first view | 9,395 ms (15 sequential pages) | 1,920 ms | **≈ 600 ms** (page 378 ms ‖ summary 601 ms, in parallel) | 52 KB instead of ~1.3 MB |
| Customer search | 716 ms | 450 ms | 486 ms | whole dataset |
| Job Tickets page | 810 ms / 1.38 MB (500 jobs) | 536 ms / 686 KB | **284 ms / 29 KB** (25 + 383 ms summary) | |
| Production board / dashboard pipeline | 810 ms (500 jobs) | 660 ms | 641 ms | all open jobs |
| Dashboard stats | 534 ms | 272 ms | 299 ms | |
| Subscription | 258 ms | 174 ms | 180 ms | |
| GST report (month) | n/a | n/a | 398 ms | |
| Entry bundle (gzip) | 597 KB | 171 KB | 172 KB | 152 chunks; new pages 2–4 KB each |

Phase-2 figures varied ±10 % against phase 1 because other sessions ran test suites on the same machine during measurement. Production latency is unmeasured; deploy, then read the `Server-Timing` header and `slow_request` logs.

## 5. Database changes

New collections: `creditnotes` (phase 1), `recurringinvoices`, `recurringinvoiceruns`, `compliancesettings`, `einvoicerecords`, `ewaybillrecords`, `documentnumberings`, `tallyexports`. New optional fields: `Invoice.placeOfSupply`, `Invoice.reverseCharge`. New index `customer_name_ci` (collation en/2). All additive; no document is rewritten.

**Staging procedure** (never against production without approval):
```
cd backend
node scripts/migrate.js status --uri "$STAGING_URI" --allow-remote
node scripts/migrate.js plan   --uri "$STAGING_URI" --allow-remote   # counts only
node scripts/migrate.js up     --uri "$STAGING_URI" --allow-remote   # off-peak
node scripts/migrate.js status --uri "$STAGING_URI" --allow-remote   # 001–005 applied
```
Verified on a disposable local database: plan → up → up again (no-op) → status "applied". Index builds are online in MongoDB 4.2+, but use I/O; run outside busy hours.

## 6. Statutory sources and decisions

- **B2CL limit:** ₹1,00,000 for invoices from 1 Aug 2024, ₹2,50,000 before (Notification 12/2024–Central Tax, per secondary sources; the official PDF was not retrieved). Encoded as dated parameters in `services/gstReports.js`.
- **HSN digits in GSTR-1 Table 12:** 4 digits up to ₹5 crore AATO, 6 above (Notification 78/2020; GSTN advisories). The report validates against a chosen 4/6.
- **E-way bill limit:** not hard-coded; the business enters it (commonly ₹50,000 under CGST Rule 138, with state variations).
- **IRN cancellation:** within 24 hours of generation.
- **EPF wage ceiling:** official EPFO document shows ₹15,000; multiple sources (incl. newsonair.gov.in) report S.O. 5109(E) raising it to ₹25,000 from 17 Sep 2026. The payroll PF/ESI work is another session's; confirm it uses the effective-dated ceiling.
- **ESI:** 0.75 % employee / 3.25 % employer from 1 Jul 2019 (esic.gov.in); the ₹21,000 coverage limit is from secondary sources.
- **Tally XML:** sign convention from Tally's published XML samples (debit = `ISDEEMEDPOSITIVE` Yes with a negative `AMOUNT`).

Sources: [Notification 12/2024 coverage (Tally help)](https://help.tallysolutions.com/tally-prime/gstr-1/b2c-large-invoices-5a-5b/), [GSTN HSN advisory (MahaGST copy)](https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760596735_345%20Reporting%20of%20HSN%20codes%20in%20Table%2012%20and%20list%20of%20documents%20in%20table%2013%20of%20GSTR%201%201A.pdf), [EPFO contribution rates](https://www.epfindia.gov.in/site_docs/PDFs/MiscPDFs/ContributionRate.pdf), [EPF ceiling ₹25,000 (newsonair)](https://newsonair.gov.in/govt-raises-epf-wage-ceiling-from-rs-15000-to-rs-25000-per-month/), [ESIC contribution](https://esic.gov.in/contribution), [Tally XML transactions](https://help.tallysolutions.com/?p=149474).

## 7. Tests at the end of the phase

| Suite | Result |
|---|---|
| This phase's new backend suites (gst-reports, statements, recurring-invoices, tally-export, gst-compliance, document-numbering, bulk-invoices, server-pagination) | 54/54, each run with `--runInBand` |
| Phase-1 suites re-run (lifecycle/credit notes, pipeline, search, invoice integrity, invoices-quotations, list pages, customer search, inventory guards, job billing) | all pass individually |
| Other sessions' suites verified (payroll-selection-statutory, PO returns, job-edit restrictions, payment receipts, attendance, paper sheets, GSTIN, party deactivation, pricing, tenant isolation 134, audit trail) | all pass |
| Multi-file run of 18 suites | 147 pass / 50 fail **only from hook timeouts** while 19 other Jest workers ran on the same mongod; each failing file passes alone. A clean full-suite run on an idle machine is still required. |
| Client node tests | **38/38** (incl. estimator) |
| Client type-check | clean |
| Client build | succeeds; entry 172 KB gzip |
| Client lint | 379 problems, all `no-explicit-any` / `no-empty-object-type` (was 348 at the start of phase 1; 16 of the new ones are in this phase's files) |
| Backend lint | not runnable — the backend has no ESLint config (pre-existing) |
| Browser (puppeteer, isolated stack, 22 screenshots) | 20/21 checks pass; the "failure" is the expected console error from the deliberately blocked request in the offline test |

## 8. Remaining risks

1. Issued-invoice locking and draft identifiers still need the owner/accountant's sign-off (phase 1).
2. GST working papers are not a filing; no GSTN JSON; classification of 0 % lines as nil/exempt/non-GST must be confirmed per item.
3. E-invoice and e-way bill cannot generate anything until a GSP is contracted and an adapter is written against its API.
4. Tally XML has not been imported into a real Tally company.
5. Two pricing engines may exist (the `PriceItem` master and c5's `ProductRate`); the owning sessions must reconcile them.
6. Recurring invoices with automatic issue will consume official numbers unattended — off by default.
7. Without MongoDB transactions (standalone), a crash between taking a number and saving can skip a number (visible, never reused).

## 9. Completion (against the complete original brief)

Rows from the original 15-phase brief plus phase-2 additions: **74 requirements.**

| | Count | % |
|---|---|---|
| Implementation complete (any session, incl. verified owner work) | 44 | 59 % |
| Partially implemented | 12 | 16 % |
| Missing | 14 | 19 % |
| Blocked (external) | 4 | 5 % |
| **Verified** by automated API tests | 41 | 55 % |
| Verified in a browser (scripted, isolated) | 9 | 12 % |

The browser-verified share is low because full end-to-end workflows (create → issue → pay → statement; payroll run; PO receipt and reversal) were not scripted in a browser in this phase.

## 10. Recommendation

**Staging: CONDITIONAL GO** for the phase-1 and phase-2 work — conditions: owner sign-off on invoice locking; migrations 001–005 applied on staging; a clean full backend suite on an idle machine; a manual pass through the browser screens listed in `browser/results.json`; grant *Invoicing: Credit & Debit Notes*.

**Production / "brief complete": NO-GO.** E-invoice and e-way bill are blocked on credentials, Tally is import-untested, GST JSON is absent, several brief items are missing (§2), and full browser E2E is not in place.

**Next actions (in order):** (1) idle-machine full suite + staging deploy; (2) choose a GSP and write its adapter for `services/gstCompliance.js`; (3) import the Tally XML into a test company; (4) reconcile the two pricing engines; (5) Playwright workflows for invoice → payment → statement, payroll, PO receipt/reversal; (6) remaining missing items: invoice template designer, notification preferences, artwork attachments, quotation → job, duplicate documents, bulk actions on jobs/quotations/products/POs.
