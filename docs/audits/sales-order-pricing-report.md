# Sales Order Approval and Advanced Product Pricing — Report

Date: 2026-11-27. Brief: the customer's PRINT-PAS demonstration. No commit, push, deploy or shared/production database access: every test ran on throw-away local MongoDB databases (backend) or the isolated `terralabs_e2e_so` database on ports 4201/8181 (browser).

## 0. Decision needed first: two pricing engines

Another session's **Pricing Master** (`services/pricingService.js`, `models/PriceItem.js`, `CustomerItemRate.js`, `routes/priceItems.js`, permission "Pricing Master", `/pricing` page) already exists and is wired into invoices and quotations (`resolveLinePrices`, `pricingSnapshot`). It owns simple customer-rate / quantity-slab / inclusive pricing. The brief forbids duplicate pricing engines, but that engine lacks what this brief needs (party type, sales type, ranged slabs with an open end, per-slab inclusive+exclusive, area pricing, minimum rules, order totals). I therefore built the richer engine (`utils/productPricing.js`, `models/ProductRate.js`) **without touching, calling or wiring into** the other module, and asked its owner (terra-erp-a4). Their answer: they lean to **Option A — ProductRate becomes the single master**, `pricingService.resolveLinePrices` stays the only entry point from documents and delegates to it, with a migration from PriceItem/CustomerItemRate — but it is the users' call, and they asked me not to wire ProductRate into invoices/quotations until then. I have not. **Until decided, the tree has two masters and two Settings entries ("Pricing Master", "Product Rates").** Nothing breaks, but staff would see both.

## 1. Gap audit (before implementation)

| # | Requirement | Found | Class |
|---|---|---|---|
| 1 | Sales order: number, date, quotation fetch, project, sales type, party, mobile/state/GSTIN/address, copy option | Job tickets and quotations existed; no order number, project name, sales type, approval, quotation→order link | Partially implemented (job ticket) |
| 1 | Multi-product lines: material, product, copies, rate, unit, sq-ft, discount, GST, wastage, work type, stages | Job `items` had name/qty/price/GST/area only | Partially implemented |
| 2 | Server-side automatic pricing | Area pricing helper existed (`billing.priceLine`); no resolution by customer/party/sales type | Missing |
| 3 | Product rate master, searchable, per customer/party/sales type | Only `CustomerPricing` (discount %) and the other session's simple Pricing Master | Missing (a partial different engine exists) |
| 4 | Slabs (from/to/excl/incl/minimum), open last slab, overlap prevention | Other session: from-only `minQty` slabs | Missing as specified |
| 5 | GST inclusive/exclusive both ways | Other session: single `taxInclusive` flag per item | Partially implemented |
| 6 | Minimum rules | none | Missing |
| 7 | Priority + warning on no rate + audited override + snapshot | Other session: override with reason + snapshot on its lines | Partially implemented (different engine) |
| 8 | Other charges, summary with CGST/SGST/IGST/cess/non-taxable/round-off/advance/balance | Invoice totals existed; no order summary, no advance | Missing |
| 9 | Approval queue | none (proofing has its own approval) | Missing |
| 10 | Production integration | Job status/flow stages existed; counter jobs and quick sales exist | Partially implemented |
| 12–13 | Server-side search/pagination, indexes, tenant isolation, audit | Patterns existed | Applied to new code |

## 2. What was implemented

**Design:** a sales order **is** a job ticket (`Job` with `isSalesOrder: true`), so there is one order, one production record and one invoice, and every existing job/quick-sale/counter-job path is untouched (test: a plain job has none of the new fields and is "not found" at `/api/sales-orders`).

