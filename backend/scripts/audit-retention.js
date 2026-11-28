#!/usr/bin/env node
/**
 * Controlled retention for the audit trail (the only way entries are ever removed).
 *
 *   MONGODB_URI=... node scripts/audit-retention.js            # dry run: counts only
 *   MONGODB_URI=... node scripts/audit-retention.js --execute  # actually deletes
 *
 * Ordinary entries older than AUDIT_RETENTION_DAYS (default 365) and protected
 * ones (financial, stock, permission, payroll, settings, approvals) older than
 * AUDIT_PROTECTED_RETENTION_DAYS (default 2922, about 8 years) are eligible.
 * The run itself is recorded in the `auditretentionruns` collection.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const execute = process.argv.includes('--execute');
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const ActivityLog = require('../src/models/ActivityLog');
  const result = await ActivityLog.purgeExpired({ dryRun: !execute });
  await mongoose.connection.collection('auditretentionruns').insertOne({ at: new Date(), ...result });
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
