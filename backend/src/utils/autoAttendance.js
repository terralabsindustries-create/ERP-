/**
 * Attendance from logins.
 *
 * The first time a team member signs in on a day (a password login, or opening
 * the app with a session that is still valid), their Employee row is marked
 * Present for that day with the check-in time. Signing out records the
 * check-out time and the hours in between.
 *
 * It only ever fills a gap: a day HR has already marked (any status) is left
 * as it is, as is a day covered by approved leave. Nobody is marked absent for
 * not signing in — payroll counts unmarked days as paid, and HR still marks
 * those days on the Attendance page.
 *
 * Days and times are those of the business's clock (BUSINESS_TIMEZONE,
 * Asia/Kolkata by default), stored the way the Attendance page stores them: the
 * calendar day as 00:00 UTC and the time as "HH:MM".
 */

const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const LeaveRequest = require('../models/LeaveRequest');

const TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';

/** The calendar day and the "HH:MM" time of `now` on the business's clock. */
function businessClock(now = new Date(), timeZone = TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return {
    day: new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))),
    time: `${parts.hour}:${parts.minute}`
  };
}

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Hours from check-in to check-out, both "HH:MM" on the same day. */
function hoursBetween(checkIn, checkOut) {
  const a = minutesOf(checkIn);
  const b = minutesOf(checkOut);
  if (a === null || b === null || b <= a) return 0;
  return Math.round(((b - a) / 60) * 100) / 100;
}

/** The active Employee row linked to this login, inside its own business. */
function employeeFor(user) {
  const filter = { linkedUserId: user._id, status: 'active' };
  if (user.dataScope) filter.dataScope = user.dataScope;
  return Employee.findOne(filter).select('_id userId dataScope').lean();
}

// Logins already handled today in this process, so opening the app again
// does not query the database again. Keyed by user, holding the day.
const handled = new Map();
const dayKey = (day) => day.toISOString().slice(0, 10);

/**
 * Marks the login's employee Present for today if nothing is recorded yet.
 * Never throws: attendance must not get in the way of signing in.
 *
 * @returns {Promise<'marked'|'exists'|'leave'|'no-employee'|'skipped'|'error'>}
 */
async function markPresentOnLogin(user, now = new Date()) {
  try {
    if (!user || !user._id || user.isActive === false || user.status === 'invited') return 'skipped';
    const { day, time } = businessClock(now);
    const key = String(user._id);
    if (handled.get(key) === dayKey(day)) return 'exists';

    const employee = await employeeFor(user);
    if (!employee) {
      handled.set(key, dayKey(day));
      return 'no-employee';
    }

    const onLeave = await LeaveRequest.exists({
      employeeId: employee._id,
      status: 'approved',
      fromDate: { $lt: new Date(day.getTime() + 864e5) },
      toDate: { $gte: day }
    });
    if (onLeave) {
      handled.set(key, dayKey(day));
      return 'leave';
    }

    // An upsert that only inserts: a mark HR already saved is never changed,
    // and two sign-ins at the same moment still make one record (unique
    // employee + day index).
    const result = await Attendance.updateOne(
      { employeeId: employee._id, date: day },
      {
        $setOnInsert: {
          employeeId: employee._id,
          date: day,
          status: 'present',
          checkIn: time,
          source: 'login',
          notes: 'Marked present at sign-in',
          createdBy: user._id,
          userId: employee.userId,
          ...(employee.dataScope ? { dataScope: employee.dataScope } : {})
        }
      },
      { upsert: true }
    );
    handled.set(key, dayKey(day));
    return result.upsertedCount ? 'marked' : 'exists';
  } catch (error) {
    if (error && error.code === 11000) return 'exists';
    console.error('Attendance at sign-in failed:', error.message);
    return 'error';
  }
}

/**
 * Records the check-out time on today's record of a login that checked in,
 * with the hours worked. The last sign-out of the day is the one that counts.
 * Never throws.
 */
async function markCheckOutOnLogout(user, now = new Date()) {
  try {
    if (!user || !user._id) return 'skipped';
    const { day, time } = businessClock(now);
    const employee = await employeeFor(user);
    if (!employee) return 'no-employee';

    const record = await Attendance.findOne({
      employeeId: employee._id,
      date: day,
      status: { $in: ['present', 'half-day'] },
      checkIn: { $exists: true, $nin: [null, ''] }
    }).select('checkIn');
    if (!record) return 'no-record';

    await Attendance.updateOne(
      { _id: record._id },
      { $set: { checkOut: time, workHours: hoursBetween(record.checkIn, time) } }
    );
    return 'checked-out';
  } catch (error) {
    console.error('Attendance at sign-out failed:', error.message);
    return 'error';
  }
}

/** Forget the per-process memo (tests). */
const resetMemo = () => handled.clear();

module.exports = { markPresentOnLogin, markCheckOutOnLogout, businessClock, hoursBetween, resetMemo };
