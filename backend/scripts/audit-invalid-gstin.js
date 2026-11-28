#!/usr/bin/env node
/**
 * READ-ONLY audit: lists customers, vendors and invoices whose GSTIN fails
 * format/checksum validation. It never modifies data.
 *
 *   MONGODB_URI=... node scripts/audit-invalid-gstin.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { gstinError } = require('../src/utils/gstin');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const targets = [['customers', 'gstNumber'], ['vendors', 'gstNumber']];
  let total = 0;
  for (const [coll, field] of targets) {
    const cursor = db.collection(coll).find({ [field]: { $nin: [null, ''] } }, { projection: { name: 1, [field]: 1, dataScope: 1, userId: 1 } });
    for await (const doc of cursor) {
      const message = gstinError(doc[field]);
      if (message) {
        total += 1;
        console.log(`${coll}\t${doc._id}\t${doc.name || ''}\t${doc[field]}\t${message}`);
      }
    }
  }
  console.log(`\n${total} record(s) with an invalid GSTIN. Nothing was changed.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
