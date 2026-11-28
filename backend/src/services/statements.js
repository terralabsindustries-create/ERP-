const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const CreditNote = require('../models/CreditNote');
const PurchaseBill = require('../models/PurchaseBill');
const Vendor = require('../models/Vendor');
const { round2 } = require('../utils/billing');
const { orgUserFilter } = require('../utils/accessScope');

/*
  Account statements.

  Customer statement (what they owe us), by document date:
    debit   issued invoice (its total) · issued debit note
    credit  completed payment received (the whole receipt, applied or on account)
            · issued credit note (its full value) · balance recorded on an
            invoice outside payments (manualPaidAmount, an existing correction)
  Not on the statement: drafts (not issued); cancelled invoices and cancelled
  notes (void — they never formed part of the balance; they are listed
  separately so the gap in numbers is explained); failed/cancelled/refunded
  payments.
  opening = all of the above dated before `from`; closing = opening + debits − credits.

  Reconciliation: the all-time closing balance must equal what the invoices
  still show as due, less money on account not applied to an invoice, less
  credit-note value kept as customer credit (services/customerFinancials.js
  uses the same rules). The statement reports both figures and whether they agree.

  Supplier statement (what we owe them): recorded purchase bills as credits,
  amounts paid on them as debits. Payment dates are not recorded on bills, so
  a bill's payments are shown on the bill's own line.
*/

const ISSUED = ['sent', 'paid', 'overdue'];
const scopeOf = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });
const DAY = 864e5;

class StatementError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function customerStatement(user, customerId, from, to) {
  if (!mongoose.isValidObjectId(customerId)) throw new StatementError(404, 'Customer not found');
  const scope = scopeOf(user);
  const customer = await Customer.findOne({ _id: customerId, ...scope }).lean();
  if (!customer) throw new StatementError(404, 'Customer not found');
  const cid = customer._id;

  const [invoices, cancelled, payments, notes] = await Promise.all([
    Invoice.find({ ...scope, customerId: cid, status: { $in: ISSUED } }).select('invoiceNumber invoiceDate dueDate totalAmount balanceAmount manualPaidAmount jobTitle status').lean(),
    Invoice.find({ ...scope, customerId: cid, status: 'cancelled', invoiceNumber: { $not: /^DRAFT-/ } }).select('invoiceNumber invoiceDate totalAmount cancelledAt cancellationReason').lean(),
    Payment.find({ ...scope, customerId: cid, status: 'completed' }).select('paymentId receiptNumber paymentDate amount paymentMethod referenceNumber allocations invoiceId status').lean(),
    CreditNote.find({ ...scope, customerId: cid, status: { $in: ['issued', 'cancelled'] } }).lean()
  ]);

  const entries = [];
  for (const inv of invoices) {
    entries.push({ date: inv.invoiceDate, type: 'Invoice', reference: inv.invoiceNumber, description: inv.jobTitle || '', debit: round2(inv.totalAmount), credit: 0 });
    if ((inv.manualPaidAmount || 0) > 0) entries.push({ date: inv.invoiceDate, type: 'Balance correction', reference: inv.invoiceNumber, description: 'Recorded on the invoice outside payments', debit: 0, credit: round2(inv.manualPaidAmount) });
  }
  for (const p of payments) entries.push({ date: p.paymentDate, type: 'Payment', reference: p.receiptNumber || p.paymentId, description: [p.paymentMethod, p.referenceNumber].filter(Boolean).join(' · '), debit: 0, credit: round2(p.amount) });
  for (const n of notes.filter((x) => x.status === 'issued')) {
    entries.push({ date: n.noteDate, type: n.noteType === 'credit' ? 'Credit note' : 'Debit note', reference: n.noteNumber, description: `Against ${n.invoiceNumber}`, debit: n.noteType === 'debit' ? round2(n.totalAmount) : 0, credit: n.noteType === 'credit' ? round2(n.totalAmount) : 0 });
  }
  entries.sort((a, b) => new Date(a.date) - new Date(b.date) || (a.debit ? -1 : 1));

  let opening = 0;
  const lines = [];
  let running = 0;
  let debits = 0;
  let credits = 0;
  for (const e of entries) {
    const d = new Date(e.date);
    if (d < from) { opening = round2(opening + e.debit - e.credit); continue; }
    if (d >= to) continue;
    if (!lines.length) running = opening;
    running = round2(running + e.debit - e.credit);
    debits = round2(debits + e.debit);
    credits = round2(credits + e.credit);
    lines.push({ ...e, balance: running });
  }
  const closing = round2(opening + debits - credits);

