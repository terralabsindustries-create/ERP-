/**
 * 002 — create the indexes declared by the schemas (performance audit, credit/debit
 * note lifecycle, audit trail, transaction journal, idempotency). Replaces
 * migrations/2026-11-27-performance-and-lifecycle-indexes.js.
 * Only CREATES missing indexes; never drops one, never touches a document.
 * (Not syncIndexes(): that drops indexes missing from the schema.)
 */
const MODELS = ['Customer', 'Invoice', 'Job', 'Task', 'Notification', 'User', 'SubscriptionPurchase', 'CreditNote', 'ActivityLog', 'TransactionJournal', 'IdempotencyRecord'];

exports.id = '002-performance-and-lifecycle-indexes';
exports.description = 'Create missing schema indexes (performance, credit notes, audit trail, journal, idempotency)';
exports.recovery = 'Indexes are additive; drop one by name with db.collection.dropIndex(name) if it must be removed.';

const missing = async (ctx, Model) => {
  const existing = await Model.collection.indexes().catch(() => []);
  const has = new Set(existing.map((i) => JSON.stringify(i.key)));
  // MongoDB stores a text index's key as { _fts: 'text', _ftsx: 1 }, never as its declared fields.
  const hasText = existing.some((i) => i.key && i.key._fts === 'text');
  return Model.schema.indexes().filter(([fields]) => (Object.values(fields).includes('text') ? !hasText : !has.has(JSON.stringify(fields))));
};

exports.up = async (ctx) => {
  for (const name of MODELS) {
    const Model = require(`../../src/models/${name}`);
    const gaps = await missing(ctx, Model);
    ctx.count(`${name}.missingIndexes`, gaps.length);
    if (!ctx.dryRun && gaps.length) await Model.createIndexes();
  }
};

exports.validate = async (ctx) => {
  const problems = [];
  for (const name of MODELS) {
    const gaps = await missing(ctx, require(`../../src/models/${name}`));
    if (gaps.length) problems.push(`${name} still lacks ${gaps.length} index(es)`);
  }
  return problems;
};
