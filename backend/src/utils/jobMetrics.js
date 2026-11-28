/**
 * One definition of the job pipeline's business rules, used by the dashboard,
 * the production board and notifications so their numbers always agree.
 *
 * Stage order follows client/src/lib/printWorkflow.ts (STAGES). The labels the
 * shop sees map onto the stored Job.status values:
 *
 *   Enquiry            inquiry             ┐ pre-production
 *   Quote Sent         quotation_sent      ┘
 *   Order Confirmed    quotation_approved  ┐
 *   Design/Pre-press   design_in_progress  │
 *   Proof Approved     design_approved     │ in production
 *   Plates/Make-ready  production_ready    │
 *   On Press           ready_for_print     │
 *   Finishing & QC     quality_check       ┘
 *   Ready to Dispatch  completed           — awaiting dispatch
 *   Delivered          delivered           — closed
 *   Cancelled          cancelled           — closed
 */
const PIPELINE = [
  'inquiry', 'quotation_sent', 'quotation_approved', 'design_in_progress', 'design_approved',
  'production_ready', 'ready_for_print', 'quality_check', 'completed', 'delivered'
];
const ALL_STATUSES = [...PIPELINE, 'cancelled'];
const PRE_PRODUCTION = ['inquiry', 'quotation_sent'];
const IN_PRODUCTION = ['quotation_approved', 'design_in_progress', 'design_approved', 'production_ready', 'ready_for_print', 'quality_check'];
const READY_FOR_DISPATCH = ['completed'];
const CLOSED = ['delivered', 'cancelled'];
/** Open work: anything not delivered or cancelled. "Ready to dispatch" jobs are still open. */
const OPEN = { status: { $nin: CLOSED } };
/** Work still to be made (used for rush and overdue alerts): open and not yet finished. */
const UNFINISHED = { status: { $nin: ['completed', ...CLOSED] } };

const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/**
 * Counts by status plus the derived totals, from one aggregation over the jobs
 * a login may see (`scope`, from utils/jobAccess.js).
 */
async function pipelineSummary(Job, scope, now = new Date()) {
  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + 864e5);
  const [row] = await Job.aggregate([
    { $match: scope },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
        overdue: [{ $match: { ...UNFINISHED, dueDate: { $lt: today } } }, { $count: 'n' }],
        dueToday: [{ $match: { ...UNFINISHED, dueDate: { $gte: today, $lt: tomorrow } } }, { $count: 'n' }],
        rush: [{ $match: { ...UNFINISHED, priority: 'urgent' } }, { $count: 'n' }]
      }
    }
  ]);
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  for (const { _id, n } of row.byStatus) counts[_id || 'inquiry'] = (counts[_id || 'inquiry'] || 0) + n;
  const sum = (list) => list.reduce((t, s) => t + (counts[s] || 0), 0);
  return {
    counts,
    totals: {
      all: Object.values(counts).reduce((a, b) => a + b, 0),
      open: sum(ALL_STATUSES.filter((s) => !CLOSED.includes(s))),
      preProduction: sum(PRE_PRODUCTION),
      inProduction: sum(IN_PRODUCTION),
      readyForDispatch: sum(READY_FOR_DISPATCH),
      delivered: counts.delivered || 0,
      cancelled: counts.cancelled || 0,
      overdue: row.overdue[0]?.n || 0,
      dueToday: row.dueToday[0]?.n || 0,
      rush: row.rush[0]?.n || 0
    }
  };
}

module.exports = { PIPELINE, ALL_STATUSES, PRE_PRODUCTION, IN_PRODUCTION, READY_FOR_DISPATCH, CLOSED, OPEN, UNFINISHED, pipelineSummary, startOfDay };