  // Ageing of what invoices still show as due, by days past due at `to`.
  const asOf = new Date(Math.min(to.getTime(), Date.now()));
  const ageing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const inv of invoices) {
    const due = round2(inv.balanceAmount || 0);
    if (due <= 0) continue;
    const late = Math.floor((asOf - new Date(inv.dueDate || inv.invoiceDate)) / DAY);
    const k = late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90plus';
    ageing[k] = round2(ageing[k] + due);
  }

  // Reconciliation against the documents (all time).
  const { unallocatedOf } = require('./paymentLedger');
  const invoiceDue = round2(invoices.reduce((t, i) => t + (i.balanceAmount || 0), 0));
  const onAccount = round2(payments.reduce((t, p) => t + (unallocatedOf ? unallocatedOf(p) : 0), 0));
  const unappliedCredit = round2(notes.filter((n) => n.status === 'issued' && n.noteType === 'credit').reduce((t, n) => t + (n.unappliedAmount || 0), 0));
  const allTime = round2(entries.reduce((t, e) => t + e.debit - e.credit, 0));
  const expected = round2(invoiceDue - onAccount - unappliedCredit);

  return {
    kind: 'customer',
    party: { _id: cid, name: customer.name, company: customer.company, gstNumber: customer.gstNumber, address: customer.address, phone: customer.phone, email: customer.email },
    period: { from, to },
    opening, debits, credits, closing,
    lines,
    ageing,
    voided: [
      ...cancelled.filter((c) => new Date(c.invoiceDate) >= from && new Date(c.invoiceDate) < to).map((c) => ({ date: c.invoiceDate, type: 'Cancelled invoice', reference: c.invoiceNumber, amount: round2(c.totalAmount), reason: c.cancellationReason || '' })),
      ...notes.filter((n) => n.status === 'cancelled' && new Date(n.noteDate) >= from && new Date(n.noteDate) < to).map((n) => ({ date: n.noteDate, type: n.noteType === 'credit' ? 'Cancelled credit note' : 'Cancelled debit note', reference: n.noteNumber, amount: round2(n.totalAmount), reason: n.cancellationReason || '' }))
    ],
    reconciliation: { statementBalance: allTime, documentsBalance: expected, invoiceDue, onAccount, unappliedCredit, balanced: Math.abs(allTime - expected) < 0.05 }
  };
}

async function supplierStatement(user, vendorId, from, to) {
  if (!mongoose.isValidObjectId(vendorId)) throw new StatementError(404, 'Supplier not found');
  // Suppliers are kept per login of the business (no dataScope on the model).
  const vendorScope = await orgUserFilter(user);
  const vendor = await Vendor.findOne({ _id: vendorId, ...vendorScope }).lean();
  if (!vendor) throw new StatementError(404, 'Supplier not found');
  const bills = await PurchaseBill.find({ ...(await orgUserFilter(user)), vendorId: vendor._id, status: { $nin: ['draft', 'cancelled'] } }).sort({ billDate: 1 }).lean();
  let opening = 0; let billed = 0; let paid = 0; let running = 0;
  const lines = [];
  for (const b of bills) {
    const d = new Date(b.billDate);
    const net = round2((b.totalAmount || 0) - (b.paidAmount || 0));
    if (d < from) { opening = round2(opening + net); continue; }
    if (d >= to) continue;
    if (!lines.length) running = opening;
    billed = round2(billed + (b.totalAmount || 0));
    paid = round2(paid + (b.paidAmount || 0));
    running = round2(running + net);
    lines.push({ date: b.billDate, type: 'Purchase bill', reference: b.billNumber, description: b.vendorInvoiceNumber ? `Supplier invoice ${b.vendorInvoiceNumber}` : '', credit: round2(b.totalAmount || 0), debit: round2(b.paidAmount || 0), balance: running });
  }
  return {
    kind: 'supplier',
    party: { _id: vendor._id, name: vendor.name, gstNumber: vendor.gstNumber, phone: vendor.phone, email: vendor.email },
    period: { from, to }, opening, credits: billed, debits: paid, closing: round2(opening + billed - paid), lines,
    note: 'Payments to suppliers are recorded as amounts paid on each bill, so they appear on the bill’s line.'
  };
}

module.exports = { customerStatement, supplierStatement, StatementError };
