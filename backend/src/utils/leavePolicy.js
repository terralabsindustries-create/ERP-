/*
  Paid and unpaid leave, and how a month's attendance and approved leave turn
  into loss-of-pay (LOP) days. Payroll generation and the attendance summary
  both use this, so they agree.

  Rules
  - Leave types are paid or unpaid:
      paid:    casual, sick, earned
      unpaid:  unpaid
      not yet decided by the business: maternity, other — see UNDECIDED below.
  - Only approved leave counts. Pending, rejected and cancelled requests are
    ignored, so cancelling a leave and generating payroll again removes its LOP.
  - A day is counted once. Approved leave decides the day and replaces the
    attendance mark for it (as the attendance screens already show): an
    "absent" or "half-day" mark under approved leave is not LOP on top of the
    leave. Two approved leaves on one day count as one day.
  - Unpaid leave is LOP: 1 per day, never more in total than the request's
    `days` (a single-day request of 0.5 days is half a day of LOP).
  - Days without approved leave keep the attendance rule: absent = 1 LOP day,
    half-day = 0.5.

  Decisions the business has to make — until it does, payroll deducts nothing
  for these days and lists them for review, rather than guessing:
  - UNDECIDED leave types (maternity, other): paid or unpaid? Maternity pay
    may come from ESI rather than the employer; "other" says nothing.
  - Unpaid leave over a day marked holiday or week-off (the "sandwich rule"):
    does the holiday become LOP too?
  - Overlapping approved leaves of different kinds on the same day.
  - A request whose `days` differs from the calendar days it spans (which
    days are the half ones).
*/

const PAID = new Set(['casual', 'sick', 'earned']);
const UNPAID = new Set(['unpaid']);
const UNDECIDED = new Set(['maternity', 'other']);

const DAY = 24 * 60 * 60 * 1000;
const dayStart = (d) => {
  const date = new Date(d);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);

/** 'paid' | 'unpaid' | 'undecided' */
// Any type not listed as paid or unpaid (maternity, other, or a new one) is undecided.
const leavePay = (leaveType) => (UNPAID.has(leaveType) ? 'unpaid' : PAID.has(leaveType) ? 'paid' : 'undecided');

/** Calendar days a leave covers, with the LOP weight each would carry if unpaid. */
function leaveDays(leave) {
  const from = dayStart(leave.fromDate);
  const to = dayStart(leave.toDate);
  const span = Math.max(1, Math.round((to - from) / DAY) + 1);
  const total = Number(leave.days) > 0 ? Number(leave.days) : span;
  const days = [];
  let left = total;
  for (let day = from, i = 0; day <= to && i < 366; day = new Date(day.getTime() + DAY), i += 1) {
    const weight = Math.max(0, Math.min(1, left));
    days.push({ day, weight });
    left = round2(left - weight);
  }
  return { days, mismatch: Math.abs(total - span) >= 0.01 };
}

/**
 * Resolves each employee's days in [start, end).
 *
 * @param attendance  [{ employeeId, date, status }]
 * @param leaves      approved leave requests [{ employeeId, leaveType, fromDate, toDate, days }]
 * @returns Map employeeId → { days: Map isoDay → { status, leaveType?, lop }, lopDays, unpaidLeaveDays, review: string[] }
 */
function resolveMonth({ attendance = [], leaves = [], start, end }) {
  const out = new Map();
  const of = (id) => {
    const key = String(id);
    if (!out.has(key)) out.set(key, { days: new Map(), marks: new Map(), leaveOn: new Map(), lopDays: 0, unpaidLeaveDays: 0, review: [] });
    return out.get(key);
  };
  const inMonth = (day) => day >= start && day < end;

  for (const a of attendance) {
    const day = dayStart(a.date);
    if (inMonth(day)) of(a.employeeId).marks.set(iso(day), a.status);
  }

  for (const leave of leaves) {
    if (leave.status && leave.status !== 'approved') continue;
    const emp = of(leave.employeeId);
    const pay = leavePay(leave.leaveType);
    const { days, mismatch } = leaveDays(leave);
    if (mismatch && pay === 'unpaid' && days.some(({ day }) => inMonth(day))) {
      emp.review.push(`Unpaid leave from ${iso(days[0].day)} is ${leave.days} day(s) over ${days.length} calendar day(s); LOP is capped at ${leave.days}.`);
    }
    for (const { day, weight } of days) {
      if (!inMonth(day)) continue;
      const key = iso(day);
      const lop = pay === 'unpaid' ? weight : 0;
      const before = emp.leaveOn.get(key);
      if (!before) {
        emp.leaveOn.set(key, { leaveType: leave.leaveType, pay, lop });
      } else {
        if (before.pay !== pay) emp.review.push(`${key}: overlapping ${before.leaveType} and ${leave.leaveType} leave; no LOP taken for the day.`);
        // Counted once; where the kinds disagree, the smaller deduction stands.
        emp.leaveOn.set(key, before.lop <= lop ? before : { leaveType: leave.leaveType, pay, lop });
      }
    }
  }

  for (const emp of out.values()) {
    const keys = new Set([...emp.marks.keys(), ...emp.leaveOn.keys()]);
    for (const key of keys) {
      const mark = emp.marks.get(key);
      const leave = emp.leaveOn.get(key);
      let entry;
      if (leave) {
        let lop = leave.lop;
        if (leave.pay === 'undecided') emp.review.push(`${key}: ${leave.leaveType} leave — paid or unpaid is not decided; no LOP taken.`);
        if (lop > 0 && (mark === 'holiday' || mark === 'week-off')) {
          emp.review.push(`${key}: unpaid leave on a ${mark}; no LOP taken for the ${mark}.`);
          lop = 0;
        }
        entry = { status: 'leave', leaveType: leave.leaveType, lop };
        if (leave.pay === 'unpaid') emp.unpaidLeaveDays = round2(emp.unpaidLeaveDays + lop);
      } else {
        entry = { status: mark, lop: mark === 'absent' ? 1 : mark === 'half-day' ? 0.5 : 0 };
      }
      emp.days.set(key, entry);
      emp.lopDays = round2(emp.lopDays + entry.lop);
    }
    delete emp.marks;
    delete emp.leaveOn;
    emp.review = [...new Set(emp.review)];
  }
  return out;
}

module.exports = { PAID, UNPAID, UNDECIDED, leavePay, resolveMonth, dayStart };
