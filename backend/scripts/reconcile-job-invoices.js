#!/usr/bin/env node
/**
 * Job ticket ↔ invoice reconciliation.
 *
 * A job ticket counts as billed when a non-cancelled invoice carries its id in
 * `jobId` (GET /api/jobs, GET /api/invoices/pending-jobs). An invoice raised
 * from the Invoices page without picking the job — or one whose job was
 * dropped by an edit — leaves its job ticket reading "Not billed" with a
 * "Create invoice" button, which invites a second invoice.
 *
 * This script finds:
 *   1. unlinkedInvoices — non-cancelled invoices with no jobId, and the job
 *      ticket each one most likely bills. A job is only a candidate when it is
 *      in the same business, has the same customer *id* (never just the same
 *      name), was created before the invoice and has no invoice of its own. It
 *      is proposed for linking ("exact") only when the evidence is
 *      unambiguous: the quotation the invoice was converted from names the job,
 *      or the invoice's lines are exactly the job ticket's items and no other
 *      job or invoice of that customer matches the same way.
 *   2. brokenLinks — invoices whose jobId points at a missing job, at a job of
 *      another customer, or at a job of another business.
 *   3. multiplyBilledJobs — jobs with more than one non-cancelled invoice
 *      (possible duplicates; reported only, never changed).
 *
 * Usage (from backend/):
 *   node scripts/reconcile-job-invoices.js                 # report only (default)
 *   node scripts/reconcile-job-invoices.js --org=<scope>   # one business only
 *   node scripts/reconcile-job-invoices.js --json          # machine-readable report
 *   node scripts/reconcile-job-invoices.js --apply         # link the "exact" matches
 *
 * --apply only sets jobId on invoices that still have none (checked again in
 * the update itself), and writes every change to
 * reconcile-job-invoices-<timestamp>.json so it can be undone with
 * `--undo=<that file>`. It never touches amounts, statuses, payments or the
 * job's production stage. Take a database backup before applying to
 * production, and review the dry-run report first.
 */
const fs = require('fs');
const path = require('path');

const ACTIVE = { status: { $ne: 'cancelled' } };

/** The business a record belongs to: its dataScope, or its owner for pre-dataScope records. */
const orgKey = (doc) => (doc.dataScope ? `scope:${doc.dataScope}` : `user:${doc.userId}`);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const num = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** A comparable fingerprint of a list of lines: name, quantity and unit price. */
function linesKey(items) {
  return (items || [])
    .map((i) => `${norm(i.itemName)}|${num(i.quantity)}|${num(i.unitPrice)}`)
    .sort()
    .join('\n');
}

/**
 * The report. `models` are the Mongoose models { Invoice, Job, Quotation };
 * `dataScope` limits it to one business.
 */
