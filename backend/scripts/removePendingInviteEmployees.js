/**
 * One-off cleanup for invitations sent before HR records were deferred.
 *
 * Invites used to create an Employee row immediately, so people who never
 * accepted still show up on the Employees page and in headcount. This removes
 * the rows whose linked login is still in the 'invited' state.
 *
 * Rows that HR has already filled in (salary, employee code, bank details) are
 * reported and left alone — deleting those would lose data that was entered by
 * hand. Deal with those manually if you want them gone.
 *
 *   node scripts/removePendingInviteEmployees.js          # dry run, shows what would go
 *   node scripts/removePendingInviteEmployees.js --apply  # actually delete
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Employee = require('../src/models/Employee');

const APPLY = process.argv.includes('--apply');

// Only fields HR must type in by hand count as "touched". employeeCode is
// auto-generated on save, dateOfJoining defaults to now, and netSalary is a
// virtual — none of them indicate that anyone actually filled the row in.
const hasHrData = (e) => {
  const salary = e.salary || {};
  const deductions = e.deductions || {};
  const bank = e.bankDetails || {};
  return !!(
    salary.basic || salary.hra || salary.allowances || salary.specialAllowance ||
    deductions.pf || deductions.professionalTax || deductions.esi || deductions.other ||
    bank.accountNumber || bank.ifscCode || bank.upiId ||
    e.panNumber || e.aadhaarNumber || e.pfNumber || e.notes
  );
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? '✍️  Applying deletions\n' : '🔍 DRY RUN — nothing will be deleted\n');

  const invitedIds = await User.find({ status: 'invited' }).distinct('_id');
  console.log(`Logins still awaiting acceptance: ${invitedIds.length}`);

  const rows = await Employee.find({ linkedUserId: { $in: invitedIds } });
  console.log(`Employee records linked to them:  ${rows.length}\n`);

  const removable = rows.filter((e) => !hasHrData(e));
  const keep = rows.filter(hasHrData);

  for (const e of removable) console.log(`  remove   ${e.name} <${e.email}>`);
  for (const e of keep) console.log(`  KEEP     ${e.name} <${e.email}> — has HR data, delete by hand if unwanted`);

  if (APPLY && removable.length) {
    const res = await Employee.deleteMany({ _id: { $in: removable.map((e) => e._id) } });
    console.log(`\n✅ Deleted ${res.deletedCount} employee record(s).`);
  } else if (!APPLY) {
    console.log(`\nRe-run with --apply to delete ${removable.length} record(s).`);
  } else {
    console.log('\nNothing to delete.');
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Cleanup failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
