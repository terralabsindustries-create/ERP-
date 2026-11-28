# Master data and quantity-based pricing: audit and implementation report

## 1. Initial audit findings
| Area | Before | Status |
|---|---|---|
| Item master | `Inventory` stock items with `sellingPrice`, `hsnCode`, `gstRate`; no digital/flex/offset item types, media, GSM, size, simplex/duplex | Partial |
| Quantity pricing | None anywhere (no slabs/breaks); estimator `printEstimate.ts` prices cost-plus, not sale rates | Missing |
| Customer pricing | `CustomerPricing`: a % discount plus `specialRates[{jobType, rate}]`; only the % is used (`/discounts/calculate`); special rates are never applied to lines | Partial / incorrect |
| Pricing priority | Best-of discount candidates (customer % vs discount rules); no rate priority | Different concept |
| GST | Line prices are always GST-exclusive; no inclusive pricing; CGST/SGST/IGST and rounding in `utils/billing.js` (mirrored in `client/src/lib/billing.ts`) are sound | Partial |
| Snapshots | Invoice lines store the rate but not how it was decided | Missing |
| Master-data navigation | Separate pages (HSN, SAC, customers, employees, vendors, inventory); no Tax/Bank/Machine/Outsource/Job-status masters, no central menu | Partial / missing |

## 2. Root causes
Pricing was "whatever rate the user typed", with `sellingPrice` as a single prefill. There was no slab model, no server-side rate resolution, and `CustomerPricing.specialRates` was keyed by a free-text job type that no document links to.

## 3. Implemented
Pricing Master vertical slice (`PriceItem`, `CustomerItemRate`, `services/pricingService.js`, `routes/priceItems.js`, `pages/PricingMaster.tsx`): digital/flex/offset/general items with media, paper, GSM, size, simplex/duplex, HSN, GST rate, inclusive/exclusive, optional stock-item link, active flag; quantity slabs (add/edit/delete in the UI, auto-sorted, duplicate/zero/negative/blank refused client and server, range display, live preview); customer-specific fixed rates and slabs with history; manual override (separate permission, reason required).
Priority implemented: override > customer slab > customer fixed > item slab > item default. Existing logic checked first: none existed for rates, so nothing was replaced; the old discount flow is untouched.
Server-side integration: invoice and quotation create/edit resolve any line carrying `priceItemId` through the one service; the server ignores client prices for such lines, stores `pricingSnapshot` (source, rate, slab, tax mode, reason, time) on the line, keeps the stored price on edit when item and quantity are unchanged (re-prices only when the quantity changes), and quotation→invoice carries the snapshot and price.

## 4. Database and API
New collections `priceitems`, `customeritemrates` (indexed on dataScope/type/name; unique customer+item per tenant); `pricingSnapshot` on invoice items, `pricing_snapshot` on quotation items; migration `004-pricing-master-collections` (additive). API: `/api/price-items` CRUD (deactivate, never delete), `POST /quote`, `/:id/customer-rates`. Permissions: new module `Pricing Master` (View, Create & Edit, Delete, Customer Rates, Override Price). Audited: item create/update/deactivate, customer rate save/remove (protected entries).

## 5. Frontend
`/pricing` Pricing Master page (search, type/media filters, edit, deactivate, slab editor, preview, customer rates, loading/empty/error-with-Retry), sidebar entry, `lib/pricing.ts` (mirrors server; node tests prove agreement).

## 6. Examples (slabs 1/11/50/100/500/1000/2500 = 25/23/22/20/18/15/13)
5→₹25, 25→₹23, 75→₹22, 150→₹20, 750→₹18, 1,500→₹15, 3,000→₹13. 150 units exclusive of 18% GST = 3,000 + 540 = ₹3,540 (whole line at ₹20, not progressive). Inclusive ₹118 × 10 at 18% → taxable 1,000, GST 180, total 1,180. Inclusive large lines: unit ex-tax price stored to 8 dp so qty×price reproduces the gross within a paisa (found and fixed during testing: 4 dp drifted ₹0.15 at 2,500 units).

## 7. Tests
Backend `pricing-unit` (15) and `pricing-api` (29): all 13 required boundary quantities, spec examples, validation, priority, override permission/reason, inclusive/exclusive, snapshots, master change vs issued invoice, quotation→invoice price preservation, tenant isolation, backward compatibility for plain lines. Client `pricing.test.mjs` (4, backend agreement). Regression subset 376/376 pass (invoices, quotations, integrity, billing math, tenant isolation, access control, migrations, credit notes).

## 8. Browser verification
Playwright (isolated local stack): create an item with three slabs through the UI, ranges shown, preview "75 × ₹22 = ₹1,947" (1,650 + 18% GST), duplicate quantity flagged and removed, save lists the item; a 500 on the item list shows an error, not "No items yet". 2/2 pass; the earlier 15 smoke tests passed before another session's specs were added to the shared `e2e/` folder.

## 9. Not done / limitations (important)
- **Sales screens do not yet use it.** Job ticket, counter job, quotation and invoice forms have no item picker that calls `/quote` and recalculates live or shows "customer rate applied". The server resolves `priceItemId` lines and `/quote` exists, but the forms were not changed. This is the biggest gap against Phase 6; no sales-order module existed in my scope.
- Masters not built: Employee/Tax/Client/Job Status/Machine/Outsource/Bank masters and the central navigation (existing pages cover employees, customers, HSN/SAC, vendors; none of the others exist). Only Pricing Master was added.
- Only slab pricing by quantity; no area (sq ft), minimum amount, or party-type/sales-type rules. Stock-item link is stored but not used for deduction.
- Another session (c5) built a separate `ProductRate` engine in the same tree. Two pricing engines exist; the users must pick one (c5 and I agreed neither wires its engine into invoices/quotations of the other, and to ask users). Option A: ProductRate as master with migration; Option B: extend PriceItem.
- Inclusive pricing can differ from the gross by ≤ ₹0.01 after the invoice recomputes GST; the quote shows the gross, the invoice may be a paisa off.
- No retention/permission UI for override in forms; history is per customer rate only (item price history is in the audit log).

## 10. Production readiness: **NOT READY for the stated scope**
The pricing engine, API, audit and Pricing Master screen are tested and safe to ship dark (additive, no change for lines without `priceItemId`). The feature as requested (auto-pricing in the sales workflows, remaining masters) is incomplete, and the duplicate-engine decision is open. Nothing committed or deployed.