async function analyse({ Invoice, Job, Quotation }, { dataScope } = {}) {
  const scope = dataScope ? { dataScope } : {};

  const invoices = await Invoice.find({ ...scope, ...ACTIVE })
    .select('invoiceNumber customerId customerName jobId jobTitle items.itemName items.quantity items.unitPrice totalAmount status paymentStatus dataScope userId createdAt')
    .lean();
  const jobs = await Job.find(scope)
    .select('title customerId status items.itemName items.quantity items.unitPrice dataScope userId createdAt')
    .lean();
  const jobById = new Map(jobs.map((j) => [String(j._id), j]));

  // Jobs that some non-cancelled invoice already bills.
  const billedJobIds = new Set();
  const invoicesByJob = new Map();
  for (const inv of invoices) {
    if (!inv.jobId) continue;
    const id = String(inv.jobId);
    billedJobIds.add(id);
    if (!invoicesByJob.has(id)) invoicesByJob.set(id, []);
    invoicesByJob.get(id).push(inv);
  }

  // 2. Links that point somewhere they should not.
  const brokenLinks = [];
  for (const inv of invoices) {
    if (!inv.jobId) continue;
    const job = jobById.get(String(inv.jobId));
    let problem = null;
    if (!job) {
      // Not in this scope: either deleted, or in another business. Look it up
      // without the scope to tell which.
      const anywhere = await Job.findById(inv.jobId).select('dataScope userId').lean();
      problem = anywhere ? 'job belongs to another business' : 'job no longer exists';
    } else if (orgKey(job) !== orgKey(inv)) {
      problem = 'job belongs to another business';
    } else if (String(job.customerId) !== String(inv.customerId)) {
      problem = 'job is for a different customer';
    }
    if (problem) {
      brokenLinks.push({ invoiceId: String(inv._id), invoiceNumber: inv.invoiceNumber, jobId: String(inv.jobId), problem });
    }
  }

  // 3. Jobs billed more than once.
  const multiplyBilledJobs = [];
  for (const [jobId, list] of invoicesByJob) {
    if (list.length < 2) continue;
    const job = jobById.get(jobId);
    multiplyBilledJobs.push({
      jobId,
      jobTitle: job?.title,
      invoices: list.map((i) => ({ invoiceId: String(i._id), invoiceNumber: i.invoiceNumber, totalAmount: i.totalAmount, status: i.status }))
    });
  }

  // Quotations converted into an invoice, with the job they were for.
  const quotedJob = new Map();
  if (Quotation) {
    const quotes = await Quotation.find({ ...scope, convertedInvoiceId: { $ne: null }, jobId: { $ne: null } })
      .select('convertedInvoiceId jobId quotationNumber')
      .lean();
    for (const q of quotes) quotedJob.set(String(q.convertedInvoiceId), { jobId: String(q.jobId), quotationNumber: q.quotationNumber });
  }

  // 1. Invoices without a job, and the job each one most likely bills.
  const unlinked = invoices.filter((inv) => !inv.jobId);
  const candidatesFor = (inv) => jobs.filter((j) =>
    orgKey(j) === orgKey(inv) &&
    String(j.customerId) === String(inv.customerId) &&
    !billedJobIds.has(String(j._id)) &&
    (!j.createdAt || !inv.createdAt || new Date(j.createdAt) <= new Date(inv.createdAt))
  );

  const proposals = unlinked.map((inv) => {
    const candidates = candidatesFor(inv);
    const invKey = linesKey(inv.items);
    const scored = candidates.map((j) => {
      const reasons = [];
      const q = quotedJob.get(String(inv._id));
      if (q && q.jobId === String(j._id)) reasons.push(`converted from quotation ${q.quotationNumber} for this job`);
      if (j.items?.length && linesKey(j.items) === invKey) reasons.push('invoice lines equal the job ticket items');
      if (inv.jobTitle && norm(inv.jobTitle) === norm(j.title)) reasons.push('invoice job title equals the job title');
      return { jobId: String(j._id), jobTitle: j.title, jobStatus: j.status, reasons };
    });
    const strong = scored.filter((s) => s.reasons.some((r) => r.startsWith('converted from') || r.startsWith('invoice lines')));
    return {
      invoiceId: String(inv._id),
      invoiceNumber: inv.invoiceNumber,
      customerId: String(inv.customerId),
      customerName: inv.customerName,
      totalAmount: inv.totalAmount,
      paymentStatus: inv.paymentStatus,
      org: orgKey(inv),
      candidates: scored,
      strong
    };
  });

  // A job proposed for two invoices is ambiguous for both.
  const proposedJobCount = new Map();
  for (const p of proposals) {
    if (p.strong.length === 1) proposedJobCount.set(p.strong[0].jobId, (proposedJobCount.get(p.strong[0].jobId) || 0) + 1);
  }
  const unlinkedInvoices = proposals.map(({ strong, ...p }) => {
    let confidence = 'none';
    let proposedJobId = null;
    if (strong.length === 1 && proposedJobCount.get(strong[0].jobId) === 1) {
      confidence = 'exact';
      proposedJobId = strong[0].jobId;
    } else if (p.candidates.length > 0) {
      confidence = 'review';
    }
    return { ...p, confidence, proposedJobId };
  });

  return {
    generatedAt: new Date().toISOString(),
    scope: dataScope || 'all businesses',
    summary: {
      invoicesChecked: invoices.length,
      unlinked: unlinkedInvoices.length,
      exact: unlinkedInvoices.filter((u) => u.confidence === 'exact').length,
      needsReview: unlinkedInvoices.filter((u) => u.confidence === 'review').length,
      noCandidate: unlinkedInvoices.filter((u) => u.confidence === 'none').length,
      brokenLinks: brokenLinks.length,
      multiplyBilledJobs: multiplyBilledJobs.length
    },
    unlinkedInvoices,
    brokenLinks,
    multiplyBilledJobs
  };
}

