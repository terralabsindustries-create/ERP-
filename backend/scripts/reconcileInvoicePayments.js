/**
 * Invoice payment reconciliation: which invoices read as paid (or unpaid)
 * without the money to back it.
 *
 * Until Nov 2026 the invoice "Payment status" dialog could set an invoice to
 * Paid with no amount (paid ₹0, balance still due), and the dashboard's
 * one-click "Mark as paid" set the paid amount to the total without recording
 * a payment. This report compares every invoice with the completed payments
 * actually applied to it.
 *
 *   node scripts/reconcileInvoicePayments.js [--out dir] [--scope <dataScope>]
 *       Read only. Writes invoice-reconciliation.csv / .json (default: cwd).
 *   node scripts/reconcileInvoicePayments.js --apply [--scope <dataScope>]
 *       Also repairs the status fields that contradict the invoice's own paid
 *       amount — an invoice marked paid while a balance is still due goes back
 *       to unpaid / part paid (and the reverse). Run only with approval.
 *
 * --apply never creates payments and never changes paidAmount or
 * manualPaidAmount. Invoices paid only by an entry made directly on the
 * invoice (PAID_BY_MANUAL_ENTRY_ONLY) are listed for someone to check against
 * the books: record the payment if the money came in, or correct the balance
 * (Invoices → Record payment → Correct balance) if it did not.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const HALF = 0.005;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

function allocationsOf(payment) {
  if (payment.allocations && payment.allocations.length) {
    return payment.allocations.map((a) => ({ invoiceId: String(a.invoiceId), amount: round2(a.amount) }));
  }
  if (payment.invoiceId) return [{ invoiceId: String(payment.invoiceId), amount: round2(payment.amount) }];
  return [];
}

/** How the invoice list labels an invoice (client/src/lib/invoiceStatus.ts). */
function displayOf(invoice, paymentStatus, balance, today) {
  if (invoice.status === 'draft') return 'Draft';
  if (invoice.status === 'cancelled') return 'Cancelled';
  if (invoice.status === 'refunded') return 'Refunded';
  if (paymentStatus === 'paid' && balance <= HALF) return 'Paid';
  if (invoice.dueDate && new Date(invoice.dueDate) < today) return 'Overdue';
  if (paymentStatus === 'partial') return 'Partially Paid';
  return 'Unpaid';
}

/**
 * Compares invoices with payments. `paymentStateFor` is Invoice.paymentStateFor.
 * Returns { rows, repairs, summary }: rows are the invoices with a finding,
 * repairs the status fixes --apply would write.
 */
