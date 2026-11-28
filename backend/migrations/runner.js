/**
 * Migration runner.
 *
 *   id          each migration file in migrations/versions/ exports a unique, ordered `id`
 *               (NNN-short-name); files run in id order
 *   history     collection `_migrations`: one row per migration (applied / failed /
 *               rolled_back) with checksum, timings, counts, error, host
 *   idempotent  an applied migration is skipped; a changed checksum of an applied one is reported
 *   dry-run     `plan` runs the migration with ctx.dryRun = true; every write goes
 *               through ctx helpers that only COUNT in dry-run, so nothing changes
 *   lock        one runner at a time (`_migration_lock`, expires after 15 minutes)
 *   validate    each migration's validate(ctx) runs after up(); a failed validation marks it failed
 *   rollback    down(ctx) when the migration defines it (restoring from rows it backed up in
 *               `_migration_backups`); otherwise `irreversible` with a documented recovery procedure
 *   safety      refuses a non-local database unless allowRemote is passed explicitly; the CLI
 *               never reads MONGODB_URI, so it cannot reach production by accident
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSIONS_DIR = path.join(__dirname, 'versions');
const LOCK_TTL_MS = 15 * 60 * 1000;
const isLocalUri = (uri) => /^mongodb(\+srv)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|$)/i.test(uri);

function load(dir = VERSIONS_DIR) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{3}-.+\.js$/.test(f)).sort() : [];
  const list = files.map((file) => {
    const full = path.join(dir, file);
    const mod = require(full);
    if (!mod.id || mod.id !== file.replace(/\.js$/, '')) throw new Error(`${file}: exported id must equal the file name (${file.replace(/\.js$/, '')})`);
    if (typeof mod.up !== 'function') throw new Error(`${file}: up(ctx) is required`);
    return { ...mod, file, checksum: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16) };
  });
  const ids = new Set();
  for (const m of list) { if (ids.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`); ids.add(m.id); }
  return list;
}

async function acquireLock(db, owner) {
  const now = new Date();
  try {
    await db.collection('_migration_lock').updateOne(
      { _id: 'lock', $or: [{ expiresAt: { $lt: now } }, { expiresAt: { $exists: false } }] },
      { $set: { owner, lockedAt: now, expiresAt: new Date(now.getTime() + LOCK_TTL_MS) } },
      { upsert: true }
    );
    return true;
  } catch (error) {
    if (error.code === 11000) return false; // held by another runner
    throw error;
  }
}
const releaseLock = (db, owner) => db.collection('_migration_lock').deleteOne({ _id: 'lock', owner });

function makeContext(mongoose, db, migration, dryRun, log) {
  const counts = {};
  const count = (key, n) => { counts[key] = (counts[key] || 0) + n; };
  return {
    mongoose, db, dryRun, log, counts, count,
    /** updateMany that only counts matches in dry-run. */
    async updateMany(collection, filter, update, options) {
      if (dryRun) { const n = await db.collection(collection).countDocuments(filter); count(`${collection}.wouldUpdate`, n); return { matched: n, modified: 0 }; }
      const r = await db.collection(collection).updateMany(filter, update, options);
      count(`${collection}.updated`, r.modifiedCount);
      return { matched: r.matchedCount, modified: r.modifiedCount };
    },
    /** bulkWrite that only counts operations in dry-run. */
    async bulkWrite(collection, ops) {
      if (!ops.length) return;
      if (dryRun) { count(`${collection}.wouldWrite`, ops.length); return; }
      const r = await db.collection(collection).bulkWrite(ops, { ordered: false });
      count(`${collection}.written`, (r.modifiedCount || 0) + (r.upsertedCount || 0));
    },
    /** Keeps the previous value of rows about to change, for down(). */
    async backup(collection, rows) {
      if (dryRun || !rows.length) return;
      await db.collection('_migration_backups').insertMany(rows.map((row) => ({ migration: migration.id, collection, row })));
    },
    backups: (collection) => db.collection('_migration_backups').find({ migration: migration.id, collection }).toArray()
  };
}

