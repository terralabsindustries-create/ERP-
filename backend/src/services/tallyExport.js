const crypto = require('crypto');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const Payment = require('../models/Payment');
const PurchaseBill = require('../models/PurchaseBill');
const Customer = require('../models/Customer');
const Vendor = require('../models/Vendor');
const { round2 } = require('../utils/billing');
const { orgUserFilter } = require('../utils/accessScope');
const { stateCodeOf, stateName } = require('../utils/gstStates');
const { IST_OFFSET_MS } = require('../utils/financialYear');

/*
  Tally export: the business's documents as Tally "Import Data" XML
  (ENVELOPE → IMPORTDATA → TALLYMESSAGE), for TallyPrime's
  Import → Masters / Transactions.

  Sign convention (TallyPrime XML samples): a DEBIT entry has
  ISDEEMEDPOSITIVE=Yes and a negative AMOUNT; a CREDIT entry has
  ISDEEMEDPOSITIVE=No and a positive AMOUNT. Every voucher must sum to 0.

  Vouchers: Sales (issued invoices), Credit Note, Debit Note, Receipt
  (completed payments), Purchase (recorded purchase bills). Drafts and
  cancelled documents are never exported. Each voucher carries a stable
  REMOTEID ("CPF-<kind>-<id>") so a repeated import can be recognised; whether
  Tally alters or rejects a repeat depends on the Tally version and import
  settings — check before re-importing. Export history (TallyExport) records
  which documents went out, and the preview flags documents already exported.

  Ledger names are a mapping the business confirms (defaults below); vouchers
  that do not balance after a ±₹1 round-off line are left out and reported.
  This has NOT been import-tested against a live Tally company here.
*/
const DEFAULT_MAPPING = {
  salesLedger: 'Sales', purchaseLedger: 'Purchases',
  outputCgst: 'Output CGST', outputSgst: 'Output SGST', outputIgst: 'Output IGST',
  inputCgst: 'Input CGST', inputSgst: 'Input SGST', inputIgst: 'Input IGST',
  roundOff: 'Round Off', cashLedger: 'Cash', bankLedger: 'Bank Account',
  debtorsGroup: 'Sundry Debtors', creditorsGroup: 'Sundry Creditors'
};

