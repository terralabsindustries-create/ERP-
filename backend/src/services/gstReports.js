const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const PurchaseBill = require('../models/PurchaseBill');
const { businessSettings } = require('../utils/businessSettings');
const { isValidGstin, normalizeGstin } = require('../utils/gstin');
const { stateCodeOf, placeOfSupplyLabel } = require('../utils/gstStates');
const { round2 } = require('../utils/billing');
const { orgUserFilter } = require('../utils/accessScope');

/*
  GST return working papers built from the business's own records. These are
  REPORTS to prepare and check a return — not a filing, and not the GSTN
  offline-tool JSON. Section meanings follow the GSTR-1 / GSTR-3B forms:

  GSTR-1
    b2b    Table 4  — supplies to registered persons (valid GSTIN), invoice-wise and rate-wise.
    b2cl   Table 5  — inter-state supplies to unregistered persons with invoice value above the
                      B2CL limit (₹1,00,000 for invoices from 1 Aug 2024, ₹2,50,000 before —
                      Notification 12/2024-CT; the limits are parameters, see B2CL_LIMITS).
    b2cs   Table 7  — all other supplies to unregistered persons, by place of supply and rate,
                      net of credit/debit notes against them.
    cdnr   Table 9B — credit/debit notes to registered persons.
    cdnur  Table 9B — credit/debit notes to unregistered persons against B2CL invoices.
    nil    Table 8  — 0%-rated lines and invoices issued as "No GST" (classification as nil /
                      exempt / non-GST must be confirmed by the business).
    hsn    Table 12 — HSN/SAC summary, split B2B / B2C, net of notes.
    docs   Table 13 — documents issued: number ranges, totals, cancelled.
  GSTR-3B (summary)
    3.1(a) outward taxable supplies, 3.1(c) nil/exempt, 3.2 inter-state supplies to
    unregistered persons by place of supply, 4 eligible ITC from recorded purchase bills
    (blocked credits are NOT identified), and output less ITC per head (no set-off rules applied).

  Rules applied
  - Only issued invoices (sent/paid/overdue) count. Drafts never count. Cancelled invoices
    appear only in Table 13 as cancelled.
  - Notes count by their own date and only when issued; cancelled notes never count.
  - Purchase bills count when recorded (not draft or cancelled), by bill date.
*/

const B2CL_LIMITS = [
  { from: new Date('2024-08-01T00:00:00+05:30'), limit: 100000 },
  { from: new Date('1970-01-01T00:00:00Z'), limit: 250000 }
];
const b2clLimitOn = (date) => B2CL_LIMITS.find((l) => new Date(date) >= l.from).limit;

const ISSUED = ['sent', 'paid', 'overdue', 'refunded'];

const add = (a, b) => round2((a || 0) + (b || 0));

/** Rate-wise parts of an invoice (each line and the design charge). */
function partsOf(doc, { sign = 1 } = {}) {
  const parts = [];
  const zero = !!doc.noGst;
  for (const it of doc.items || []) {
    const taxable = it.taxableValue != null ? it.taxableValue : it.totalAmount;
    parts.push({
      code: String(it.hsnCode || it.sacCode || '').trim().toUpperCase(),
      description: it.itemName,
      unit: it.unit || 'pieces',
      quantity: sign * (Number(it.quantity) || 0),
      rate: zero ? 0 : Number(it.gstRate) || 0,
      taxable: sign * round2(taxable || 0),
      igst: sign * round2(zero ? 0 : it.igstAmount || 0),
      cgst: sign * round2(zero ? 0 : it.cgstAmount || 0),
      sgst: sign * round2(zero ? 0 : it.sgstAmount || 0)
    });
  }
  if ((doc.designCharge || 0) > 0) {
    parts.push({
      code: String(doc.designChargeSacCode || '998391').trim(),
      description: 'Design charge',
      unit: 'OTH',
      quantity: 0,
      rate: zero ? 0 : Number(doc.designChargeGstRate) || 0,
      taxable: sign * round2(doc.designChargeTaxableValue || doc.designCharge || 0),
      igst: sign * round2(zero ? 0 : doc.designChargeIgstAmount || 0),
      cgst: sign * round2(zero ? 0 : doc.designChargeCgstAmount || 0),
      sgst: sign * round2(zero ? 0 : doc.designChargeSgstAmount || 0)
    });
  }
  return parts;
}