function analyse(invoices, payments, paymentStateFor, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const received = new Map();
  const pending = new Map();
  const refs = new Map();
  for (const p of payments) {
    for (const a of allocationsOf(p)) {
      if (p.status === 'completed') received.set(a.invoiceId, round2((received.get(a.invoiceId) || 0) + a.amount));
      if (p.status === 'pending') pending.set(a.invoiceId, round2((pending.get(a.invoiceId) || 0) + a.amount));
      if (!refs.has(a.invoiceId)) refs.set(a.invoiceId, []);
      refs.get(a.invoiceId).push(`${p.paymentId || p._id} ${p.status} ₹${a.amount}`);
    }
  }

  const rows = [];
  const repairs = [];
  for (const invoice of invoices) {
    const id = String(invoice._id);
    const total = round2(invoice.totalAmount);
    const storedPaid = round2(invoice.paidAmount);
    const storedBalance = round2(invoice.balanceAmount ?? total - storedPaid);
    const viaPayments = received.get(id) || 0;
    const hasManual = invoice.manualPaidAmount !== undefined && invoice.manualPaidAmount !== null;
    const manual = hasManual ? round2(invoice.manualPaidAmount) : Math.max(0, round2(storedPaid - viaPayments));
    const issued = !['draft', 'cancelled'].includes(invoice.status);
    const outstanding = round2(total - viaPayments);

    // What the invoice's own paid amount says its status should be.
    const derived = paymentStateFor(invoice, storedPaid);
    // What the money actually received through payments says.
    const fromPayments = paymentStateFor({ ...invoice, paymentStatus: 'pending' }, viaPayments);

    const issues = [];
    if (issued && invoice.paymentStatus === 'paid' && storedPaid < total - HALF) issues.push('MARKED_PAID_WITH_BALANCE_DUE');
    if (issued && invoice.paymentStatus !== 'paid' && derived.paymentStatus === 'paid') issues.push('SETTLED_BUT_NOT_MARKED_PAID');
    if (issued && manual > HALF && viaPayments < total - HALF && storedPaid >= total - HALF) issues.push('PAID_BY_MANUAL_ENTRY_ONLY');
    else if (issued && manual > HALF) issues.push('PART_PAID_BY_MANUAL_ENTRY');
    if (hasManual && Math.abs(round2(viaPayments + manual) - storedPaid) > HALF) issues.push('PAID_AMOUNT_DRIFT');
    if (!hasManual && viaPayments > storedPaid + HALF) issues.push('PAYMENTS_EXCEED_PAID_AMOUNT');
    if (Math.abs(round2(total - storedPaid) - storedBalance) > HALF) issues.push('BALANCE_FIELD_STALE');
    if (total <= HALF) issues.push('ZERO_TOTAL');

    const fix = {};
    if (derived.paymentStatus !== invoice.paymentStatus) fix.paymentStatus = derived.paymentStatus;
    if (derived.status !== invoice.status) fix.status = derived.status;
    if (Math.abs(derived.balanceAmount - storedBalance) > HALF) fix.balanceAmount = derived.balanceAmount;
    if (Object.keys(fix).length) {
      repairs.push({
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        guard: { paymentStatus: invoice.paymentStatus, status: invoice.status, paidAmount: invoice.paidAmount, totalAmount: invoice.totalAmount },
        set: fix
      });
    }

    if (!issues.length) continue;
    rows.push({
      invoiceNumber: invoice.invoiceNumber,
      customer: invoice.customerName,
      invoiceDate: invoice.invoiceDate ? new Date(invoice.invoiceDate).toISOString().slice(0, 10) : '',
      dueDate: invoice.dueDate ? new Date(invoice.dueDate).toISOString().slice(0, 10) : '',
      business: invoice.dataScope || `user:${invoice.userId}`,
      invoiceTotal: total,
      receivedViaPayments: viaPayments,
      pendingPayments: pending.get(id) || 0,
      recordedOutsidePayments: manual,
      storedPaidAmount: storedPaid,
      outstandingBalance: outstanding,
      // As stored (what the list showed before this fix), whatever the balance.
      currentStatus: displayOf(invoice, invoice.paymentStatus, 0, today),
      expectedStatus: displayOf({ ...invoice, status: fromPayments.status }, fromPayments.paymentStatus, outstanding, today),
      statusAfterRepair: displayOf({ ...invoice, status: derived.status }, derived.paymentStatus, derived.balanceAmount, today),
      issues: issues.join('|'),
      payments: (refs.get(id) || []).join('; ')
    });
  }

  const byIssue = {};
  for (const r of rows) for (const i of r.issues.split('|')) byIssue[i] = (byIssue[i] || 0) + 1;
  const sum = (issue, field) => round2(rows.filter((r) => r.issues.split('|').includes(issue)).reduce((s, r) => s + r[field], 0));
  return {
    rows,
    repairs,
    summary: {
      invoicesScanned: invoices.length,
      paymentsScanned: payments.length,
      invoicesFlagged: rows.length,
      byIssue,
      hiddenReceivables: sum('MARKED_PAID_WITH_BALANCE_DUE', 'outstandingBalance'),
      paidOnlyByManualEntry: sum('PAID_BY_MANUAL_ENTRY_ONLY', 'recordedOutsidePayments'),
      statusRepairs: repairs.length
    }
  };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

/** Writes the repairs, each only over the invoice as it was read (a payment recorded meanwhile wins). */
async function applyRepairs(collection, repairs) {
  let applied = 0;
  const skipped = [];
  for (const r of repairs) {
    const { modifiedCount } = await collection.updateOne({ _id: r._id, ...r.guard }, { $set: r.set, $inc: { __v: 1 } });
    if (modifiedCount) applied += 1;
    else skipped.push(r.invoiceNumber);
  }
  return { applied, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const outDir = path.resolve(opt('--out') || process.cwd());
  const scope = opt('--scope');

  // Reading must not write: no index builds or collection creation on connect.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const Invoice = require('../src/models/Invoice');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(APPLY ? 'Applying status repairs\n' : 'READ ONLY — nothing will be changed\n');

  const invoices = await db.collection('invoices').find(scope ? { dataScope: scope } : {}).toArray();
  // Scoped: the payments applied to those invoices (older payments may lack a dataScope).
  const ids = invoices.map((i) => i._id);
  const paymentFilter = scope ? { $or: [{ 'allocations.invoiceId': { $in: ids } }, { invoiceId: { $in: ids } }] } : {};
  const payments = await db.collection('payments').find(paymentFilter).project({ paymentId: 1, amount: 1, status: 1, allocations: 1, invoiceId: 1 }).toArray();
  const { rows, repairs, summary } = analyse(invoices, payments, (inv, paid) => Invoice.paymentStateFor(inv, paid));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'invoice-reconciliation.csv'), toCsv(rows));
  fs.writeFileSync(path.join(outDir, 'invoice-reconciliation.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scope: scope || 'all', summary, rows, repairs }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nReport: ${path.join(outDir, 'invoice-reconciliation.csv')}`);

  if (APPLY) {
    const { applied, skipped } = await applyRepairs(db.collection('invoices'), repairs);
    console.log(`\nRepaired ${applied} invoice(s).${skipped.length ? ` Skipped (changed since read): ${skipped.join(', ')}` : ''}`);
  } else if (repairs.length) {
    console.log(`\n${repairs.length} invoice(s) have a status that contradicts their paid amount. Re-run with --apply (after approval) to repair them.`);
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('Reconciliation failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { analyse, applyRepairs, toCsv };
