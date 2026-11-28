/**
 * Reconciliation checks. READ ONLY: nothing here changes a record. Every check
 * returns findings (code, entity, expected vs found) for a person to review;
 * corrections happen only through explicit, permissioned, audited actions
 * (routes/reconciliation.js) or the existing Correct Balance workflow.
 *
 * Checks
 *   invoice_payments      issued invoice paid/balance vs completed payment allocations and credit/debit notes
 *   customer_balances     customer.outstandingBalance / totalRevenue / totalSpent vs recomputed (services/customerFinancials)
 *   vendor_balances       purchase bill balance vs total − paid
 *   inventory_movements   item quantity vs the last stock movement's resulting quantity
 *   purchase_receipts     purchase-order receipt lines vs stock movements recorded for the order
 *   cancelled_documents   cancelled invoices vs payments still applied and stock returned
 *   operations            interrupted or failed-to-undo multi-step writes (TransactionJournal)
 */
const mongoose = require('mongoose');

const EPS = 0.01;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 10000) / 10000;
const LIMIT = 500;
const INTERRUPTED_AFTER_MS = Number(process.env.RECONCILE_INTERRUPTED_AFTER_MS || 10 * 60 * 1000);

const ISSUED = ['sent', 'paid', 'overdue'];

const finding = (code, severity, entityType, entity, message, expected, found, fix) => ({ code, severity, entityType, entityId: String(entity._id || entity), entityNumber: entity.invoiceNumber || entity.billNumber || entity.poNumber || entity.name, message, expected, found, suggestedAction: fix });

async function invoicePayments(scope) {
  const Invoice = mongoose.model('Invoice');
  const Payment = mongoose.model('Payment');
  const out = [];
  const invoices = await Invoice.find({ ...scope, status: { $in: [...ISSUED, 'cancelled', 'refunded'] } })
    .select('invoiceNumber status totalAmount paidAmount balanceAmount manualPaidAmount creditNoteApplied debitNoteTotal').lean();
  const recorded = new Map();
  const payments = await Payment.find({ ...scope, status: 'completed' }).select('amount allocations invoiceId').lean();
  for (const p of payments) {
    const list = p.allocations?.length ? p.allocations : p.invoiceId ? [{ invoiceId: p.invoiceId, amount: p.amount }] : [];
    for (const a of list) recorded.set(String(a.invoiceId), round2((recorded.get(String(a.invoiceId)) || 0) + a.amount));
  }
  for (const inv of invoices) {
    if (inv.status === 'cancelled' || inv.status === 'refunded') continue;
    const paid = round2(inv.paidAmount);
    const fromPayments = recorded.get(String(inv._id)) || 0;
    const receivable = round2(inv.totalAmount + (inv.debitNoteTotal || 0));
    const expectedBalance = round2(Math.max(0, receivable - (inv.creditNoteApplied || 0) - paid));
    if (paid > receivable + EPS) out.push(finding('OVERPAID', 'high', 'invoice', inv, 'Paid amount exceeds what the invoice is worth', { maxPaid: receivable }, { paid }, 'Review the payments; refund or reallocate the excess.'));
    if (Math.abs(round2(inv.balanceAmount) - expectedBalance) > EPS) out.push(finding('BALANCE_MISMATCH', 'high', 'invoice', inv, 'Balance does not equal total + debit notes − credit notes − paid', { balance: expectedBalance }, { balance: round2(inv.balanceAmount) }, 'Open the invoice and re-save, or use Correct Balance with a reason.'));
    if (paid + EPS < fromPayments) out.push(finding('PAYMENTS_NOT_REFLECTED', 'high', 'invoice', inv, 'Completed payments applied to this invoice exceed the paid amount shown on it', { paidAtLeast: fromPayments }, { paid }, 'Re-apply or reverse the payment through the Payments screen.'));
    if (inv.manualPaidAmount !== undefined && inv.manualPaidAmount !== null && Math.abs(paid - round2(fromPayments + inv.manualPaidAmount)) > EPS) {
      out.push(finding('MANUAL_PAID_INCONSISTENT', 'medium', 'invoice', inv, 'Paid amount differs from payments + the amount recorded directly on the invoice', { paid: round2(fromPayments + inv.manualPaidAmount) }, { paid }, 'Use Correct Balance with a reason.'));
    }
    if (inv.status === 'paid' && expectedBalance > EPS) out.push(finding('MARKED_PAID_WITH_BALANCE', 'high', 'invoice', inv, 'Invoice is marked paid but a balance remains', { balance: 0 }, { balance: expectedBalance }, 'Record the missing payment or correct the status.'));
  }
  return out;
}