/** Rate-wise totals of parts. */
function byRate(parts) {
  const map = new Map();
  for (const p of parts) {
    const r = map.get(p.rate) || { rate: p.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    r.taxable = add(r.taxable, p.taxable); r.igst = add(r.igst, p.igst); r.cgst = add(r.cgst, p.cgst); r.sgst = add(r.sgst, p.sgst);
    map.set(p.rate, r);
  }
  return [...map.values()].sort((a, b) => a.rate - b.rate);
}

const sumTax = (rows) => rows.reduce((t, r) => ({
  taxable: add(t.taxable, r.taxable), igst: add(t.igst, r.igst), cgst: add(t.cgst, r.cgst), sgst: add(t.sgst, r.sgst)
}), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });

/** The series prefix of a document number: INV-202611-0004 → INV-202611-. */
const seriesOf = (n) => String(n).replace(/\d+$/, '');

function docsIssued(list, nature) {
  const series = new Map();
  for (const d of list) {
    const key = seriesOf(d.number);
    const s = series.get(key) || { nature, from: d.number, to: d.number, total: 0, cancelled: 0 };
    if (d.number < s.from) s.from = d.number;
    if (d.number > s.to) s.to = d.number;
    s.total += 1;
    if (d.cancelled) s.cancelled += 1;
    series.set(key, s);
  }
  return [...series.values()].map((s) => ({ ...s, net: s.total - s.cancelled }));
}

/**
 * Build every section for one period.
 * @param {object} user   req.user (scope)
 * @param {Date} from     inclusive
 * @param {Date} to       exclusive
 */
