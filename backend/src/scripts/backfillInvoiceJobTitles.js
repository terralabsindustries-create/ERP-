/**
 * Fills in the job title on older invoices that were raised from a job ticket
 * or billed from a counter job, but were saved without the title (no screen
 * sent one, so the invoice list showed the job only while the job ticket still
 * existed).
 *
 *   node src/scripts/backfillInvoiceJobTitles.js           # dry run: reports, writes nothing
 *   node src/scripts/backfillInvoiceJobTitles.js --apply   # writes the titles
 *
 * Only `jobTitle` is written, and only where it is empty: totals, payments,
 * statuses and updatedAt are left as they are. An invoice whose job ticket no
 * longer exists is left without a title. Safe to run again.
 */
const path = require('path');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Job = require('../models/Job');
const WalkInJob = require('../models/WalkInJob');

const NO_TITLE = { $or: [{ jobTitle: { $exists: false } }, { jobTitle: null }, { jobTitle: '' }] };

async function backfillInvoiceJobTitles({ apply = false, log = console.log } = {}) {
  const writes = [];

  // Invoices linked to a job ticket that still exists.
  const linked = await Invoice.find({ jobId: { $ne: null }, ...NO_TITLE }).select('_id invoiceNumber jobId').lean();
  const jobs = await Job.find({ _id: { $in: [...new Set(linked.map((i) => String(i.jobId)))] } }).select('title').lean();
  const titleOf = new Map(jobs.map((j) => [String(j._id), j.title]));
  let fromJobs = 0;
  let missingJobs = 0;
  for (const invoice of linked) {
    const title = titleOf.get(String(invoice.jobId));
    if (!title) {
      missingJobs += 1;
      continue;
    }
    fromJobs += 1;
    writes.push({ updateOne: { filter: { _id: invoice._id, ...NO_TITLE }, update: { $set: { jobTitle: title } }, timestamps: false } });
  }

  // Invoices a counter job was billed on, with no job ticket of their own.
  const counterJobs = await WalkInJob.find({ 'billing.invoice': { $ne: null } }).select('jobNumber description billing.invoice').lean();
  const counterOf = new Map(counterJobs.map((j) => [String(j.billing.invoice), j]));
  const counterInvoices = counterOf.size
    ? await Invoice.find({ _id: { $in: [...counterOf.keys()] }, jobId: null, ...NO_TITLE }).select('_id').lean()
    : [];
  for (const invoice of counterInvoices) {
    const title = WalkInJob.invoiceTitle(counterOf.get(String(invoice._id)));
    writes.push({ updateOne: { filter: { _id: invoice._id, jobId: null, ...NO_TITLE }, update: { $set: { jobTitle: title } }, timestamps: false } });
  }
  const fromCounterJobs = counterInvoices.length;

  log(`Invoices to fill from job tickets: ${fromJobs}`);
  log(`Invoices to fill from counter jobs: ${fromCounterJobs}`);
  log(`Invoices whose job ticket no longer exists (left as they are): ${missingJobs}`);

  let written = 0;
  if (apply && writes.length) {
    const result = await Invoice.bulkWrite(writes, { ordered: false });
    written = result.modifiedCount;
    log(`Written: ${written}`);
  } else if (!apply) {
    log('Dry run: nothing written. Run with --apply to write.');
  }
  return { fromJobs, fromCounterJobs, missingJobs, written };
}

module.exports = { backfillInvoiceJobTitles };

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    try {
      await backfillInvoiceJobTitles({ apply: process.argv.includes('--apply') });
    } finally {
      await mongoose.disconnect();
    }
  })().catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });
}