async function customerBalances(scope) {
  const Customer = mongoose.model('Customer');
  const { financialsFor } = require('./customerFinancials');
  const customers = await Customer.find({ ...scope }).select('name outstandingBalance totalRevenue totalSpent').lean().limit(5000);
  const out = [];
  for (let i = 0; i < customers.length; i += 200) {
    const batch = customers.slice(i, i + 200);
    const f = await financialsFor(batch.map((c) => c._id), scope);
    for (const c of batch) {
      const x = f.get(String(c._id));
      const diffs = {};
      if (Math.abs(round2(c.outstandingBalance) - x.outstanding) > EPS) diffs.outstandingBalance = [round2(c.outstandingBalance), x.outstanding];
      if (Math.abs(round2(c.totalRevenue) - x.invoicedRevenue) > EPS) diffs.totalRevenue = [round2(c.totalRevenue), x.invoicedRevenue];
      if (Math.abs(round2(c.totalSpent) - x.paymentsReceived) > EPS) diffs.totalSpent = [round2(c.totalSpent), x.paymentsReceived];
      if (Object.keys(diffs).length) out.push(finding('STALE_CUSTOMER_STATS', 'medium', 'customer', c, 'Stored customer totals differ from the invoices and payments', Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, v[1]])), Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, v[0]])), 'Refresh customer statistics (derived data; safe to recompute).'));
    }
  }
  return out;
}

async function vendorBalances(scope) {
  const PurchaseBill = mongoose.model('PurchaseBill');
  const bills = await PurchaseBill.find({ ...scope }).select('billNumber totalAmount paidAmount balanceAmount status').lean();
  const out = [];
  for (const b of bills) {
    if (b.status === 'cancelled') continue;
    const expected = round2(b.totalAmount - (b.paidAmount || 0));
    if (Math.abs(round2(b.balanceAmount) - expected) > EPS) out.push(finding('BILL_BALANCE_MISMATCH', 'high', 'purchase_bill', b, 'Bill balance does not equal total − paid', { balance: expected }, { balance: round2(b.balanceAmount) }, 'Open the bill and re-save, or correct the payment.'));
    if ((b.paidAmount || 0) > b.totalAmount + EPS) out.push(finding('BILL_OVERPAID', 'high', 'purchase_bill', b, 'Paid exceeds the bill total', { maxPaid: b.totalAmount }, { paid: b.paidAmount }, 'Review the vendor payments.'));
  }
  return out;
}

async function inventoryMovements(scope) {
  const Inventory = mongoose.model('Inventory');
  const InventoryMovement = mongoose.model('InventoryMovement');
  const last = await InventoryMovement.aggregate([
    { $match: { ...scope } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: '$inventoryItem', newQuantity: { $last: '$newQuantity' }, movements: { $sum: 1 } } }
  ]);
  const byItem = new Map(last.map((r) => [String(r._id), r]));
  const items = await Inventory.find({ ...scope }).select('name quantity').lean();
  const out = [];
  for (const item of items) {
    const m = byItem.get(String(item._id));
    if (m && Math.abs(round4(item.quantity) - round4(m.newQuantity)) > 0.0001) {
      out.push(finding('QUANTITY_DRIFT', 'high', 'inventory', item, 'Stock on hand differs from the last recorded movement', { quantity: round4(m.newQuantity) }, { quantity: round4(item.quantity) }, 'Count the stock and record an Adjust Stock entry with a reason (this creates the missing movement; the quantity is not edited silently).'));
    }
  }
  return out;
}

async function purchaseReceipts(scope) {
  const PurchaseOrder = mongoose.model('PurchaseOrder');
  const InventoryMovement = mongoose.model('InventoryMovement');
  const pos = await PurchaseOrder.find({ ...scope, 'receipts.0': { $exists: true } }).select('poNumber receipts').lean();
  if (!pos.length) return [];
  const moves = await InventoryMovement.aggregate([
    { $match: { referenceType: 'purchase_order', referenceId: { $in: pos.map((p) => p._id) } } },
    { $group: { _id: { po: '$referenceId', item: '$inventoryItem' }, quantity: { $sum: '$quantity' } } }
  ]);
  const moved = new Map(moves.map((m) => [`${m._id.po}:${m._id.item}`, round4(m.quantity)]));
  const out = [];
  for (const po of pos) {
    const received = new Map();
    for (const r of po.receipts) for (const l of r.lines || []) received.set(String(l.inventoryId), round4((received.get(String(l.inventoryId)) || 0) + l.quantity));
    for (const [item, qty] of received) {
      const got = moved.get(`${po._id}:${item}`) || 0;
      if (Math.abs(got - qty) > 0.0001) out.push(finding('RECEIPT_STOCK_MISMATCH', 'high', 'purchase_order', po, 'Goods received on the order differ from stock added for it', { stockAdded: qty }, { stockAdded: got, inventoryId: item }, 'Review the receipt; adjust stock with a reason if goods were received but not added.'));
    }
  }
  return out;
}

