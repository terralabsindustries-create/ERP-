/**
 * One-off backfill: create Employee rows for login accounts that predate the
 * automatic user -> employee sync.
 *
 * Safe to re-run — syncEmployeeForUser adopts an existing employee (by link, or
 * by matching email within the tenant) instead of creating a duplicate.
 *
 * Usage:
 *   node scripts/backfillEmployeesFromUsers.js          # apply
 *   node scripts/backfillEmployeesFromUsers.js --dry    # preview only
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Employee = require('../src/models/Employee');
const { syncEmployeeForUser } = require('../src/utils/employeeSync');

const DRY_RUN = process.argv.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(DRY_RUN ? '🔍 DRY RUN — no writes\n' : '✍️  Applying changes\n');

  const users = await User.find({}).sort({ createdAt: 1 });
  let created = 0;
  let adopted = 0;
  let skipped = 0;

  for (const user of users) {
    const existing = await Employee.findOne({ linkedUserId: user._id });
    if (existing) {
      skipped++;
      continue;
    }

    // The tenant owner is whoever shares this dataScope and is an admin; fall
    // back to the user themselves so a lone admin still gets a row.
    const owner = user.dataScope
      ? (await User.findOne({ dataScope: user.dataScope, role: 'admin' }).sort({ createdAt: 1 })) || user
      : user;

    const byEmail = user.email
      ? await Employee.findOne({
          email: String(user.email).toLowerCase(),
          linkedUserId: { $in: [null, undefined] },
          ...(user.dataScope ? { dataScope: user.dataScope } : { userId: owner._id })
        })
      : null;

    const action = byEmail ? 'adopt existing' : 'create';
    console.log(`  ${action.padEnd(15)} ${user.role.padEnd(11)} ${user.fullName} <${user.email}>`);

    if (!DRY_RUN) await syncEmployeeForUser(user, owner);
    if (byEmail) adopted++; else created++;
  }

  console.log(`\nTotal logins: ${users.length}`);
  console.log(`  created:        ${created}`);
  console.log(`  adopted:        ${adopted}`);
  console.log(`  already linked: ${skipped}`);

  await mongoose.disconnect();
})().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
