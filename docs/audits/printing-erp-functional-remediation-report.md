# Terra ERP — Functional Remediation Report (round 2)

Date: 2026-11-27. Supersedes the interim report. **No browser end-to-end testing was performed in either round**; "verified" below means verified by backend integration tests against disposable local MongoDB databases, `tsc`, unit tests and a production build. UI changes are type-checked and built, not exercised in a browser.

## 1. Concurrent development

- Working tree grew from 89 → 138 → 154+ modified files; another session is still editing (audit trail, idempotency, transaction journal, reconciliation, permissions). Nothing was stashed, reset, committed or pushed. No connection was made to the Atlas database in `backend/.env`; all tests use per-file databases on local `mongod`.
- The permission failures from round 1 were diagnosed (§3, item 4.4) and fixed without weakening any check.
- **Unstable suites caused by concurrent edits (not by this work):** `invoice-integrity` (beforeAll fails intermittently: `Cannot read properties of undefined (reading 'admin')`; passes in some runs, fails 24/24 in others while its file and the invoice routes are being changed by the other session) and `production-fixes` (4 settings tests: `Settings.create` for the owner returns "My Company"/no WhatsApp token — a settings-document setup issue; this round only touched `PUT /settings/company` validation, which that test does not call). `audit-coverage` failed once in a full run and passed alone. Re-run after the other session settles; I could not isolate a clean baseline because the baseline worktree has no installed dependencies.

## 2. Final test state (last full run)

Backend: 1027 passed / 7 failed in 3 suites (`audit-coverage` flaky, `invoice-integrity`, `production-fixes` — see §1). Frontend: `tsc` clean; `node --test` 34/34; production build succeeds. ESLint: client ~400 problems baseline (mostly `no-explicit-any`, pre-existing, not triaged); files I created are clean (backend has no ESLint config file, so backend lint cannot run). `payments-ledger`/`job-paper-sheets` flakiness: all 26 / all tests fail only when two Jest processes share the machine (full-suite parallel workers on one `mongod`), pass reliably alone and with `--runInBand`; cause is load/timeouts, not an application defect — **not fixed, only characterised**; recommend `jest --runInBand` in CI.

## 3. Requirement table

Status vocabulary: **Verified** = covered by passing automated backend test; **Implemented** = code written, type-checked, built, not browser-tested; **Missing/Blocked** stated explicitly.