async function cancelledDocuments(scope) {
  const Invoice = mongoose.model('Invoice');
  const Payment = mongoose.model('Payment');
  const InventoryMovement = mongoose.model('InventoryMovement');
  const cancelled = await Invoice.find({ ...scope, status: 'cancelled' }).select('invoiceNumber').lean();
  if (!cancelled.length) return [];
  const ids = cancelled.map((c) => c._id);
  const [applied, moves] = await Promise.all([
    Payment.find({ status: 'completed', $or: [{ 'allocations.invoiceId': { $in: ids } }, { invoiceId: { $in: ids } }] }).select('allocations invoiceId amount').lean(),
    InventoryMovement.aggregate([
      { $match: { referenceType: 'invoice', referenceId: { $in: ids } } },
      { $group: { _id: { inv: '$referenceId', item: '$inventoryItem', type: '$movementType' }, quantity: { $sum: '$quantity' } } }
    ])
  ]);
  const paidOn = new Map();
  for (const p of applied) {
    const list = p.allocations?.length ? p.allocations : [{ invoiceId: p.invoiceId, amount: p.amount }];
    for (const a of list) if (a.invoiceId) paidOn.set(String(a.invoiceId), round2((paidOn.get(String(a.invoiceId)) || 0) + a.amount));
  }
  const net = new Map(); // inv:item -> sold − returned
  for (const m of moves) {
    const k = `${m._id.inv}:${m._id.item}`;
    net.set(k, round4((net.get(k) || 0) + (m._id.type === 'sale' ? m.quantity : m._id.type === 'return' ? -m.quantity : 0)));
  }
  const out = [];
  for (const inv of cancelled) {
    if (paidOn.get(String(inv._id)) > EPS) out.push(finding('CANCELLED_WITH_PAYMENTS', 'high', 'invoice', inv, 'Cancelled invoice still has payments applied', { applied: 0 }, { applied: paidOn.get(String(inv._id)) }, 'Reverse or reallocate the payment.'));
    for (const [k, qty] of net) {
      if (k.startsWith(`${inv._id}:`) && Math.abs(qty) > 0.0001) out.push(finding('CANCELLED_WITHOUT_STOCK_REVERSAL', 'high', 'invoice', inv, 'Stock taken by the invoice was not fully returned when it was cancelled', { netStockTaken: 0 }, { netStockTaken: qty, inventoryId: k.split(':')[1] }, 'Record a stock adjustment (type return) referencing this invoice, with a reason.'));
    }
  }
  return out;
}

async function operations(scope) {
  const Journal = mongoose.model('TransactionJournal');
  const base = scope.dataScope ? { dataScope: scope.dataScope } : { userId: scope.userId };
  const stale = new Date(Date.now() - INTERRUPTED_AFTER_MS);
  const rows = await Journal.find({ ...base, $or: [{ status: 'compensation_failed' }, { status: 'started', createdAt: { $lt: stale } }] }).sort({ createdAt: 1 }).limit(LIMIT).lean();
  return rows.map((r) => ({
    code: r.status === 'compensation_failed' ? 'COMPENSATION_FAILED' : 'INTERRUPTED_OPERATION', severity: r.status === 'compensation_failed' ? 'critical' : 'high',
    entityType: 'operation', entityId: String(r._id), entityNumber: r.label,
    message: r.status === 'compensation_failed' ? 'A multi-step change failed and could not be fully undone' : 'A multi-step change started and never finished (process stopped or connection lost)',
    expected: 'completed or fully undone', found: { status: r.status, since: r.createdAt, originalError: r.originalError, undoErrors: r.undoErrors, correlationId: r.correlationId },
    suggestedAction: 'Inspect the records the operation touches, correct them, then mark this entry resolved with a note.'
  }));
}

const CHECKS = { invoice_payments: invoicePayments, customer_balances: customerBalances, vendor_balances: vendorBalances, inventory_movements: inventoryMovements, purchase_receipts: purchaseReceipts, cancelled_documents: cancelledDocuments, operations };

async function runReconciliation(scope, { checks = Object.keys(CHECKS) } = {}) {
  const report = { generatedAt: new Date().toISOString(), readOnly: true, checks: {}, totals: { findings: 0, critical: 0, high: 0, medium: 0 } };
  for (const name of checks) {
    if (!CHECKS[name]) continue;
    let findings;
    try { findings = await CHECKS[name](scope); } catch (error) { report.checks[name] = { error: error.message, findings: [], count: 0 }; continue; }
    report.checks[name] = { count: findings.length, truncated: findings.length > LIMIT, findings: findings.slice(0, LIMIT) };
    report.totals.findings += findings.length;
    for (const f of findings) if (report.totals[f.severity] !== undefined) report.totals[f.severity] += 1;
  }
  report.consistent = report.totals.findings === 0 && Object.values(report.checks).every((c) => !c.error);
  return report;
}

module.exports = { runReconciliation, CHECKS };