Backend
- `utils/productPricing.js` — pure engine: rule resolution (customer 100 > party 20 > sales 10 > default; unique triple per product so ties are impossible), slab validation and selection, GST inclusive/exclusive, area pricing (ft/in/m/cm), minimum quantity/amount, discounts, rate override with snapshot, order totals.
- `models/ProductRate.js`, `routes/productRates.js` (`/api/product-rates`: paginated search by name/code/material type, CRUD with deactivate-not-delete, `POST /price` preview, audit entries), `services/salesOrderPricing.js` (loads customer/products, enforces discount and override permissions, 15 s product cache invalidated on every master write; saves always read fresh).
- `routes/salesOrders.js` (`/api/sales-orders`): create (server prices everything, ignores client amounts, idempotent `clientRequestId`, order number `SO-YYYYMM-####` from the atomic `NumberSequence`), edit while pending, queue with search/filters/pagination/counts (one aggregate for every row's paid amount — no per-row queries), approve (atomic), cancel (reason, blocked when invoiced or production done), delete (blocked unless pending/cancelled with no invoice/payment/production), stage transitions (design → printing → finishing, skip, order enforced), draft invoice from order (atomic claim, no orphan on failure), quotation prefill and one live order per quotation.
- Advance: a normal on-account **Payment** with `salesOrderId` through the existing `POST /api/payments` (so idempotency, accounts posting and duplicate protection are the existing ones); the order's paid/balance/excess are read from payments, never stored twice.
- Permissions: new modules "Sales Orders" (View, Create & Edit, Approve, Cancel, Delete, Apply Discount, Override Rate, Change Stage) and "Product Rates". Every action is checked on the backend.
- Schema (additive): `Job` (isSalesOrder, orderNumber, orderDate, projectName, salesType, partyType, copyOption, quotationId, activeQuotationKey, clientRequestId, customerSnapshot, orderLines, otherCharges, orderTotals, approval, production, salesInvoiceId + claim, four partial indexes), `Payment.salesOrderId`, `ProductRate` (new), `ActivityLog` entity type `product_rate`. No migration needed; existing records are unaffected.

Frontend: `pages/ProductRates.tsx` (two-pane master: searchable list, material filter, selected product highlighted, rules and slabs editable in place, inclusive↔exclusive sync, server errors listed), `pages/SalesOrders.tsx` (approval queue with the requested columns, search, date and approval filters, pagination, refresh, approve / edit / stages / advance / invoice / cancel / delete), `components/salesOrders/SalesOrderEditor.tsx` (server-side customer and product type-ahead, multi-line, stages per line, other charges, live server pricing with Retry, entries kept on API failure). Nav + routes + permission tree updated. No amount is calculated in the browser.

## 3. Pricing examples (all asserted in tests)

| Case | Result |
|---|---|
| Slabs 1–100 ₹15, 101–500 ₹12, 501+ ₹10; 100 / 101 / 501 copies | ₹15 / ₹12 / ₹10; 100 × ₹15 + 18% = ₹1,770; 101 × ₹12 + 18% = ₹1,430.16 |
| ₹10.17 exclusive ↔ ₹12 inclusive at 18% | reconcile both ways; 100 × ₹12 inclusive bills exactly ₹1,200 (taxable ₹1,016.95 + GST ₹183.05) |
| Priority | Walk-in customer rule ₹14 beats Agency ₹8 beats Wholesale ₹9 beats default ₹15 |
| Area | 6×4 ft × 10 copies = 240 sq ft @ ₹10 → ₹2,400 + ₹432 GST |
| Minimums | qty min 20, amount min ₹500: 5 copies @ ₹10 → billed 20 and ₹500, both reported |
| Order | ₹900 taxable + ₹100 delivery @18%: CGST ₹81 + SGST ₹81 → ₹1,062; advance ₹500 → balance ₹562; inter-state → IGST; ₹1,430.16 rounds to ₹1,430 (round-off −₹0.16), excess shown when advance > total |
| No matching rate | warning "No rate is configured…", never ₹0; saving is refused (422) |

## 4. Tests

- Backend: `product-pricing-engine` 22 + `sales-orders` 26 new tests; full suite **77 suites / 1,161 tests pass** (`--runInBand`). Covers customer/party/default pricing, quantity and area slabs and boundaries, overlap/duplicate/negative/mismatch refusals, inclusive/exclusive, minimums, discounts, other charges, advance/balance/excess, approval permission (403 with the required action) and concurrency (3 approvals → 1; 4 invoicings → 1 invoice), stage order/skip/permissions, historical preservation (rate master changed afterwards; order keeps its price), tenant isolation, duplicate order (concurrent same request id → 1) and duplicate advance (same key → 1 payment).
- Frontend: `tsc` clean, unit tests 38/38, production build succeeds; new files lint-clean (repo ESLint debt elsewhere unchanged).
- **Browser (Playwright, Chromium, real UI + real API + isolated DB): 4/4 pass, 3 consecutive full runs** (one earlier run failed once while the machine was loaded by a concurrent build and passed on rerun): product-rate master (select, GST sides reconcile 12 → 10.17, overlap refused, valid save); full order flow (customer search, product search, live ₹944 → ₹953.44 → ₹944 as copies change, create, queue shows pending, approve, start/complete printing, ₹400 advance → balance ₹544, create invoice once and the action disappears); unpriced line warning and refusal; **390 px + dark mode** pass on queue, rate master and editor (no sideways scroll; screenshots reviewed).

## 5. Performance (disposable DB, 5,000 products, 20,000 orders)

| Operation | median | p95 |
|---|---|---|
| Queue page 1 / filtered / deep page 500 | 25 ms | 28–41 ms |
| Queue search by order number | 33 ms | 115 ms |
| Product search / material filter | 7.7 ms / 3.3 ms | 10 / 4 ms |
| Server price, 1 line / 8 lines + charge | 3.1 ms / 3.2 ms | 13 / 5 ms |

The queue's winning plan uses the index (15 documents examined for 15 returned). No before/after is possible: the feature did not exist. The earlier customer-save time (~15 s) was not investigated in this brief.

## 6. Remaining gaps and business decisions

1. **Which pricing master wins** (§0): ProductRate (Option A) or the other session's Pricing Master.
2. **"Minimum" toggle**: stored and shown per slab but changes no price; the engine instead has explicit minimum quantity/area and minimum amount per rule. Confirm what the reference software means.
3. **"Default copy / no copy"** is stored and displayed only; its intended effect (print copies? duplicate document?) is unverified.
4. Customer "party type" uses the existing categories (Walk-in, Agency, Individual, Business, Corporate). "Regular", "Agent" and "Wholesale" customers do not exist as categories ("Wholesale" is modelled as a **sales type**; "Agent" ≈ Agency). Sales type is free text with Retail/Wholesale/Project suggestions.
5. Customers have no `state` field: inter-state is decided from the GSTINs (customer vs business), else the explicit flag.
6. The draft invoice created from an order carries the order's **net unit rates** (discount and minimums folded in, 4-decimal rounding), so its total can differ from the order by up to ₹0.05; discount is not shown separately on that invoice. The advance stays on account until applied to the invoice in Payments (not auto-allocated).
7. Wastage is recorded for production only (no stock effect). Stage assignee selection is supported by the API (`assigneeId`) but the stage dialog has no staff picker.
8. Role presets (Shop manager etc.) were **not** updated: Sales Orders / Product Rates must be granted to roles by the owner. Admin has everything.
9. Not browser-tested: editing a pending order, cancel/delete dialogs, quotation fetch, 768/1024 px layouts, keyboard-only use. The pending/legacy "Jobs" list shows sales orders as ordinary job tickets (by design).
10. Product-rate deactivation is the only removal (history is kept); no bulk import.

## 7. Verdict

**Backend: ready for review.** Engine and workflow are tested for the money, concurrency, permission and isolation rules. **Not yet production-ready as a whole**: decision 1 (two pricing masters) must be made first, decisions 2–3 need the customer's answer, and the unchecked browser paths in gap 9 and role-preset setup (gap 8) remain. Nothing was committed or deployed.