/** Link every "exact" proposal whose invoice still has no job. Returns the changes made. */
async function applyExact({ Invoice }, report) {
  const changes = [];
  for (const u of report.unlinkedInvoices) {
    if (u.confidence !== 'exact') continue;
    const res = await Invoice.updateOne(
      { _id: u.invoiceId, $or: [{ jobId: null }, { jobId: { $exists: false } }] },
      { $set: { jobId: u.proposedJobId } }
    );
    if (res.modifiedCount === 1) changes.push({ invoiceId: u.invoiceId, invoiceNumber: u.invoiceNumber, jobId: u.proposedJobId });
  }
  return changes;
}

/** Undo the changes listed in a file written by --apply (only where they still stand). */
async function undo({ Invoice }, changes) {
  let undone = 0;
  for (const c of changes) {
    const res = await Invoice.updateOne({ _id: c.invoiceId, jobId: c.jobId }, { $unset: { jobId: '' } });
    undone += res.modifiedCount;
  }
  return undone;
}

function printReport(r) {
  const s = r.summary;
  console.log(`Job ticket ↔ invoice reconciliation (${r.scope}) — ${r.generatedAt}`);
  console.log(`Invoices checked: ${s.invoicesChecked}. Without a job: ${s.unlinked} (exact match ${s.exact}, needs review ${s.needsReview}, no candidate ${s.noCandidate}).`);
  console.log(`Broken links: ${s.brokenLinks}. Jobs with more than one invoice: ${s.multiplyBilledJobs}.\n`);
  for (const u of r.unlinkedInvoices.filter((x) => x.confidence !== 'none')) {
    console.log(`[${u.confidence}] ${u.invoiceNumber} — ${u.customerName} — ₹${u.totalAmount} (${u.paymentStatus})`);
    for (const c of u.candidates) {
      const mark = c.jobId === u.proposedJobId ? '→' : ' ';
      console.log(`   ${mark} job ${c.jobId} "${c.jobTitle}" (${c.jobStatus})${c.reasons.length ? ` — ${c.reasons.join('; ')}` : ''}`);
    }
  }
  for (const b of r.brokenLinks) console.log(`[broken] ${b.invoiceNumber} → job ${b.jobId}: ${b.problem}`);
  for (const m of r.multiplyBilledJobs) {
    console.log(`[billed ${m.invoices.length}×] job ${m.jobId} "${m.jobTitle}": ${m.invoices.map((i) => `${i.invoiceNumber} ₹${i.totalAmount} (${i.status})`).join(', ')}`);
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }));
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mongoose = require('mongoose');
  const Invoice = require('../src/models/Invoice');
  const Job = require('../src/models/Job');
  const Quotation = require('../src/models/Quotation');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    if (args.undo) {
      const changes = JSON.parse(fs.readFileSync(args.undo, 'utf8')).changes || [];
      console.log(`Undid ${await undo({ Invoice }, changes)} of ${changes.length} links.`);
      return;
    }
    const report = await analyse({ Invoice, Job, Quotation }, { dataScope: typeof args.org === 'string' ? args.org : undefined });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    if (args.apply) {
      const changes = await applyExact({ Invoice }, report);
      const file = path.join(process.cwd(), `reconcile-job-invoices-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify({ appliedAt: new Date().toISOString(), changes }, null, 2));
      console.log(`\nLinked ${changes.length} invoices to their job tickets. Changes written to ${file} (undo with --undo=${file}).`);
    } else {
      console.log('\nReport only — nothing was changed. Run with --apply to link the exact matches.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { analyse, applyExact, undo, linesKey };
