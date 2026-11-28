const crypto = require('crypto');
const Invoice = require('../models/Invoice');
const { ComplianceSettings, EInvoiceRecord, EwayBillRecord } = require('../models/GstCompliance');
const { businessSettings } = require('../utils/businessSettings');
const { isValidGstin, normalizeGstin } = require('../utils/gstin');
const { stateCodeOf } = require('../utils/gstStates');
const { IST_OFFSET_MS } = require('../utils/financialYear');

/*
  E-invoice (IRN) and e-way bill workflow, provider-agnostic.

  An authorised provider (GSP / IRP access) is plugged in with registerProvider().
  None is bundled: with no provider configured, generation is refused with
  PROVIDER_NOT_CONFIGURED and nothing is stored as if it had succeeded. IRNs,
  acknowledgement numbers, signed QR codes and EWB numbers are saved only
  exactly as a provider returns them.

  Workflow guarantees
  - Eligibility: the business has switched the feature on; the invoice is issued
    (not draft / cancelled); e-invoice needs a B2B supply (valid buyer GSTIN).
  - Validation before any call: seller and buyer GSTIN, state codes, pincodes,
    HSN on every line, values; every problem is returned, nothing is sent.
  - One in-flight request per document (atomic claim, released on failure), and
    a generated IRN is never requested again for the same invoice.
  - Every attempt is recorded (action, outcome, message, payload hash).
  - IRN cancellation only within 24 hours of the acknowledgement (IRP rule);
    after that the invoice is corrected with a credit note.

  The payload follows the NIC e-invoice JSON schema (v1.1 field names: Version,
  TranDtls, DocDtls, SellerDtls, BuyerDtls, ItemList, ValDtls). The provider
  adapter may need to adjust it to its own API; verify with the chosen GSP.
*/
class ComplianceError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

const providers = new Map();
/** Plug in an authorised provider: { generateIrn(payload, ctx), cancelIrn({irn, reasonCode, remark}, ctx), generateEwb(payload, ctx), cancelEwb(...) }. */
const registerProvider = (name, impl) => providers.set(name, impl);
const unregisterProvider = (name) => providers.delete(name);