async function buildGstReport(user, from, to, { hsnDigits } = {}) {
  const scope = user.dataScope ? { dataScope: user.dataScope } : { userId: user._id };
  const settings = await businessSettings(user);
  const homeState = stateCodeOf(settings.gstNumber) || stateCodeOf(settings.companyAddress?.state);
  const ownGstin = normalizeGstin(settings.gstNumber);

  const [invoices, cancelledInvoices, notes, bills] = await Promise.all([
    Invoice.find({ ...scope, status: { $in: ISSUED }, invoiceDate: { $gte: from, $lt: to } }).sort({ invoiceDate: 1, invoiceNumber: 1 }).lean(),
    Invoice.find({ ...scope, status: 'cancelled', invoiceDate: { $gte: from, $lt: to }, invoiceNumber: { $not: /^DRAFT-/ } }).select('invoiceNumber invoiceDate').lean(),
    CreditNote.find({ ...scope, status: { $in: ['issued', 'cancelled'] }, noteDate: { $gte: from, $lt: to } }).sort({ noteDate: 1, noteNumber: 1 }).lean(),
    // Purchase bills are kept per login of the business (no dataScope field): the business's logins.
    orgUserFilter(user).then((billScope) => PurchaseBill.find({ ...billScope, status: { $nin: ['draft', 'cancelled'] }, billDate: { $gte: from, $lt: to } }).sort({ billDate: 1 }).lean())
  ]);

  const warnings = [];
  const warn = (code, message, ref) => warnings.push({ code, message, ref });
  if (!homeState) warn('NO_HOME_STATE', 'Your business GSTIN / state is not set in Settings, so places of supply cannot be checked.');
  const requiredDigits = hsnDigits || 4;

  // Classify each invoice.
  const sales = [];
  const b2b = [];
  const b2cl = [];
  const b2csMap = new Map();
  const nil = { taxable: 0, invoices: 0 };
  const hsn = { b2b: new Map(), b2c: new Map() };
  const invoiceKind = new Map(); // invoiceId -> 'b2b' | 'b2cl' | 'b2cs'
  let b2csInvoiceTaxable = 0;
  let b2csNoteTaxable = 0;

  const addHsn = (bucket, p) => {
    const key = `${p.code}|${p.rate}|${p.unit}`;
    const h = bucket.get(key) || { hsn: p.code, description: p.description, uqc: p.unit, rate: p.rate, quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    h.quantity = round2(h.quantity + p.quantity); h.taxable = add(h.taxable, p.taxable); h.igst = add(h.igst, p.igst); h.cgst = add(h.cgst, p.cgst); h.sgst = add(h.sgst, p.sgst);
    bucket.set(key, h);
  };
  const addB2cs = (pos, rate, row, sign = 1) => {
    const key = `${pos || 'NA'}|${rate}`;
    const r = b2csMap.get(key) || { placeOfSupply: placeOfSupplyLabel(pos) || 'Not set', supplyType: pos && homeState && pos !== homeState ? 'Inter-state' : 'Intra-state', rate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    r.taxable = add(r.taxable, sign * row.taxable); r.igst = add(r.igst, sign * row.igst); r.cgst = add(r.cgst, sign * row.cgst); r.sgst = add(r.sgst, sign * row.sgst);
    b2csMap.set(key, r);
  };

  for (const inv of invoices) {
    const gstin = normalizeGstin(inv.customerGstNumber);
    const registered = !!gstin && isValidGstin(gstin);
    if (gstin && !registered) warn('INVALID_GSTIN', `${inv.invoiceNumber}: customer GSTIN ${gstin} is not valid; reported as B2C.`, inv.invoiceNumber);
    let pos = stateCodeOf(inv.placeOfSupply) || (registered ? gstin.slice(0, 2) : null) || (!inv.isInterState ? homeState : null);
    if (!pos) warn('NO_PLACE_OF_SUPPLY', `${inv.invoiceNumber}: inter-state supply with no place of supply.`, inv.invoiceNumber);
    if (pos && homeState && (pos !== homeState) !== !!inv.isInterState) {
      warn('POS_TAX_MISMATCH', `${inv.invoiceNumber}: place of supply ${placeOfSupplyLabel(pos)} does not match its ${inv.isInterState ? 'IGST' : 'CGST/SGST'} charge.`, inv.invoiceNumber);
    }
    const parts = partsOf(inv);
    const rates = byRate(parts);
    const t = sumTax(rates);
    const taxedParts = parts.filter((p) => p.rate > 0);
    const zeroParts = parts.filter((p) => p.rate === 0);
    for (const p of zeroParts) { nil.taxable = add(nil.taxable, p.taxable); }
    if (zeroParts.length) nil.invoices += 1;
    for (const p of taxedParts) {
      if (!p.code) warn('NO_HSN', `${inv.invoiceNumber}: a line (${p.description}) has no HSN/SAC code.`, inv.invoiceNumber);
      else if (p.code.length < requiredDigits) warn('HSN_DIGITS', `${inv.invoiceNumber}: HSN ${p.code} has fewer than ${requiredDigits} digits.`, inv.invoiceNumber);
    }

    sales.push({
      invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, customerName: inv.customerName, customerGstin: gstin || '',
      placeOfSupply: placeOfSupplyLabel(pos) || '', reverseCharge: inv.reverseCharge ? 'Y' : 'N',
      invoiceValue: round2(inv.totalAmount), ...t, totalTax: round2(t.igst + t.cgst + t.sgst)
    });

    const taxedRates = byRate(taxedParts);
    if (registered) {
      invoiceKind.set(String(inv._id), 'b2b');
      for (const r of taxedRates) b2b.push({ gstin, receiverName: inv.customerName, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, invoiceValue: round2(inv.totalAmount), placeOfSupply: placeOfSupplyLabel(pos) || '', reverseCharge: inv.reverseCharge ? 'Y' : 'N', invoiceType: 'Regular B2B', ...r });
      taxedParts.forEach((p) => addHsn(hsn.b2b, p));
    } else if (inv.isInterState && inv.totalAmount > b2clLimitOn(inv.invoiceDate)) {
      invoiceKind.set(String(inv._id), 'b2cl');
      for (const r of taxedRates) b2cl.push({ invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, invoiceValue: round2(inv.totalAmount), placeOfSupply: placeOfSupplyLabel(pos) || 'Not set', ...r });
      taxedParts.forEach((p) => addHsn(hsn.b2c, p));
    } else {
      invoiceKind.set(String(inv._id), 'b2cs');
      for (const r of taxedRates) { addB2cs(pos, r.rate, r); b2csInvoiceTaxable = add(b2csInvoiceTaxable, r.taxable); }
      taxedParts.forEach((p) => addHsn(hsn.b2c, p));
    }
  }

  // Notes issued in the period (cancelled notes are listed in Table 13 only).
  const cdnr = [];
  const cdnur = [];
  const noteRegister = [];
  const issuedNotes = notes.filter((n) => n.status === 'issued');
  const originalIds = [...new Set(issuedNotes.map((n) => String(n.invoiceId)))].filter((id) => !invoiceKind.has(id));
  if (originalIds.length) {
    // Notes on invoices from earlier periods: classify their invoice the same way.
    const originals = await Invoice.find({ _id: { $in: originalIds }, ...scope }).select('customerGstNumber isInterState totalAmount invoiceDate').lean();
    for (const o of originals) {
      const g = normalizeGstin(o.customerGstNumber);
      invoiceKind.set(String(o._id), g && isValidGstin(g) ? 'b2b' : o.isInterState && o.totalAmount > b2clLimitOn(o.invoiceDate) ? 'b2cl' : 'b2cs');
    }
  }
  const noteTotals = { credit: { taxable: 0, igst: 0, cgst: 0, sgst: 0 }, debit: { taxable: 0, igst: 0, cgst: 0, sgst: 0 } };
  for (const n of issuedNotes) {
    const sign = n.noteType === 'credit' ? -1 : 1;
    const parts = (n.items || []).map((l) => ({
      code: String(l.hsnCode || l.sacCode || '').toUpperCase(), description: l.itemName, unit: l.unit || 'pieces',
      quantity: sign * (l.quantity || 0), rate: l.gstRate || 0, taxable: sign * l.taxableValue, igst: sign * l.igstAmount, cgst: sign * l.cgstAmount, sgst: sign * l.sgstAmount
    }));
    const kind = invoiceKind.get(String(n.invoiceId)) || 'b2cs';
    const gstin = normalizeGstin(n.customerGstNumber);
    const pos = (kind === 'b2b' && gstin.slice(0, 2)) || (!n.isInterState ? homeState : null);
    const abs = byRate(parts.map((p) => ({ ...p, taxable: Math.abs(p.taxable), igst: Math.abs(p.igst), cgst: Math.abs(p.cgst), sgst: Math.abs(p.sgst) })));
    const t = sumTax(abs);
    const nt = noteTotals[n.noteType];
    Object.keys(nt).forEach((k) => { nt[k] = add(nt[k], t[k]); });
    noteRegister.push({ noteNumber: n.noteNumber, noteType: n.noteType === 'credit' ? 'C' : 'D', noteDate: n.noteDate, invoiceNumber: n.invoiceNumber, invoiceDate: n.invoiceDate, customerName: n.customerName, customerGstin: gstin, reason: n.reason, noteValue: n.totalAmount, ...t, section: kind === 'b2b' ? 'CDNR' : kind === 'b2cl' ? 'CDNUR' : 'B2CS (netted)' });
    for (const r of abs) {
      const row = { noteNumber: n.noteNumber, noteType: n.noteType === 'credit' ? 'C' : 'D', noteDate: n.noteDate, originalInvoice: n.invoiceNumber, noteValue: n.totalAmount, ...r };
      if (kind === 'b2b') cdnr.push({ gstin, receiverName: n.customerName, placeOfSupply: placeOfSupplyLabel(pos) || '', ...row });
      else if (kind === 'b2cl') cdnur.push({ urType: 'B2CL', placeOfSupply: placeOfSupplyLabel(pos) || '', ...row });
      else { addB2cs(pos, r.rate, r, sign); b2csNoteTaxable = add(b2csNoteTaxable, r.taxable); }
    }
    parts.filter((p) => p.rate > 0).forEach((p) => addHsn(kind === 'b2b' ? hsn.b2b : hsn.b2c, p));
  }

  // Purchases (input tax).
  const purchases = bills.map((b) => ({
    billNumber: b.billNumber, supplierInvoiceNumber: b.vendorInvoiceNumber || '', billDate: b.billDate, supplierName: b.vendorName,
    supplierGstin: normalizeGstin(b.vendorGstNumber), taxable: round2(b.taxableAmount || 0), igst: round2(b.totalIgstAmount || 0),
    cgst: round2(b.totalCgstAmount || 0), sgst: round2(b.totalSgstAmount || 0), total: round2(b.totalAmount || 0)
  }));
  for (const p of purchases) if (!p.supplierGstin && (p.igst || p.cgst || p.sgst)) warn('ITC_NO_GSTIN', `Purchase ${p.billNumber}: tax charged by a supplier with no GSTIN; input tax credit needs the supplier's GSTIN.`, p.billNumber);
  const itc = purchases.filter((p) => p.supplierGstin && isValidGstin(p.supplierGstin)).reduce((t, p) => ({ igst: add(t.igst, p.igst), cgst: add(t.cgst, p.cgst), sgst: add(t.sgst, p.sgst) }), { igst: 0, cgst: 0, sgst: 0 });

  // GSTR-3B summary.
  const outward = sumTax(sales.map((s) => ({ taxable: s.taxable, igst: s.igst, cgst: s.cgst, sgst: s.sgst })));
  const taxedOutward = {
    taxable: round2(outward.taxable - nil.taxable - noteTotals.credit.taxable + noteTotals.debit.taxable),
    igst: round2(outward.igst - noteTotals.credit.igst + noteTotals.debit.igst),
    cgst: round2(outward.cgst - noteTotals.credit.cgst + noteTotals.debit.cgst),
    sgst: round2(outward.sgst - noteTotals.credit.sgst + noteTotals.debit.sgst)
  };
  const interStateUnregistered = new Map();
  for (const r of [...b2cl.map((x) => ({ ...x })), ...[...b2csMap.values()].filter((x) => x.supplyType === 'Inter-state')]) {
    const key = r.placeOfSupply;
    const v = interStateUnregistered.get(key) || { placeOfSupply: key, taxable: 0, igst: 0 };
    v.taxable = add(v.taxable, r.taxable); v.igst = add(v.igst, r.igst);
    interStateUnregistered.set(key, v);
  }
  const gstr3b = {
    outwardTaxable: taxedOutward,
    nilExempt: { taxable: nil.taxable },
    interStateToUnregistered: [...interStateUnregistered.values()],
    eligibleItc: itc,
    netPayable: { igst: round2(taxedOutward.igst - itc.igst), cgst: round2(taxedOutward.cgst - itc.cgst), sgst: round2(taxedOutward.sgst - itc.sgst) },
    note: 'Net payable is output tax less eligible ITC per head, before the cross-utilisation order and any blocked credits. Confirm on the GST portal.'
  };

  // Table 13 — documents issued (official numbers only; drafts never have one).
  const docs = [
    ...docsIssued([...invoices.map((i) => ({ number: i.invoiceNumber })), ...cancelledInvoices.map((i) => ({ number: i.invoiceNumber, cancelled: true }))], 'Invoices for outward supply'),
    ...docsIssued(notes.filter((n) => n.noteType === 'credit').map((n) => ({ number: n.noteNumber, cancelled: n.status === 'cancelled' })), 'Credit Note'),
    ...docsIssued(notes.filter((n) => n.noteType === 'debit').map((n) => ({ number: n.noteNumber, cancelled: n.status === 'cancelled' })), 'Debit Note')
  ];

  // Reconciliation: every issued invoice lands in exactly one of B2B / B2CL /
  // B2CS (its taxed lines) plus nil (its 0% lines), and those add back to the
  // sales register. Notes are reconciled against the note register.
  const sectionsTaxable = round2(b2b.reduce((t, r) => t + r.taxable, 0) + b2cl.reduce((t, r) => t + r.taxable, 0) + b2csInvoiceTaxable + nil.taxable);
  const noteSections = round2([...cdnr, ...cdnur].reduce((t, r) => t + r.taxable, 0) + b2csNoteTaxable);
  const reconciliation = {
    salesRegisterTaxable: outward.taxable,
    sectionsTaxable,
    noteRegisterTaxable: round2(noteTotals.credit.taxable + noteTotals.debit.taxable),
    noteSectionsTaxable: noteSections,
    invoices: invoices.length,
    classified: invoices.filter((i) => invoiceKind.has(String(i._id))).length
  };
  reconciliation.balanced = Math.abs(reconciliation.salesRegisterTaxable - sectionsTaxable) < 0.05
    && Math.abs(reconciliation.noteRegisterTaxable - noteSections) < 0.05
    && reconciliation.classified === invoices.length;
  if (!reconciliation.balanced) warn('UNRECONCILED', 'GSTR-1 sections do not add back to the sales and note registers.');

  const hsnRows = (m) => [...m.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
  return {
    period: { from, to },
    business: { gstin: ownGstin || null, state: placeOfSupplyLabel(homeState) },
    gstr1: {
      b2b, b2cl, b2cs: [...b2csMap.values()].filter((r) => r.taxable || r.igst || r.cgst || r.sgst), cdnr, cdnur,
      nil: { taxable: nil.taxable, invoices: nil.invoices, classification: 'Nil-rated / exempt / non-GST — confirm classification' },
      hsnB2B: hsnRows(hsn.b2b), hsnB2C: hsnRows(hsn.b2c), docs
    },
    gstr3b,
    registers: { sales, purchases, notes: noteRegister },
    totals: { outward, credit: noteTotals.credit, debit: noteTotals.debit, itc },
    reconciliation,
    warnings,
    disclaimer: 'Prepared from your records for review. This is not a GST filing and not the GSTN offline-tool JSON format.'
  };
}

module.exports = { buildGstReport, b2clLimitOn, partsOf, B2CL_LIMITS };
