#!/usr/bin/env node
/**
 * Creates the indexes added on 27 Nov 2026 (performance audit and the credit /
 * debit note lifecycle). Non-destructive: it only CREATES indexes declared in
 * the schemas (Model.createIndexes); it never drops an index, never touches a
 * document, and is safe to run more than once.
 *
 *   MONGODB_URI=... node migrations/2026-11-27-performance-and-lifecycle-indexes.js [--dry-run]
 *
 * Mongoose also builds missing indexes when the server starts (autoIndex), so
 * this script is for running the builds deliberately, e.g. off-peak, and for
 * seeing the result. MongoDB builds indexes without blocking reads/writes
 * (4.2+), but a large collection's build uses I/O: run it outside busy hours.
 *
 * Do NOT replace this with syncIndexes(): that DROPS indexes not in the schema.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MODELS = ['Customer', 'Invoice', 'Job', 'Task', 'Notification', 'User', 'SubscriptionPurchase', 'CreditNote'];

(async () => {
  const dry = process.argv.includes('--dry-run');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  for (const name of MODELS) {
    const Model = require(`../src/models/${name}`);
    Model.schema.set('autoIndex', false);
    const declared = Model.schema.indexes().map(([fields, opts]) => ({ fields, name: opts.name }));
    const existing = await Model.collection.indexes().catch(() => []);
    const has = new Set(existing.map((i) => JSON.stringify(i.key)));
    const missing = declared.filter((d) => !has.has(JSON.stringify(d.fields)));
    console.log(`${name}: ${missing.length} missing of ${declared.length} declared`);
    for (const m of missing) console.log(`   + ${JSON.stringify(m.fields)}`);
    if (!dry && missing.length) {
      const t = Date.now();
      await Model.createIndexes();
      console.log(`   built in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
  }
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
