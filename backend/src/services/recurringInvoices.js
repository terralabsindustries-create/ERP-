const mongoose = require('mongoose');
const RecurringInvoice = require('../models/RecurringInvoice');
const { RecurringInvoiceRun } = RecurringInvoice;
const Customer = require('../models/Customer');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const { priceInvoiceDocument } = require('../utils/billing');
const invoiceCreation = require('./invoiceCreation');
const { issueInvoice } = require('./invoiceIssue');
const { IST_OFFSET_MS } = require('../utils/financialYear');
const { userCan } = require('../middleware/requirePermission');

/*
  Generating invoices from recurring templates.

  - A template is due when status is active, nextRunDate ≤ now and it is not in a
    retry back-off. Each due date is billed by claiming a RecurringInvoiceRun
    (unique per template + date) BEFORE the invoice is written: a second
    scheduler tick, a restart part-way, or another server instance that reaches
    the same date finds the claim and does nothing.
  - Missed dates (server down) are caught up in order, at most CATCH_UP_LIMIT per
    template per tick, each invoice dated on its own scheduled date.
  - A failed generation records the error on the run, leaves nextRunDate where it
    was, and retries after a back-off (15 min, 1 h, 4 h, then daily). A run left
    "running" by a crash for STALE_RUN_MS is retried.
  - The invoice is a draft unless the template issues automatically AND its owner
    may still issue invoices; issuing uses the normal issue service.
*/
const CATCH_UP_LIMIT = 12;
const STALE_RUN_MS = 10 * 60 * 1000;
const BACKOFF_MS = [15 * 60e3, 60 * 60e3, 4 * 3600e3, 24 * 3600e3];

class RecurringError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

