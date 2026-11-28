# Financial and stock integrity report

## Customer metrics (Task 2)
Root cause confirmed: `Customer.updateStats` set `totalRevenue` = sum of `Job.estimatedCost` (a production estimate, including cancelled jobs).
Single definition now in `backend/src/services/customerFinancials.js`, used by customer detail, list, update-stats, reconciliation and migration 003:

| Metric | Definition |
|---|---|
| estimatedJobValue | Σ `Job.estimatedCost`, non-cancelled. Not revenue |
| grossInvoiced | Σ `totalAmount` of issued invoices (sent/paid/overdue), GST included |
| invoicedRevenue (`totalRevenue`) | grossInvoiced + debit notes − issued credit notes |
| cancelledInvoiced | cancelled/refunded invoices; shown, never in revenue |
| paymentsReceived (`totalSpent`) | completed payments |
| outstanding | Σ issued invoice `balanceAmount` − unapplied advances |

Tests: `customer-financials.test.js` (unpaid, partial, paid, cancelled, draft, foreign tenant, credit/debit notes, advance; record = list = update-stats = customer report).
**Not done / honest gaps:** the dashboard and `routes/jobs.js` stats still use `estimatedCost` for a "monthly revenue" figure (`jobs.js:865`); the monthly reports already use invoice totals. Credit-note issue on a customer whose notes reference a cancelled invoice is excluded. Business should confirm that revenue is GST-inclusive (reports already are).

## Transactions (Task 6)
`utils/transactions.js`: with transactions → atomic. Without (standalone Mongo): a durable `TransactionJournal` entry is written before the work; removed on success or full undo; if undo steps fail → `compensation_failed` record + critical log + optional `ALERT_WEBHOOK_URL` post; the thrown error carries `compensationFailed`/`failureId`. A process kill leaves a `started` entry, reported after 10 min by reconciliation as `INTERRUPTED_OPERATION`. Invoice creation (hand-written step path) and all `inTransaction` callers (payments, payroll pay, PO receive, stock adjust, payment accounts) use it. Cancel-invoice with failed stock restore now records a failure instead of reporting success.
Idempotency: `Idempotency-Key` header on invoice create and stock adjust (per-tenant, request-fingerprinted, 48 h TTL; failed attempts release the key). Payments and PO receipt already had keys.
Fault injection: `transaction-reliability.test.js` (failure at each stage, failed undo, failed invoice delete, stock not restorable, duplicate/simultaneous keys).
**Production topology: undocumented.** The code treats a replica set/mongos as transactional (Atlas always is) and detects it at runtime; whether production is Atlas or standalone could not be verified (no credentials). Run `db.hello()` on production and record `setName`. Until confirmed, assume the compensating path.
Not covered: no recovery *automation* for interrupted operations (manual review by design); idempotency not yet applied to quotation→invoice conversion or credit-note issue (credit notes already carry keys).

## Reconciliation (Task 7)
`GET /api/reconciliation` (permission `Reconciliation: View`), read-only: invoice vs payments/notes, customer stats, vendor bill balances, stock vs last movement, PO receipts vs stock movements, cancelled docs vs payments/stock reversal, failed/interrupted operations. `POST /api/reconciliation/resolve` (`Reconciliation: Resolve`) offers only two audited corrections: refresh derived customer stats, resolve a failed operation with a note. Balances, stock and payments are never silently changed; they go through Correct Balance / Adjust Stock / Payments. Tests: `reconciliation.test.js`. Limit: vendor *payment* balances are checked at bill level only; purchase-bill-to-inventory linkage not checked (no link exists in the model).

## Audit trail (Task 5)
Append-only (`AUDIT_IMMUTABLE` on every update/delete path, 405 on the DELETE route, UI delete removed), tenantId, correlationId (`X-Correlation-ID`), reason, before/after, secret redaction, `protected` flag. Retention: `scripts/audit-retention.js` (dry run default; 365 d ordinary, 2,922 d protected; env-tunable; run recorded). Newly covered: payroll generate/adjust/pay/delete, payment reversal, invoice cancel reason. Tests: `audit-trail.test.js`, `audit-coverage.test.js`.
Gaps: application-level immutability does not stop someone with database credentials (needs DB role / hash chain / WORM export: recommendation for Wave 1). Purchase-order **receipt** and **PO status** events are logged under entity type `inventory`, flagged protected via that type. Artwork approval is logged by the existing proof route; customer-side portal approval does not exist.
