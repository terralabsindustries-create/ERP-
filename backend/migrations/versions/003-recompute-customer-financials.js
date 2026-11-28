/**
 * 003 — recompute stored customer totals with the corrected definitions
 * (services/customerFinancials.js): totalRevenue was the sum of Job.estimatedCost;
 * it now means invoiced revenue (estimate moves to estimatedJobValue).
 * Derived data only: customers' own fields are untouched. The previous values of
 * every changed customer are kept in `_migration_backups`, so down() restores them.
 */
exports.id = '003-recompute-customer-financials';
exports.description = 'Recompute Customer totalRevenue/totalSpent/outstandingBalance/estimatedJobValue from invoices and payments';
exports.recovery = 'down() restores the previous values from _migration_backups.';

const FIELDS = ['totalRevenue', 'totalSpent', 'outstandingBalance', 'estimatedJobValue', 'cancelledInvoiceTotal', 'totalOrders'];

exports.up = async (ctx) => {
  const { financialsFor } = require('../../src/services/customerFinancials');
  const customers = ctx.db.collection('customers');
  const all = await customers.find({}, { projection: { dataScope: 1, userId: 1, ...Object.fromEntries(FIELDS.map((f) => [f, 1])) } }).toArray();
  for (let i = 0; i < all.length; i += 200) {
    const batch = all.slice(i, i + 200);
    const byScope = new Map();
    for (const c of batch) { const k = c.dataScope ? `s:${c.dataScope}` : `u:${c.userId}`; (byScope.get(k) || byScope.set(k, []).get(k)).push(c); }
    const ops = [];
    const backups = [];
    for (const group of byScope.values()) {
      const scope = group[0].dataScope ? { dataScope: group[0].dataScope } : { userId: group[0].userId };
      const f = await financialsFor(group.map((c) => c._id), scope);
      for (const c of group) {
        const x = f.get(String(c._id));
        const next = { totalRevenue: x.invoicedRevenue, totalSpent: x.paymentsReceived, outstandingBalance: x.outstanding, estimatedJobValue: x.estimatedJobValue, cancelledInvoiceTotal: x.cancelledInvoiced, totalOrders: x.totalOrders };
        if (FIELDS.every((k) => Math.abs((c[k] || 0) - next[k]) < 0.005)) continue;
        backups.push(Object.fromEntries([['_id', c._id], ...FIELDS.map((k) => [k, c[k]])]));
        ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: next } } });
      }
    }
    await ctx.backup('customers', backups);
    await ctx.bulkWrite('customers', ops);
  }
};

exports.validate = async (ctx) => {
  const { financialsOne } = require('../../src/services/customerFinancials');
  const sample = await ctx.db.collection('customers').find({}).limit(200).toArray();
  const problems = [];
  for (const c of sample) {
    const x = await financialsOne(c._id, c.dataScope ? { dataScope: c.dataScope } : { userId: c.userId });
    if (Math.abs((c.outstandingBalance || 0) - x.outstanding) > 0.01) problems.push(`customer ${c._id} outstanding differs after recompute`);
  }
  return problems.slice(0, 10);
};

exports.down = async (ctx) => {
  const rows = await ctx.backups('customers');
  await ctx.bulkWrite('customers', rows.map(({ row }) => {
    const { _id, ...rest } = row;
    const set = {}; const unset = {};
    for (const k of FIELDS) (rest[k] === undefined ? unset : set)[k] = rest[k];
    return { updateOne: { filter: { _id }, update: { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) } } };
  }));
};