const istParts = (d) => {
  const x = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate() };
};
const istDate = (y, m, d) => new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);
const periodKeyOf = (date) => { const { y, m, d } = istParts(date); return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The next scheduled date after `date` (India calendar), keeping the anchor day in short months. */
function nextDate(date, frequency, interval = 1, anchorDay) {
  const { y, m, d } = istParts(date);
  if (frequency === 'daily') return istDate(y, m, d + interval);
  if (frequency === 'weekly') return istDate(y, m, d + 7 * interval);
  const months = frequency === 'monthly' ? interval : frequency === 'quarterly' ? 3 * interval : 12 * interval;
  const target = m + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  return istDate(ty, tm, Math.min(anchorDay || d, daysIn(ty, tm)));
}

const scopeOf = (user) => (user.dataScope ? { dataScope: user.dataScope } : { userId: user._id });

/** Validates and normalises a template body (create or update). */
async function buildTemplate(user, body, existing = null) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!existing || has('name')) {
    const name = String(body.name || '').trim();
    if (!name) throw new RecurringError(400, 'Give the recurring invoice a name.', 'NAME_REQUIRED');
    out.name = name.slice(0, 120);
  }
  if (!existing || has('customerId')) {
    if (!mongoose.isValidObjectId(body.customerId)) throw new RecurringError(400, 'Choose a customer.', 'CUSTOMER_REQUIRED');
    const customer = await Customer.findOne({ _id: body.customerId, ...scopeOf(user) }).select('_id status');
    if (!customer) throw new RecurringError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
    out.customerId = customer._id;
  }
  if (!existing || has('items')) {
    if (!Array.isArray(body.items) || !body.items.length) throw new RecurringError(400, 'Add at least one line.', 'NO_LINES');
    out.items = body.items.map((i, n) => {
      const rate = i.gstRate;
      if (rate === undefined || rate === null || rate === '' || !Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100) {
        throw new RecurringError(400, `Line ${n + 1}: enter a GST rate from 0 to 100% (0 if none) — a blank rate is not taken as 0.`, 'GST_RATE_REQUIRED');
      }
      const quantity = Number(i.quantity); const unitPrice = Number(i.unitPrice);
      if (!String(i.itemName || '').trim()) throw new RecurringError(400, `Line ${n + 1}: enter what is billed.`, 'LINE_NAME');
      if (!(quantity > 0) || !(unitPrice >= 0)) throw new RecurringError(400, `Line ${n + 1}: enter a quantity and a price.`, 'LINE_AMOUNT');
      return { itemName: String(i.itemName).trim(), description: i.description ? String(i.description).trim() : undefined, hsnCode: i.hsnCode ? String(i.hsnCode).trim() : undefined, quantity, unit: i.unit || 'pieces', unitPrice, gstRate: Number(rate) };
    });
  }
  if (!existing || has('frequency')) {
    if (!RecurringInvoice.FREQUENCIES.includes(body.frequency)) throw new RecurringError(400, 'Choose how often to bill.', 'FREQUENCY');
    out.frequency = body.frequency;
  }
  if (has('interval')) out.interval = Math.min(Math.max(parseInt(body.interval, 10) || 1, 1), 12);
  for (const k of ['isInterState', 'issueAutomatically']) if (has(k)) out[k] = body[k] === true;
  if (out.issueAutomatically && !userCan(user, 'Invoicing: Create & Edit')) throw new RecurringError(403, 'Only logins that can issue invoices may set automatic issue.', 'PERMISSION_DENIED');
  for (const k of ['notes', 'termsAndConditions']) if (has(k)) out[k] = String(body[k] || '').trim();
  if (has('dueInDays')) out.dueInDays = Math.min(Math.max(parseInt(body.dueInDays, 10) || 0, 0), 365);
  if (has('placeOfSupply')) {
    const { stateCodeOf } = require('../utils/gstStates');
    out.placeOfSupply = stateCodeOf(body.placeOfSupply) || undefined;
  }
  const date = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
  if (!existing || has('startDate')) {
    const start = date(body.startDate);
    if (!start) throw new RecurringError(400, 'Choose a start date.', 'START_DATE');
    const p = istParts(start);
    out.startDate = istDate(p.y, p.m, p.d);
    out.anchorDay = p.d;
    if (!existing || existing.generatedCount === 0) out.nextRunDate = out.startDate;
  }
  if (has('endDate')) {
    if (!body.endDate) out.endDate = undefined;
    else {
      const end = date(body.endDate);
      if (!end) throw new RecurringError(400, 'The end date is not valid.', 'END_DATE');
      out.endDate = end;
    }
  }
  const start = out.startDate || existing?.startDate;
  const end = out.endDate !== undefined ? out.endDate : existing?.endDate;
  if (start && end && end < start) throw new RecurringError(400, 'The end date is before the start date.', 'END_BEFORE_START');
  return out;
}