const exportSchema = new mongoose.Schema({
  kind: { type: String, enum: ['masters', 'vouchers'], required: true },
  from: Date, to: Date,
  counts: { type: Object, default: {} },
  documentKeys: { type: [String], default: [] },
  sha256: String,
  mapping: { type: Object, default: {} },
  exportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  exportedByName: String,
  dataScope: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
exportSchema.index({ dataScope: 1, createdAt: -1 });
const TallyExport = mongoose.models.TallyExport || mongoose.model('TallyExport', exportSchema);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tallyDate = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
const amt = (n) => round2(n).toFixed(2);
const scopeOf = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

const entry = (ledger, amount, { party = false } = {}) => ({ ledger, amount: round2(amount), party }); // amount: + debit, − credit

/** Balance a voucher's entries; a difference up to ₹1 goes to round-off. */
function balance(entries, mapping) {
  const diff = round2(entries.reduce((t, e) => t + e.amount, 0));
  if (Math.abs(diff) < 0.005) return { entries, ok: true };
  if (Math.abs(diff) <= 1) return { entries: [...entries, entry(mapping.roundOff, -diff)], ok: true, roundOff: -diff };
  return { entries, ok: false, diff };
}

function voucherXml(v) {
  const lines = v.entries.filter((e) => Math.abs(e.amount) >= 0.005).map((e) => [
    '<ALLLEDGERENTRIES.LIST>',
    `<LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>`,
    `<ISDEEMEDPOSITIVE>${e.amount > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
    e.party ? '<ISPARTYLEDGER>Yes</ISPARTYLEDGER>' : '',
    `<AMOUNT>${amt(-e.amount)}</AMOUNT>`,
    '</ALLLEDGERENTRIES.LIST>'
  ].join('')).join('');
  return [
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(v.remoteId)}" VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${tallyDate(v.date)}</DATE>`,
    `<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>`,
    `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>`,
    v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : '',
    `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>`,
    v.partyGstin ? `<PARTYGSTIN>${esc(v.partyGstin)}</PARTYGSTIN>` : '',
    v.placeOfSupply ? `<PLACEOFSUPPLY>${esc(v.placeOfSupply)}</PLACEOFSUPPLY>` : '',
    `<NARRATION>${esc(v.narration || '')}</NARRATION>`,
    `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
    lines,
    '</VOUCHER></TALLYMESSAGE>'
  ].join('');
}

const envelope = (report, messages) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC><REQUESTDATA>\n${messages.join('\n')}\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;

const taxEntries = (doc, sign, m, input = false) => [
  entry(input ? m.inputCgst : m.outputCgst, sign * (doc.totalCgstAmount || 0)),
  entry(input ? m.inputSgst : m.outputSgst, sign * (doc.totalSgstAmount || 0)),
  entry(input ? m.inputIgst : m.outputIgst, sign * (doc.totalIgstAmount || 0))
];

/** Build every voucher in the range, with validation results. */
async function buildVouchers(user, from, to, mapping) {
  const m = { ...DEFAULT_MAPPING, ...(mapping || {}) };
  const scope = scopeOf(user);
  const billScope = await orgUserFilter(user);
  const [invoices, notes, payments, bills] = await Promise.all([
    Invoice.find({ ...scope, status: { $in: ['sent', 'paid', 'overdue', 'refunded'] }, invoiceDate: { $gte: from, $lt: to } }).lean(),
    CreditNote.find({ ...scope, status: 'issued', noteDate: { $gte: from, $lt: to } }).lean(),
    Payment.find({ ...scope, status: 'completed', paymentDate: { $gte: from, $lt: to } }).populate('customerId', 'name').lean(),
    PurchaseBill.find({ ...billScope, status: { $nin: ['draft', 'cancelled'] }, billDate: { $gte: from, $lt: to } }).lean()
  ]);
  const vouchers = [];
  const problems = [];
  const push = (v, built) => {
    if (!v.party) { problems.push({ key: v.key, number: v.number, message: 'No party name' }); return; }
    if (!built.ok) { problems.push({ key: v.key, number: v.number, message: `Does not balance by ₹${built.diff}` }); return; }
    vouchers.push({ ...v, entries: built.entries, roundOff: built.roundOff });
  };
  for (const inv of invoices) {
    const taxable = round2((inv.totalAmount || 0) - (inv.totalCgstAmount || 0) - (inv.totalSgstAmount || 0) - (inv.totalIgstAmount || 0));
    const entries = [entry(inv.customerName, inv.totalAmount, { party: true }), entry(m.salesLedger, -taxable), ...taxEntries(inv, -1, m)];
    push({ key: `INV-${inv._id}`, remoteId: `CPF-INV-${inv._id}`, type: 'Sales', number: inv.invoiceNumber, date: inv.invoiceDate, party: inv.customerName, partyGstin: inv.customerGstNumber, placeOfSupply: stateName(stateCodeOf(inv.placeOfSupply)) || undefined, narration: inv.jobTitle || '' }, balance(entries, m));
  }
  for (const n of notes) {
    const sign = n.noteType === 'credit' ? -1 : 1; // a credit note reverses a sale
    const entries = [entry(n.customerName, sign * n.totalAmount, { party: true }), entry(m.salesLedger, -sign * n.taxableAmount), ...taxEntries(n, -sign, m)];
    push({ key: `CN-${n._id}`, remoteId: `CPF-NOTE-${n._id}`, type: n.noteType === 'credit' ? 'Credit Note' : 'Debit Note', number: n.noteNumber, date: n.noteDate, reference: n.invoiceNumber, party: n.customerName, partyGstin: n.customerGstNumber, narration: `${n.reason}${n.reasonText ? `: ${n.reasonText}` : ''} — against ${n.invoiceNumber}` }, balance(entries, m));
  }
  for (const p of payments) {
    const party = p.customerName || p.customerId?.name;
    const cashLike = p.paymentMethod === 'cash';
    const entries = [entry(cashLike ? m.cashLedger : m.bankLedger, p.amount), entry(party, -p.amount, { party: true })];
    push({ key: `PAY-${p._id}`, remoteId: `CPF-PAY-${p._id}`, type: 'Receipt', number: p.receiptNumber || p.paymentId, date: p.paymentDate, party, narration: [p.paymentMethod, p.referenceNumber].filter(Boolean).join(' ') }, balance(entries, m));
  }
  for (const b of bills) {
    const entries = [entry(m.purchaseLedger, b.taxableAmount || 0), ...taxEntries(b, 1, m, true), entry(b.vendorName, -(b.totalAmount || 0), { party: true })];
    push({ key: `PB-${b._id}`, remoteId: `CPF-PB-${b._id}`, type: 'Purchase', number: b.billNumber, date: b.billDate, reference: b.vendorInvoiceNumber, party: b.vendorName, partyGstin: b.vendorGstNumber, narration: b.notes || '' }, balance(entries, m));
  }
  vouchers.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { vouchers, problems, mapping: m };
}

async function buildMasters(user, mapping) {
  const m = { ...DEFAULT_MAPPING, ...(mapping || {}) };
  const [customers, vendors] = await Promise.all([
    Customer.find(scopeOf(user)).select('name gstNumber address').lean(),
    orgUserFilter(user).then((s) => Vendor.find(s).select('name gstNumber address').lean())
  ]);
  const ledger = (name, parent, extra = '') => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(parent)}</PARENT>${extra}</LEDGER></TALLYMESSAGE>`;
  const party = (p, parent) => {
    const state = stateName(stateCodeOf(p.gstNumber)) || '';
    return ledger(p.name, parent, `${p.gstNumber ? `<PARTYGSTIN>${esc(p.gstNumber)}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>'}${state ? `<LEDSTATENAME>${esc(state)}</LEDSTATENAME>` : ''}<ISBILLWISEON>Yes</ISBILLWISEON>`);
  };
  const messages = [
    ledger(m.salesLedger, 'Sales Accounts'), ledger(m.purchaseLedger, 'Purchase Accounts'),
    ...[m.outputCgst, m.outputSgst, m.outputIgst, m.inputCgst, m.inputSgst, m.inputIgst].map((n) => ledger(n, 'Duties & Taxes')),
    ledger(m.roundOff, 'Indirect Expenses'), ledger(m.bankLedger, 'Bank Accounts'),
    ...customers.map((c) => party(c, m.debtorsGroup)),
    ...vendors.map((v) => party(v, m.creditorsGroup))
  ];
  return { xml: envelope('All Masters', messages), counts: { customers: customers.length, suppliers: vendors.length, accountLedgers: 10 } };
}

/** Preview: counts per voucher type, problems, and documents already sent in earlier exports. */
async function preview(user, from, to, mapping) {
  const { vouchers, problems, mapping: m } = await buildVouchers(user, from, to, mapping);
  const earlier = await TallyExport.find({ ...scopeOf(user), kind: 'vouchers', documentKeys: { $in: vouchers.map((v) => v.key) } }).select('documentKeys createdAt').lean();
  const exported = new Set(earlier.flatMap((e) => e.documentKeys));
  const counts = vouchers.reduce((c, v) => ({ ...c, [v.type]: (c[v.type] || 0) + 1 }), {});
  return {
    counts, mapping: m, problems,
    alreadyExported: vouchers.filter((v) => exported.has(v.key)).map((v) => ({ type: v.type, number: v.number })),
    roundOffs: vouchers.filter((v) => v.roundOff).map((v) => ({ number: v.number, amount: v.roundOff })),
    sample: vouchers.slice(0, 5).map((v) => ({ type: v.type, number: v.number, party: v.party, entries: v.entries })),
    note: 'Not import-tested against a live Tally company. Import into a test company first.'
  };
}

async function exportFile(user, kind, from, to, mapping) {
  let xml; let counts; let keys = [];
  if (kind === 'masters') ({ xml, counts } = await buildMasters(user, mapping));
  else {
    const { vouchers, problems } = await buildVouchers(user, from, to, mapping);
    xml = envelope('Vouchers', vouchers.map(voucherXml));
    counts = { vouchers: vouchers.length, leftOut: problems.length };
    keys = vouchers.map((v) => v.key);
  }
  const sha256 = crypto.createHash('sha256').update(xml).digest('hex');
  await TallyExport.create({ kind, from, to, counts, documentKeys: keys, sha256, mapping: { ...DEFAULT_MAPPING, ...(mapping || {}) }, exportedBy: user._id, exportedByName: user.fullName, dataScope: user.dataScope, userId: user._id });
  return { xml, counts, sha256 };
}

module.exports = { buildVouchers, buildMasters, preview, exportFile, voucherXml, TallyExport, DEFAULT_MAPPING };