| ID | Requirement | Previous | Current | Action taken | Evidence | Remaining |
|---|---|---|---|---|---|---|
| 1 | Job → invoice ("At least one item") | Unverified | Verified (API); UI error display unverified | Re-ran `job-ticket-billing`, `job-ticket-gst`, `job-paper-sheets` — pass; error not reproducible at API level | tests pass | Browser check of toast |
| 2 | Quotation/invoice GST default | Partial | Implemented + API verified | Picking a stock item now sets GST from HSN master, else the item's own rate, else keeps typed value (`pickedGstRate`); explicit 0 never overwritten; blank line rate refused by backend (`400`, "a blank rate is not treated as 0"); placeholder no longer "18" | `invoices-quotations` blank-vs-zero test | Browser; stock `gstRate` default is 18 in schema (model default, unchanged) |
| 3 | GSTIN validation | Verified | Verified | — | `gstin-validation` 4/4 | Existing invalid records only listed by script (not run on shared DB) |
| 4 | Quotation↔invoice lifecycle | Verified | Verified | Added: atomic claim (`conversionLockAt`, stale after 60 s), post-link failure deletes the just-raised draft, release on delete/cancel, history kept, numbers never reused | 5 new tests: 6 simultaneous conversions → exactly 1 invoice; failed conversion leaves no invoice/lock and is retryable; fresh claim blocks / stale does not; issued→payments block cancel→cancel→reconvert gets new number, only one active invoice | Inventory/tax reversal on cancel relies on existing cancel workflow (stock restore + credit-note rules) — not separately re-tested here |
| 5 | Failing suites | Complete | See §2 | — | — | `invoice-integrity`, `production-fixes` unstable (other session) |
| 6 | Automatic attendance | Existing | Existing, tests pass; multi-device/overnight/expired-session not exercised | none (no confirmed gap found) | `attendance-at-sign-in`, `attendance-approved-leave` | Browser/multi-session tests not run. Limitation stands: closing a browser gives no checkout time; no auto-absent |
| 7 | Paper / sheet pricing | Existing | Existing, API verified; **sheets now shown on Jobs list** | Jobs list adds "N sheets" | `job-paper-sheets` (alone), edit restriction tests | Duplicate-paper-line prevention in UI not audited; browser |
| 8 | Job ticket editing | Unverified | Implemented + API verified | Row action "Edit job" reuses the create dialog pre-filled; backend refuses billed-field changes when a live invoice exists (`JOB_INVOICED`), when completed/delivered (`JOB_FINISHED`), and any edit when cancelled (`JOB_CANCELLED`); priority/date/title/notes stay editable; cancelling the invoice unlocks | `job-edit-restrictions` 4/4 | Browser; paper change on an open job does not re-sync stock (stock moves only at invoicing, so none to sync) |
| 9 | Priority consistency | Existing (other session) | Existing | Edit dialog normalises legacy "normal"→"medium" via `lib/priority.ts` | tsc | `lib/priority.ts` is another session's untracked file |
| 10 | `INV-` item codes | Recommendation | **Unchanged — Missing** | Finding: stock SKUs `INV-<ts>-<rand>` share the prefix family of invoice numbers `INV-YYYYMM-n`; no collision (different sequences) but confusing | code read | Configurable prefix not built (needs a Settings field + migration policy; historical SKUs must not change) |
| 11 | Supplier on stock after PO receipt | Unverified | Implemented + verified | Receipt writes `Inventory.suppliers[]` (one entry per supplier, totals, last cost); typed `supplier` filled only when blank; undone with the receipt | `purchase-order-return-suppliers` | Supplier list not yet displayed in the Inventory UI |
| 12 | Selling price default vs saved | Unverified | Unverified | None | `inventory-selling-price` passes (model default `null` distinguishes missing from 0) | UI default vs persisted not audited |
| 13 | Customer delete/deactivate | Verified | Verified | — | `party-deactivation` | — |
| 14 | Supplier deactivate | Backend only | **Implemented + verified; Vendors-page button still absent** | Backend unchanged | tests | Add Deactivate/Reactivate row action to Vendors page (not done) |
| 15 | PO lifecycle / reversal | Unverified | Implemented + verified | `POST /purchase-orders/:id/receipts/:receiptId/reverse` (purchase return): stock out via guarded decrement, `return` movement, receipt kept and marked reversed (who/when/why), reason required, refused if stock already used, 3 simultaneous reversals apply once, can be received again; undo restores order if stock step fails. Drafts/cancelled without receipts deletable (existing) | 3 tests; "Return delivery" action + dialog in PO page | Accounting entry for the return and bill adjustment not implemented (bills are separate documents) |
| 16 | PO preview/print/PDF/send | Missing | Implemented; PDF + email verified at API, UI not browser-tested | `GET /:id/pdf` (inline; `?download=1` file), `POST /:id/send-email`, shared layout, org-scoped; actions Preview / Print / Download / Email in PO page; nothing downloads on save | 2 tests (PDF magic bytes, inline vs attachment, email attachment, 404 cross-org) | WhatsApp send not added; PO model has no tax/HSN so tax shows only if present |
| 17 | Payment receipts | Missing | Implemented; document + route verified, UI not browser-tested | `GET /payments/:id/receipt` + PDF layout (number, customer, date, method, reference, amount, invoices, balance due, company); cancelled/refunded marked invalid; Preview/Print/Download in Payments page | `payment-receipts` 5/5 (partial, multiple, full, split, advance, refunded, scoping) | Receipt number is the payment id (`PAY######`), not a separate sequence |
| 18 | Credit notes | Existing | Existing; suite passes | none | `invoice-lifecycle-credit-notes` | Not re-audited line by line (other session is editing it) |
| 19 | Selected-employee payroll | Unverified | Implemented + verified | `employeeIds[]` (and `employeeId`), invalid/missing/inactive selection → 400 with nothing generated, unique employee+period respected incl. simultaneous runs (duplicate-key race now skipped), paid payslips untouched; Payroll page has an employee picker | `payroll-selection-statutory` | Browser |
| 20 | PF / ESI automation | Missing | Implemented (configurable, opt-in) with partially **unverified** statutory data | `config/statutory.js` effective-dated; `utils/statutory.js`; per-employee opt-in flags; employee deduction replaces fixed amount; employer shares (PF, EPS, EPF, EDLI, ESI) stored on the payslip, not deducted; wages after loss of pay; manual PF/ESI change needs a reason, is audited, flagged and survives regeneration until paid | 9 tests incl. ceilings, split, exemption, opt-out, effective date | See §5 |

Item numbering follows the original brief (1–20). Section-4 items of this round map as: 4.1→1, 4.2→2, 4.3→4, 4.4→§3a below.

### 3a. Permission regressions (4.4)

