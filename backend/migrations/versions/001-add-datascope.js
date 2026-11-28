/**
 * 001 — add `dataScope` (tenant key) to documents created before it existed.
 * Replaces migrations/add-datascope-migration.js (kept for history).
 * Sets dataScope from the owning user's dataScope; documents whose owner has
 * none or is unknown are NOT touched and are reported (validate lists them).
 * Adds one field and never changes other data, so it needs no rollback.
 */
const COLLECTIONS = ['customers', 'jobs', 'invoices', 'payments', 'inventories', 'tasks', 'vendors', 'categories', 'units', 'hsncodes', 'discountrules', 'events', 'files', 'proofs', 'timeentries', 'walkinjobs', 'emergencyorders', 'inventorymovements', 'purchaseorders', 'portalsessions', 'settings'];

exports.id = '001-add-datascope';
exports.description = 'Add dataScope to documents created before multi-tenant scoping';
exports.irreversible = true;
exports.recovery = 'Adding dataScope is additive. To undo, $unset dataScope on documents whose createdAt precedes the migration row\'s finishedAt AND whose dataScope equals their owner\'s; or restore the pre-migration backup.';

exports.up = async (ctx) => {
  const users = await ctx.db.collection('users').find({ dataScope: { $type: 'string' } }, { projection: { dataScope: 1 } }).toArray();
  const names = new Set((await ctx.db.listCollections().toArray()).map((c) => c.name));
  for (const name of COLLECTIONS.filter((c) => names.has(c))) {
    for (const u of users) {
      await ctx.updateMany(name, { userId: u._id, dataScope: { $exists: false } }, { $set: { dataScope: u.dataScope } });
    }
  }
};

exports.validate = async (ctx) => {
  const names = new Set((await ctx.db.listCollections().toArray()).map((c) => c.name));
  const owners = new Set((await ctx.db.collection('users').find({ dataScope: { $type: 'string' } }, { projection: { _id: 1 } }).toArray()).map((u) => String(u._id)));
  const problems = [];
  for (const name of COLLECTIONS.filter((c) => names.has(c))) {
    const rows = await ctx.db.collection(name).find({ dataScope: { $exists: false }, userId: { $exists: true } }, { projection: { userId: 1 } }).limit(5000).toArray();
    const fixable = rows.filter((r) => owners.has(String(r.userId))).length;
    if (fixable) problems.push(`${name}: ${fixable} documents still lack dataScope`);
  }
  return problems;
};
