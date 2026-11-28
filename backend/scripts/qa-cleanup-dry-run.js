#!/usr/bin/env node
/**
 * DRY RUN ONLY. Finds the QA test records (customer "QA TEST Customer",
 * quotation QUO-202611-0003, purchase order PO-202611-0004, supplier
 * "QA TEST Supplier"), shows every dependent record, and prints a deletion
 * plan. It performs no writes: there is deliberately no --execute flag.
 * Invoice number INV-202611-0004 is NOT recreated or reused.
 *
 *   MONGODB_URI=<db to inspect> node scripts/qa-cleanup-dry-run.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TARGETS = {
  customer: { collection: 'customers', filter: { name: 'QA TEST Customer' } },
  quotation: { collection: 'quotations', filter: { quotationNumber: 'QUO-202611-0003' } },
  purchaseOrder: { collection: 'purchaseorders', filter: { poNumber: 'PO-202611-0004' } },
  supplier: { collection: 'vendors', filter: { name: 'QA TEST Supplier' } }
};

async function count(db, coll, filter) {
  return db.collection(coll).countDocuments(filter);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}  (read-only)\n`);
  const found = {};
  for (const [key, t] of Object.entries(TARGETS)) {
    found[key] = await db.collection(t.collection).find(t.filter).toArray();
    console.log(`${key}: ${found[key].length} match(es)`);
    for (const d of found[key]) console.log(`  _id=${d._id} owner=${d.userId} scope=${d.dataScope || '-'} created=${d.createdAt?.toISOString?.()}`);
  }

  console.log('\nDependents:');
  for (const c of found.customer) {
    for (const [coll, field] of [['invoices', 'customerId'], ['jobs', 'customerId'], ['quotations', 'customer_id'], ['payments', 'customerId'], ['creditnotes', 'customerId'], ['accounttransactions', 'customerId']]) {
      console.log(`  customer ${c._id} -> ${coll}.${field}: ${await count(db, coll, { [field]: c._id })}`);
    }
  }
  for (const v of found.supplier) {
    for (const [coll, field] of [['purchaseorders', 'vendorId'], ['purchasebills', 'vendorId'], ['costs', 'vendorId'], ['accounttransactions', 'vendorId'], ['cheques', 'vendorId']]) {
      console.log(`  supplier ${v._id} -> ${coll}.${field}: ${await count(db, coll, { [field]: v._id })}`);
    }
  }
  for (const po of found.purchaseOrder) {
    console.log(`  PO ${po.poNumber} status=${po.status} receipts=${(po.receipts || []).length}`);
    console.log(`    inventory movements: ${await count(db, 'inventorymovements', { $or: [{ purchaseOrderId: po._id }, { reference: po.poNumber }] })}`);
    console.log(`    purchase bills: ${await count(db, 'purchasebills', { purchaseOrderId: po._id })}`);
  }
  for (const q of found.quotation) {
    console.log(`  quotation ${q.quotationNumber} status=${q.status} convertedInvoice=${q.convertedInvoiceNumber || '-'}`);
  }

  console.log(`
Suggested order (run manually, after review and approval, never on production):
  1. If a PO was received: reverse its stock receipt (inventory movements) before touching the PO. A received PO
     should be kept or reversed, not hard-deleted.
  2. Delete the quotation, then the PO (only if draft/cancelled), then the supplier (only with zero dependents).
  3. Delete the customer only with zero invoices/jobs/payments; otherwise deactivate it.
  4. Do NOT renumber or reuse INV-202611-0004; the gap stays as the audit trail of a deleted draft.
Nothing was changed.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