- `delete-own-account`: closing a business called `deleteMany` on every model, including `ActivityLog`, which the other session made append-only → 500. Fix: `closeBusiness` skips `ActivityLog` (audit trail is retained by design; ages out via retention script). Test passes.
- `user-management` (3 tests): the other session made legacy module-only grants stop carrying `Create Login` / `Edit Permissions`. The test's manager fixture held only the module name; fixture now grants those actions explicitly. Authorization code untouched. Passes 23/23 on two consecutive runs.

## 4. Browser verification, performance, responsive/dark mode

**Not performed.** No browser tooling was driven this session, so no E2E workflow, no 360/390/768/1024 px layout check, no dark-mode check and no timing measurement of the ~15 s customer save was done. I make no claim about them. The earlier-reported customer save time was not investigated beyond noting that the other session's performance work (`requestTiming.js`, index migration) is in the tree.

## 5. Statutory sources (checked 2026-11-27, search snippets of official pages)

- EPF: employee 12%, employer 12%, wage ceiling ₹15,000/month since 01-09-2014; employer 8.33% EPS + 3.67% EPF; EDLI 0.5% — Ministry of Labour EPF Scheme document (labour.gov.in) and EPFO FAQ (epfindia.gov.in/site_en/FAQ.php).
- ESI: employee 0.75%, employer 3.25% w.e.f. 01-07-2019; ≤ ₹176 average daily wage exempt from employee share — esic.gov.in/contribution. Coverage ceiling ₹21,000/month (₹25,000 disability) since 01-01-2017 — esic.gov.in/coverage and ESIC FAQ.
- **Not verified:** EPS monthly cap, rounding rules (implemented as PF nearest rupee, ESI rounded up — flagged `verified:false`, surfaced on the payslip as `unverified`), and whether any 2026 revision or labour-code change altered these figures (sources found were 1–2 years old). **A person must confirm these against the current EPFO/ESIC notifications before relying on payroll output.** Automation is off for every employee until opted in.

## 6. Schema changes (all additive)

`Quotation`: `conversionLockAt`, `statusBeforeConversion`, `conversionHistory[]`. `PurchaseOrder.receipts[]`: `reversedAt/By/ByName/reverseReason`. `Inventory`: `suppliers[]`. `Employee`: `statutory{pfApplicable,pfOnFullWage,esiApplicable,disability}`. `Payroll`: `employerContributions`, `statutory{...}`. No migrations required.

## 7. Files changed (this round)

Backend: `routes/{quotations,invoices,jobs,purchaseOrders,payments,payroll,employees}.js`, `models/{Quotation,PurchaseOrder,Inventory,Employee,Payroll}.js`, `services/{PDFService,quotationLink}.js`, `utils/{closeBusiness,statutory}.js`, `config/statutory.js`, `routes/purchaseBills.js` (exports `getCompanyInfo`); tests: `invoices-quotations` (extended), `job-edit-restrictions`, `purchase-order-return-suppliers`, `payment-receipts`, `payroll-selection-statutory`, `user-management` (fixture). Client: `lib/apiClient.ts`, `components/billing/useHsnGstRates.ts`, `components/quotations/CreateQuotationDialog.tsx`, `components/invoices/AdvancedCreateInvoiceDialog.tsx`, `components/jobs/CreateJobDialog.tsx`, `pages/{Jobs,PurchaseOrders,Payments,Payroll,Employees}.tsx`. Round 1 files as in the earlier report.

## 8. QA cleanup script

`scripts/qa-cleanup-dry-run.js` was run against a disposable database seeded with synthetic QA-named records: it found them, listed the dependent invoice, wrote nothing (counts unchanged afterwards), and has no write path. Not run against any shared database.

## 9. Completion (original 20 items)

- **Verified by automated tests (backend/API):** 3, 4, 5*, 13, 14 (backend), 15, 19, 20 (mechanics), plus existing 1, 6, 7, 18 → 12 items. (*5 with the two unstable suites noted.)
- **Implemented, partly verified or UI-unverified:** 2, 8, 11, 16, 17 → 5 items.
- **Not done / unverified:** 9 (other session), 10, 12, plus Vendors-page button for 14 → 3 items.

Verified completion ≈ **60%** of the brief (12/20), implementation completion ≈ **85%** (17/20 touched), **0%** browser-verified. 100% was not reached.

## 10. Release readiness

**NO-GO.** Blockers: no browser/responsive/performance verification; PF/ESI statutory data partially unverified; two backend suites unstable under the concurrent session; items 10, 12 and the Vendors-page deactivate button outstanding. The backend changes are safe to review and merge once the other session's work settles and the full suite is green with `--runInBand`.
