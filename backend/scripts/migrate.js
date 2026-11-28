#!/usr/bin/env node
/**
 * Migration CLI.
 *   node scripts/migrate.js status --uri mongodb://127.0.0.1:27017/mydb
 *   node scripts/migrate.js plan   --uri ...        # dry run: counts only, writes nothing
 *   node scripts/migrate.js up     --uri ... [--to 003-name]
 *   node scripts/migrate.js down   --uri ... --id 003-name
 *
 * The URI comes only from --uri or MIGRATE_MONGODB_URI (never MONGODB_URI).
 * Non-local databases are refused unless --allow-remote is given; do that only
 * for a deliberate, backed-up, approved release.
 */
const mongoose = require('mongoose');
const { run } = require('../migrations/runner');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const command = process.argv[2] || 'status';
run({ mongoose, uri: arg('uri') || process.env.MIGRATE_MONGODB_URI, command, target: arg('id') || arg('to'), allowRemote: process.argv.includes('--allow-remote') })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch((e) => { console.error(`Migration failed: ${e.message}`); if (e.migrationResult) console.error(JSON.stringify(e.migrationResult, null, 2)); process.exit(1); });