const scopeOf = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });
const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);
const ddmmyyyy = (d) => { const x = new Date(new Date(d).getTime() + IST_OFFSET_MS); return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`; };
const pinOf = (s) => { const m = /\b(\d{6})\b/.exec(String(s || '')); return m ? Number(m[1]) : null; };

async function settingsFor(user) {
  return (await ComplianceSettings.findOne(user.dataScope ? { dataScope: user.dataScope } : { userId: user._id }).lean()) || { eInvoiceEnabled: false, eWayBillEnabled: false, provider: 'none', environment: 'sandbox' };
}

async function saveSettings(user, body) {
  const set = { updatedBy: user._id };
  for (const k of ['eInvoiceEnabled', 'eWayBillEnabled']) if (body[k] !== undefined) set[k] = body[k] === true;
  if (body.provider !== undefined) set.provider = ['none', 'custom_gsp'].includes(body.provider) ? body.provider : 'none';
  if (body.environment !== undefined) set.environment = body.environment === 'production' ? 'production' : 'sandbox';
  if (body.eWayBillThreshold !== undefined) {
    const n = Number(body.eWayBillThreshold);
    if (body.eWayBillThreshold !== null && (!Number.isFinite(n) || n < 0)) throw new ComplianceError(400, 'Enter the e-way bill limit in rupees.', 'INVALID_THRESHOLD');
    set.eWayBillThreshold = body.eWayBillThreshold === null ? undefined : n;
  }
  return ComplianceSettings.findOneAndUpdate(user.dataScope ? { dataScope: user.dataScope } : { userId: user._id }, { $set: set, $setOnInsert: { dataScope: user.dataScope, userId: user._id } }, { upsert: true, new: true });
}

async function loadInvoice(user, invoiceId) {
  const inv = await Invoice.findOne({ _id: invoiceId, ...scopeOf(user) }).populate('customerId', 'name gstNumber address').lean().catch(() => null);
  if (!inv) throw new ComplianceError(404, 'Invoice not found', 'NOT_FOUND');
  return inv;
}

/** The e-invoice payload and every reason it cannot be sent yet. */
async function eInvoiceCheck(user, inv) {
  const company = await businessSettings(user);
  const problems = [];
  const sellerGstin = normalizeGstin(company.gstNumber);
  const buyerGstin = normalizeGstin(inv.customerGstNumber || inv.customerId?.gstNumber);
  if (['draft', 'cancelled'].includes(inv.status)) problems.push('Only an issued invoice can be e-invoiced.');
  if (!isValidGstin(sellerGstin) || !sellerGstin) problems.push('Your business GSTIN is missing or invalid (Settings → Company).');
  if (!buyerGstin) problems.push('The customer has no GSTIN: e-invoicing applies to supplies to registered persons (B2B).');
  else if (!isValidGstin(buyerGstin)) problems.push(`Customer GSTIN ${buyerGstin} is invalid.`);
  const sellerPin = pinOf(company.companyAddress?.zipCode); const buyerPin = pinOf(inv.customerAddress || inv.customerId?.address);
  if (!sellerPin) problems.push('Your business address needs a 6-digit PIN code.');
  if (!buyerPin) problems.push('The customer address needs a 6-digit PIN code.');
  const pos = stateCodeOf(inv.placeOfSupply) || (buyerGstin ? buyerGstin.slice(0, 2) : null);
  if (!pos) problems.push('Place of supply is not set.');
  const items = (inv.items || []).map((it, i) => {
    const hsn = String(it.hsnCode || '').trim();
    if (!/^\d{4,8}$/.test(hsn)) problems.push(`Line ${i + 1} (${it.itemName}): HSN/SAC code is required (4–8 digits).`);
    const ass = Number(it.taxableValue ?? it.totalAmount) || 0;
    return {
      SlNo: String(i + 1), PrdDesc: it.itemName, IsServc: /^99/.test(hsn) ? 'Y' : 'N', HsnCd: hsn, Qty: Number(it.quantity) || 0,
      Unit: 'NOS', UnitPrice: Number(it.unitPrice) || 0, TotAmt: Number(it.totalAmount) || 0, AssAmt: ass, GstRt: Number(it.gstRate) || 0,
      IgstAmt: Number(it.igstAmount) || 0, CgstAmt: Number(it.cgstAmount) || 0, SgstAmt: Number(it.sgstAmount) || 0,
      TotItemVal: Math.round((ass + (it.igstAmount || 0) + (it.cgstAmount || 0) + (it.sgstAmount || 0)) * 100) / 100
    };
  });
  const payload = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: inv.reverseCharge ? 'Y' : 'N' },
    DocDtls: { Typ: 'INV', No: inv.invoiceNumber, Dt: ddmmyyyy(inv.invoiceDate) },
    SellerDtls: { Gstin: sellerGstin, LglNm: company.companyName, Addr1: company.companyAddress?.street || '', Loc: company.companyAddress?.city || '', Pin: sellerPin, Stcd: sellerGstin.slice(0, 2) },
    BuyerDtls: { Gstin: buyerGstin, LglNm: inv.customerName, Pos: pos, Addr1: String(inv.customerAddress || inv.customerId?.address || '').slice(0, 100), Loc: '', Pin: buyerPin, Stcd: buyerGstin ? buyerGstin.slice(0, 2) : '' },
    ItemList: items,
    ValDtls: { AssVal: inv.taxableAmount, CgstVal: inv.totalCgstAmount || 0, SgstVal: inv.totalSgstAmount || 0, IgstVal: inv.totalIgstAmount || 0, TotInvVal: inv.totalAmount }
  };
  return { payload, problems };
}

async function status(user, invoiceId) {
  const inv = await loadInvoice(user, invoiceId);
  const [settings, einv, ewb, check] = await Promise.all([
    settingsFor(user),
    EInvoiceRecord.findOne({ invoiceId: inv._id }).lean(),
    EwayBillRecord.find({ invoiceId: inv._id }).sort({ createdAt: -1 }).lean(),
    eInvoiceCheck(user, inv)
  ]);
  const threshold = settings.eWayBillThreshold;
  return {
    invoice: { _id: inv._id, invoiceNumber: inv.invoiceNumber, status: inv.status, totalAmount: inv.totalAmount },
    settings: { eInvoiceEnabled: settings.eInvoiceEnabled, eWayBillEnabled: settings.eWayBillEnabled, provider: settings.provider, environment: settings.environment, providerReady: providers.has(settings.provider), eWayBillThreshold: threshold ?? null },
    eInvoice: einv, eInvoiceProblems: check.problems,
    eWayBills: ewb,
    eWayBillRequired: threshold == null ? null : inv.totalAmount > threshold
  };
}

async function claim(Model, filter, user) {
  return Model.findOneAndUpdate(
    { ...filter, $or: [{ inFlightAt: null }, { inFlightAt: { $lt: new Date(Date.now() - 2 * 60e3) } }] },
    { $set: { inFlightAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  );
}

async function generateIrn(user, invoiceId) {
  const inv = await loadInvoice(user, invoiceId);
  const settings = await settingsFor(user);
  if (!settings.eInvoiceEnabled) throw new ComplianceError(409, 'E-invoicing is switched off for your business (Settings → GST compliance).', 'EINVOICE_DISABLED');
  const { payload, problems } = await eInvoiceCheck(user, inv);
  if (problems.length) throw new ComplianceError(400, 'The invoice is not ready for e-invoicing.', 'EINVOICE_INVALID', { problems });
  const existing = await EInvoiceRecord.findOne({ invoiceId: inv._id });
  if (existing?.status === 'generated') throw new ComplianceError(409, `IRN already generated for ${inv.invoiceNumber}.`, 'IRN_EXISTS', { irn: existing.irn });
  await EInvoiceRecord.updateOne({ invoiceId: inv._id }, { $setOnInsert: { invoiceNumber: inv.invoiceNumber, dataScope: inv.dataScope, status: 'pending' } }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; });
  const rec = await claim(EInvoiceRecord, { invoiceId: inv._id, status: { $in: ['pending', 'failed'] } }, user);
  if (!rec) throw new ComplianceError(409, 'An e-invoice request for this invoice is already in progress.', 'IN_PROGRESS');
  const requestHash = hash(payload);
  const provider = providers.get(settings.provider);
  if (!provider) {
    await EInvoiceRecord.updateOne({ _id: rec._id }, { $set: { inFlightAt: null, lastError: 'No e-invoice provider is configured.' }, $push: { events: { action: 'generate', outcome: 'blocked', message: 'PROVIDER_NOT_CONFIGURED', requestHash, by: user._id } } });
    throw new ComplianceError(503, 'No authorised e-invoice provider (GSP) is configured, so no IRN can be generated. Nothing was sent.', 'PROVIDER_NOT_CONFIGURED');
  }
  try {
    const r = await provider.generateIrn(payload, { environment: settings.environment, invoiceId: String(inv._id) });
    if (!r || !r.irn || !r.ackNo) throw new Error('The provider did not return an IRN and acknowledgement.');
    const done = await EInvoiceRecord.findOneAndUpdate({ _id: rec._id }, {
      $set: { status: 'generated', inFlightAt: null, provider: settings.provider, environment: settings.environment, irn: r.irn, ackNo: String(r.ackNo), ackDate: r.ackDate ? new Date(r.ackDate) : new Date(), signedQrCode: r.signedQrCode, signedInvoice: r.signedInvoice, lastError: null },
      $push: { events: { action: 'generate', outcome: 'success', requestHash, by: user._id } }
    }, { new: true });
    return done;
  } catch (error) {
    await EInvoiceRecord.updateOne({ _id: rec._id }, { $set: { status: 'failed', inFlightAt: null, lastError: String(error.message).slice(0, 500) }, $push: { events: { action: 'generate', outcome: 'failed', message: String(error.message).slice(0, 300), requestHash, by: user._id } } });
    throw new ComplianceError(502, `The e-invoice provider refused or failed: ${error.message}`, 'PROVIDER_ERROR');
  }
}

const IRN_CANCEL_REASONS = { 1: 'Duplicate', 2: 'Data entry mistake', 3: 'Order cancelled', 4: 'Others' };

async function cancelIrn(user, invoiceId, { reasonCode, remark } = {}) {
  const inv = await loadInvoice(user, invoiceId);
  if (!IRN_CANCEL_REASONS[reasonCode]) throw new ComplianceError(400, 'Choose a cancellation reason (1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others).', 'INVALID_REASON');
  const rec = await EInvoiceRecord.findOne({ invoiceId: inv._id });
  if (!rec || rec.status !== 'generated') throw new ComplianceError(409, 'There is no generated IRN to cancel.', 'NO_IRN');
  if (Date.now() - new Date(rec.ackDate).getTime() > 24 * 3600e3) throw new ComplianceError(409, 'An IRN can be cancelled only within 24 hours of generation. Raise a credit note instead.', 'CANCEL_WINDOW_PASSED');
  const settings = await settingsFor(user);
  const provider = providers.get(rec.provider || settings.provider);
  if (!provider) throw new ComplianceError(503, 'No authorised e-invoice provider is configured.', 'PROVIDER_NOT_CONFIGURED');
  const claimed = await claim(EInvoiceRecord, { _id: rec._id, status: 'generated' }, user);
  if (!claimed) throw new ComplianceError(409, 'A request for this e-invoice is already in progress.', 'IN_PROGRESS');
  try {
    await provider.cancelIrn({ irn: rec.irn, reasonCode: String(reasonCode), remark: String(remark || IRN_CANCEL_REASONS[reasonCode]).slice(0, 100) }, { environment: rec.environment });
    return EInvoiceRecord.findOneAndUpdate({ _id: rec._id }, { $set: { status: 'cancelled', inFlightAt: null, cancelledAt: new Date(), cancelReasonCode: String(reasonCode), cancelRemark: remark }, $push: { events: { action: 'cancel', outcome: 'success', by: user._id } } }, { new: true });
  } catch (error) {
    await EInvoiceRecord.updateOne({ _id: rec._id }, { $set: { inFlightAt: null, lastError: String(error.message).slice(0, 500) }, $push: { events: { action: 'cancel', outcome: 'failed', message: String(error.message).slice(0, 300), by: user._id } } });
    throw new ComplianceError(502, `The provider could not cancel the IRN: ${error.message}`, 'PROVIDER_ERROR');
  }
}

const VEHICLE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$|^TM[A-Z0-9]{6}$/;

function ewbProblems(body) {
  const p = [];
  if (!['road', 'rail', 'air', 'ship'].includes(body.transportMode)) p.push('Choose the transport mode.');
  const vehicle = String(body.vehicleNumber || '').replace(/[\s-]/g, '').toUpperCase();
  if (body.transportMode === 'road' && !VEHICLE.test(vehicle)) p.push('Enter a valid vehicle number (e.g. KL07AB1234).');
  if (body.transportMode !== 'road' && !body.transportDocNumber) p.push('Enter the transport document number for rail, air or ship.');
  const km = Number(body.distanceKm);
  if (!(km >= 0 && km <= 4000)) p.push('Distance must be 0 to 4,000 km.');
  if (body.transporterId && !isValidGstin(normalizeGstin(body.transporterId)) && !/^88[0-9A-Z]{13}$/.test(String(body.transporterId))) p.push('Transporter ID must be a GSTIN or a 15-character transporter ID.');
  for (const k of ['fromPincode', 'toPincode']) if (!/^\d{6}$/.test(String(body[k] || ''))) p.push(`${k === 'fromPincode' ? 'Dispatch' : 'Delivery'} PIN code must be 6 digits.`);
  return { problems: p, vehicle };
}

async function generateEwb(user, invoiceId, body = {}) {
  const inv = await loadInvoice(user, invoiceId);
  const settings = await settingsFor(user);
  if (!settings.eWayBillEnabled) throw new ComplianceError(409, 'E-way bills are switched off for your business (Settings → GST compliance).', 'EWB_DISABLED');
  if (['draft', 'cancelled'].includes(inv.status)) throw new ComplianceError(409, 'Only an issued invoice can have an e-way bill.', 'NOT_ISSUED');
  const { problems, vehicle } = ewbProblems(body);
  if (problems.length) throw new ComplianceError(400, 'The transport details are incomplete.', 'EWB_INVALID', { problems });
  const fields = {
    transportMode: body.transportMode, vehicleNumber: vehicle || undefined, vehicleType: body.vehicleType === 'over_dimensional' ? 'over_dimensional' : 'regular',
    transporterId: body.transporterId, transporterName: body.transporterName, transportDocNumber: body.transportDocNumber,
    transportDocDate: body.transportDocDate ? new Date(body.transportDocDate) : undefined, distanceKm: Number(body.distanceKm), fromPincode: body.fromPincode, toPincode: body.toPincode
  };
  let rec;
  try {
    rec = await EwayBillRecord.findOneAndUpdate({ invoiceId: inv._id, status: { $in: ['pending', 'failed'] } }, { $set: fields, $setOnInsert: { invoiceNumber: inv.invoiceNumber, dataScope: inv.dataScope } }, { upsert: true, new: true });
  } catch (error) {
    if (error.code === 11000) throw new ComplianceError(409, 'This invoice already has an active e-way bill.', 'EWB_EXISTS');
    throw error;
  }
  if (rec.status === 'generated') throw new ComplianceError(409, 'This invoice already has an active e-way bill.', 'EWB_EXISTS');
  const claimed = await claim(EwayBillRecord, { _id: rec._id, status: { $in: ['pending', 'failed'] } }, user);
  if (!claimed) throw new ComplianceError(409, 'An e-way bill request for this invoice is already in progress.', 'IN_PROGRESS');
  const provider = providers.get(settings.provider);
  if (!provider || !provider.generateEwb) {
    await EwayBillRecord.updateOne({ _id: rec._id }, { $set: { inFlightAt: null, status: 'pending', lastError: 'No e-way bill provider is configured.' }, $push: { events: { action: 'generate', outcome: 'blocked', message: 'PROVIDER_NOT_CONFIGURED', by: user._id } } });
    throw new ComplianceError(503, 'No authorised e-way bill provider is configured, so no e-way bill can be generated. The transport details were saved.', 'PROVIDER_NOT_CONFIGURED');
  }
  try {
    const r = await provider.generateEwb({ invoiceNumber: inv.invoiceNumber, invoiceDate: ddmmyyyy(inv.invoiceDate), totalValue: inv.totalAmount, ...fields }, { environment: settings.environment });
    if (!r || !r.ewbNumber) throw new Error('The provider did not return an e-way bill number.');
    return EwayBillRecord.findOneAndUpdate({ _id: rec._id }, { $set: { status: 'generated', inFlightAt: null, ewbNumber: String(r.ewbNumber), ewbDate: r.ewbDate ? new Date(r.ewbDate) : new Date(), validUntil: r.validUntil ? new Date(r.validUntil) : undefined, lastError: null }, $push: { events: { action: 'generate', outcome: 'success', by: user._id } } }, { new: true });
  } catch (error) {
    await EwayBillRecord.updateOne({ _id: rec._id }, { $set: { status: 'failed', inFlightAt: null, lastError: String(error.message).slice(0, 500) }, $push: { events: { action: 'generate', outcome: 'failed', message: String(error.message).slice(0, 300), by: user._id } } });
    throw new ComplianceError(502, `The e-way bill provider refused or failed: ${error.message}`, 'PROVIDER_ERROR');
  }
}

module.exports = { ComplianceError, registerProvider, unregisterProvider, settingsFor, saveSettings, status, generateIrn, cancelIrn, generateEwb, eInvoiceCheck, ewbProblems, IRN_CANCEL_REASONS };