async function generateOne(template, scheduledFor, { trigger = 'scheduler', now = new Date() } = {}) {
  const periodKey = periodKeyOf(scheduledFor);
  // Claim the date. A duplicate key means it was billed, or is being billed, already.
  let run;
  try {
    run = await RecurringInvoiceRun.create({ templateId: template._id, periodKey, scheduledFor, trigger, dataScope: template.dataScope });
  } catch (error) {
    if (error.code !== 11000) throw error;
    run = await RecurringInvoiceRun.findOneAndUpdate(
      { templateId: template._id, periodKey, $or: [{ status: 'failed' }, { status: 'running', updatedAt: { $lt: new Date(now - STALE_RUN_MS) } }] },
      { $set: { status: 'running', error: null, trigger }, $inc: { attempts: 1 } },
      { new: true }
    );
    if (!run) return { skipped: true, periodKey };
  }
  try {
    const owner = await User.findById(template.userId);
    if (!owner || !owner.isActive) throw new Error('The login that set up this recurring invoice is no longer active.');
    const customer = await Customer.findOne({ _id: template.customerId, ...scopeOf(owner) });
    if (!customer) throw new Error('The customer no longer exists.');
    const priced = priceInvoiceDocument({ items: template.items.map((i) => i.toObject ? i.toObject() : i), isInterState: template.isInterState });
    if (priced.error) throw new Error(priced.error);
    const dueDate = new Date(scheduledFor.getTime() + (template.dueInDays || 0) * 864e5);
    const data = {
      customerId: customer._id, customerName: customer.name, customerGstNumber: customer.gstNumber, customerAddress: customer.address,
      invoiceDate: scheduledFor, dueDate, items: priced.lines, ...priced.design,
      subtotal: priced.totals.subtotal, taxableAmount: priced.totals.taxableAmount, totalGstAmount: priced.totals.gst, totalAmount: priced.totals.total,
      isInterState: template.isInterState, placeOfSupply: template.placeOfSupply || undefined,
      notes: [template.notes, `Recurring: ${template.name} (${periodKey})`].filter(Boolean).join('\n'),
      termsAndConditions: template.termsAndConditions, status: 'draft', userId: owner._id, dataScope: owner.dataScope
    };
    let invoice = await invoiceCreation.createInvoiceWithStock(data, priced.lines, owner);
    let issued = false;
    if (template.issueAutomatically && userCan(owner, 'Invoicing: Create & Edit')) {
      invoice = await issueInvoice({ _id: invoice._id });
      issued = true;
    }
    await RecurringInvoiceRun.updateOne({ _id: run._id }, { $set: { status: 'generated', invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber, issued } });
    return { generated: true, periodKey, invoice };
  } catch (error) {
    await RecurringInvoiceRun.updateOne({ _id: run._id }, { $set: { status: 'failed', error: String(error.message).slice(0, 500) } });
    return { failed: true, periodKey, error };
  }
}

/** Bill every due date of one template (in order), then move its schedule on. */
async function runTemplate(template, { now = new Date(), trigger = 'scheduler' } = {}) {
  const results = [];
  let next = template.nextRunDate;
  for (let i = 0; i < CATCH_UP_LIMIT && next <= now; i += 1) {
    if (template.endDate && next > template.endDate) break;
    const r = await generateOne(template, next, { trigger, now });
    results.push(r);
    if (r.failed) {
      const failures = (template.consecutiveFailures || 0) + 1;
      await RecurringInvoice.updateOne({ _id: template._id }, { $set: { lastError: String(r.error.message).slice(0, 500), consecutiveFailures: failures, retryAfter: new Date(now.getTime() + BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]), lastRunAt: now } });
      return results;
    }
    next = nextDate(next, template.frequency, template.interval, template.anchorDay);
    const done = template.endDate && next > template.endDate;
    await RecurringInvoice.updateOne({ _id: template._id }, {
      $set: { nextRunDate: next, lastRunAt: now, lastError: null, consecutiveFailures: 0, retryAfter: null, ...(done ? { status: 'completed' } : {}) },
      ...(r.generated ? { $inc: { generatedCount: 1 } } : {})
    });
    if (done) break;
  }
  return results;
}

/** One scheduler tick: every due template of every business. */
async function runDueRecurringInvoices(now = new Date()) {
  const due = await RecurringInvoice.find({ status: 'active', nextRunDate: { $lte: now }, $or: [{ retryAfter: null }, { retryAfter: { $lte: now } }] }).limit(200);
  let generated = 0; let failed = 0;
  for (const t of due) {
    try {
      const r = await runTemplate(t, { now });
      generated += r.filter((x) => x.generated).length;
      failed += r.filter((x) => x.failed).length;
    } catch (error) {
      failed += 1;
      console.error('Recurring invoice template failed:', String(t._id), error.message);
    }
  }
  return { templates: due.length, generated, failed };
}

module.exports = { buildTemplate, runTemplate, runDueRecurringInvoices, generateOne, nextDate, periodKeyOf, RecurringError, scopeOf, CATCH_UP_LIMIT };