/**
 * @param {object} options { mongoose, uri, command: 'status'|'plan'|'up'|'down', target, allowRemote, log, dir }
 */
async function run({ mongoose, uri, connection, command = 'status', target, allowRemote = false, log = console.log, dir }) {
  if (connection) uri = uri || `mongodb://127.0.0.1/${connection.name}`; // a caller-supplied (test) connection
  if (!uri) throw new Error('A database URI is required (--uri or MIGRATE_MONGODB_URI). MONGODB_URI is deliberately not used.');
  if (!isLocalUri(uri) && !allowRemote) throw new Error('Refusing to run against a non-local database. Pass allowRemote explicitly, after a backup and approval.');
  const migrations = load(dir);
  // The default mongoose connection, so models used inside migrations hit the same database.
  const owned = !connection;
  if (owned) await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const conn = connection || mongoose.connection;
  const db = conn.db;
  const owner = `${os.hostname()}:${process.pid}:${Date.now()}`;
  const history = db.collection('_migrations');
  const result = { command, migrations: [] };
  try {
    const applied = new Map((await history.find({}).toArray()).map((r) => [r._id, r]));
    if (command === 'status') {
      for (const m of migrations) {
        const row = applied.get(m.id);
        result.migrations.push({ id: m.id, description: m.description, state: row ? row.status : 'pending', checksumChanged: Boolean(row && row.status === 'applied' && row.checksum !== m.checksum), appliedAt: row?.finishedAt });
      }
      return result;
    }
    if (!(await acquireLock(db, owner))) throw new Error('Another migration run holds the lock (it expires after 15 minutes).');
    try {
      // Everything the models load must target this connection's database.
      const models = { connection: conn };
      const dryRun = command === 'plan';
      const toRun = command === 'down'
        ? migrations.filter((m) => m.id === target)
        : migrations.filter((m) => applied.get(m.id)?.status !== 'applied' && (!target || m.id <= target));
      if (command === 'down' && !toRun.length) throw new Error(`Unknown migration ${target}`);
      for (const m of toRun) {
        const ctx = makeContext(mongoose, db, m, dryRun, log);
        ctx.models = models;
        const startedAt = new Date();
        if (command === 'down') {
          if (applied.get(m.id)?.status !== 'applied') throw new Error(`${m.id} is not applied`);
          if (typeof m.down !== 'function') throw new Error(`${m.id} is irreversible. Recovery: ${m.recovery || 'restore the pre-migration backup'}`);
          await m.down(ctx);
          await history.updateOne({ _id: m.id }, { $set: { status: 'rolled_back', rolledBackAt: new Date() } });
          result.migrations.push({ id: m.id, status: 'rolled_back', counts: ctx.counts });
          continue;
        }
        try {
          log(`${dryRun ? 'PLAN' : 'UP  '} ${m.id} — ${m.description}`);
          await m.up(ctx);
          if (!dryRun && typeof m.validate === 'function') {
            const problems = await m.validate(ctx);
            if (problems && problems.length) throw new Error(`Validation failed: ${problems.join('; ')}`);
          }
          if (!dryRun) {
            await history.updateOne({ _id: m.id }, { $set: { status: 'applied', description: m.description, checksum: m.checksum, version: Number(m.id.slice(0, 3)), startedAt, finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime(), counts: ctx.counts, host: os.hostname(), reversible: typeof m.down === 'function' }, $unset: { error: '' } }, { upsert: true });
          }
          result.migrations.push({ id: m.id, status: dryRun ? 'would_apply' : 'applied', counts: ctx.counts });
        } catch (error) {
          if (!dryRun) await history.updateOne({ _id: m.id }, { $set: { status: 'failed', description: m.description, checksum: m.checksum, startedAt, finishedAt: new Date(), error: error.message, counts: ctx.counts } }, { upsert: true });
          result.migrations.push({ id: m.id, status: 'failed', error: error.message, counts: ctx.counts });
          throw Object.assign(error, { migrationResult: result });
        }
      }
      return result;
    } finally {
      await releaseLock(db, owner);
    }
  } finally {
    if (owned) await mongoose.disconnect();
  }
}

module.exports = { run, load, isLocalUri };
