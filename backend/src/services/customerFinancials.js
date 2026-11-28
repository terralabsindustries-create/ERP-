/**
 * Customer financial metrics: one definition, used by the customer record,
 * the customer list, update-stats and (via the same invoice rules) the
 * reports and dashboard.
 *
 *   estimatedJobValue   Sum of Job.estimatedCost (not cancelled). A quotation-
 *                       stage production estimate. NOT revenue.
 *   invoicedRevenue     Issued invoices (sent/paid/overdue): totalAmount, GST
 *                       included, plus debit notes, minus issued credit notes.
 *                       Drafts, cancelled and refunded invoices never count.
 *   grossInvoiced       Issued invoices' totalAmount before any adjustments.
 *   creditNotesTotal / debitNotesTotal   Issued note totals on those invoices.
 *   cancelledInvoiced   Total of cancelled invoices: shown, never in revenue.
 *   paymentsReceived    Completed payments (cash collected; includes advances
 *                       not yet applied to an invoice).
 *   outstanding         What issued invoices still show as due (balanceAmount
 *                       already reflects payments, credit and debit notes) less
 *                       money on account that is not applied to an invoice.
 *
 * Revenue is what was billed; collections are what was received; the two are
 * never interchangeable. Historical records are only read, never modified.
 */
const mongoose = require('mongoose');

const ISSUED = { $nin: ['draft', 'cancelled', 'refunded'] };
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const asIds = (ids) => ids.map((id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))));

/**
 * @param {Array} customerIds
 * @param {object} scope extra invoice/job/payment match, e.g. { dataScope } (applied to every collection)
 * @param {object} [opts] { invoiceExtra } extra match on invoices only (e.g. hide No GST)
 * @returns {Promise<Map<string, object>>}
 */
async function financialsFor(customerIds, scope = {}, { invoiceExtra = {} } = {}) {
  const Job = mongoose.model('Job');
  const Invoice = mongoose.model('Invoice');
  const Payment = mongoose.model('Payment');
  const CreditNote = mongoose.model('CreditNote');
  const { unallocatedOf } = require('./paymentLedger');
  const ids = asIds(customerIds);
  const out = new Map(ids.map((id) => [String(id), blank()]));
  if (!ids.length) return out;
  const match = { customerId: { $in: ids }, ...scope };

  const [jobs, invoices, notes, payments] = await Promise.all([
    Job.aggregate([
      { $match: { ...match, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$customerId', count: { $sum: 1 }, value: { $sum: { $ifNull: ['$estimatedCost', 0] } }, lastOrderDate: { $max: '$createdAt' } } }
    ]),
    Invoice.aggregate([
      { $match: { ...match, ...invoiceExtra, status: { $nin: ['draft'] } } },
      {
        $group: {
          _id: { customer: '$customerId', cancelled: { $in: ['$status', ['cancelled', 'refunded']] } },
          count: { $sum: 1 },
          gross: { $sum: '$totalAmount' },
          debit: { $sum: { $ifNull: ['$debitNoteTotal', 0] } },
          balance: { $sum: { $ifNull: ['$balanceAmount', 0] } },
          lastInvoiceDate: { $max: '$invoiceDate' }
        }
      }
    ]),
    CreditNote.aggregate([
      { $match: { ...match, status: 'issued', noteType: 'credit' } },
      { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: 'inv' } },
      { $match: { 'inv.status': ISSUED } },
      { $group: { _id: '$customerId', total: { $sum: '$totalAmount' } } }
    ]),
    Payment.find({ ...match, status: 'completed' }).select('amount status allocations invoiceId invoiceNumber customerId paymentDate').sort({ paymentDate: 1 }).lean()
  ]);

  for (const j of jobs) Object.assign(out.get(String(j._id)), { totalOrders: j.count, estimatedJobValue: round2(j.value), lastOrderDate: j.lastOrderDate });
  for (const r of invoices) {
    const f = out.get(String(r._id.customer));
    if (r._id.cancelled) {
      f.cancelledInvoiced = round2(f.cancelledInvoiced + r.gross);
      f.cancelledInvoiceCount += r.count;
    } else {
      f.invoiceCount += r.count;
      f.grossInvoiced = round2(f.grossInvoiced + r.gross);
      f.debitNotesTotal = round2(f.debitNotesTotal + r.debit);
      f.receivables = round2(f.receivables + r.balance);
      f.lastInvoiceDate = r.lastInvoiceDate;
    }
  }
  for (const n of notes) out.get(String(n._id)).creditNotesTotal = round2(n.total);
  for (const p of payments) {
    const f = out.get(String(p.customerId));
    if (!f) continue;
    f.paymentsReceived = round2(f.paymentsReceived + (p.amount || 0));
    f.onAccount = round2(f.onAccount + unallocatedOf(p));
    f.lastPaymentDate = p.paymentDate;
    f.lastPaymentAmount = p.amount || 0;
  }
  for (const f of out.values()) {
    f.invoicedRevenue = round2(f.grossInvoiced + f.debitNotesTotal - f.creditNotesTotal);
    f.outstanding = round2(f.receivables - f.onAccount);
  }
  return out;
}

function blank() {
  return {
    totalOrders: 0, estimatedJobValue: 0, lastOrderDate: null,
    invoiceCount: 0, grossInvoiced: 0, creditNotesTotal: 0, debitNotesTotal: 0, invoicedRevenue: 0,
    cancelledInvoiced: 0, cancelledInvoiceCount: 0,
    paymentsReceived: 0, onAccount: 0, receivables: 0, outstanding: 0,
    lastInvoiceDate: null, lastPaymentDate: null, lastPaymentAmount: 0
  };
}

async function financialsOne(customerId, scope = {}, opts) {
  return (await financialsFor([customerId], scope, opts)).get(String(customerId));
}

module.exports = { financialsFor, financialsOne, ISSUED_INVOICE_STATUS: ISSUED };
