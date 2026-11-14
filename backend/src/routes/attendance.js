const express = require('express');
const Attendance = require('../models/Attendance');
const Employee = require('../models/Employee');
const LeaveRequest = require('../models/LeaveRequest');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

function scopeFilter(req, extra = {}) {
  const base = req.user.dataScope
    ? { dataScope: req.user.dataScope }
    : { userId: req.user._id };
  return { ...base, ...extra };
}

// Normalize any date to 00:00:00 (UTC) for that calendar day
function normalizeDay(d) {
  const date = new Date(d);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const nextDay = (day) => new Date(day.getTime() + 24 * 60 * 60 * 1000);

async function approvedLeaveIds(req, day) {
  const leaves = await LeaveRequest.find(scopeFilter(req, {
    status: 'approved',
    fromDate: { $lt: nextDay(day) },
    toDate: { $gte: day }
  })).select('employeeId').lean();
  return [...new Set(leaves.map((leave) => String(leave.employeeId)))];
}

function ownership(req) {
  const own = { createdBy: req.user._id, userId: req.user._id };
  if (req.user.dataScope) own.dataScope = req.user.dataScope;
  return own;
}

// GET /api/hr/attendance?date=YYYY-MM-DD or ?month=&year= or ?employeeId=
router.get('/', async (req, res) => {
  try {
    const { date, month, year, employeeId } = req.query;
    const filter = scopeFilter(req);
    if (employeeId) filter.employeeId = employeeId;

    if (date) {
      filter.date = normalizeDay(date);
    } else if (month && year) {
      const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
      const end = new Date(Date.UTC(Number(year), Number(month), 1));
      filter.date = { $gte: start, $lt: end };
    }

    const records = await Attendance.find(filter)
      .populate('employeeId', 'name employeeCode designation department')
      .sort({ date: -1 });

    const approvedLeaveEmployeeIds = date ? await approvedLeaveIds(req, normalizeDay(date)) : [];
    const onLeave = new Set(approvedLeaveEmployeeIds);
    const attendance = records.map((record) => {
      const row = record.toObject();
      return onLeave.has(String(record.employeeId?._id || record.employeeId)) ? { ...row, status: 'leave' } : row;
    });
    const recordedIds = new Set(records.map((record) => String(record.employeeId?._id || record.employeeId)));
    for (const employeeId of approvedLeaveEmployeeIds) {
      if (!recordedIds.has(employeeId)) attendance.push({ employeeId, date: normalizeDay(date), status: 'leave', fromApprovedLeave: true });
    }
    res.json({ status: 'success', data: { attendance, approvedLeaveEmployeeIds } });
  } catch (error) {
    console.error('List attendance error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while fetching attendance' });
  }
});

// GET /api/hr/attendance/summary?month=&year= - paid-day summary per employee
router.get('/summary', async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!month || !year) {
      return res.status(400).json({ status: 'error', message: 'month and year are required' });
    }
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    const [records, leaves] = await Promise.all([
      Attendance.find(scopeFilter(req, { date: { $gte: start, $lt: end } })),
      LeaveRequest.find(scopeFilter(req, {
        status: 'approved', fromDate: { $lt: end }, toDate: { $gte: start }
      })).select('employeeId fromDate toDate').lean()
    ]);

    // Approved leave overrides an old mark and also counts when nobody has
    // saved attendance for that day yet.
    const days = new Map(records.map((r) => [`${r.employeeId}:${normalizeDay(r.date).toISOString()}`, { employeeId: r.employeeId, status: r.status }]));
    for (const leave of leaves) {
      for (let day = new Date(Math.max(start.getTime(), normalizeDay(leave.fromDate).getTime())); day < end && day <= normalizeDay(leave.toDate); day = nextDay(day)) {
        days.set(`${leave.employeeId}:${day.toISOString()}`, { employeeId: leave.employeeId, status: 'leave' });
      }
    }

    const byEmployee = {};
    for (const r of days.values()) {
      const id = String(r.employeeId);
      if (!byEmployee[id]) {
        byEmployee[id] = { present: 0, absent: 0, halfDay: 0, leave: 0, holiday: 0, weekOff: 0, paidDays: 0 };
      }
      const b = byEmployee[id];
      if (r.status === 'present') b.present++;
      else if (r.status === 'absent') b.absent++;
      else if (r.status === 'half-day') b.halfDay++;
      else if (r.status === 'leave') b.leave++;
      else if (r.status === 'holiday') b.holiday++;
      else if (r.status === 'week-off') b.weekOff++;
      b.paidDays += Attendance.paidWeight(r.status);
    }

    res.json({ status: 'success', data: { summary: byEmployee } });
  } catch (error) {
    console.error('Attendance summary error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building attendance summary' });
  }
});

// POST /api/hr/attendance - upsert a single attendance record
router.post('/', async (req, res) => {
  try {
    const { employeeId, date, status, checkIn, checkOut, workHours, overtimeHours, notes } = req.body;
    if (!employeeId || !date) {
      return res.status(400).json({ status: 'error', message: 'employeeId and date are required' });
    }

    const day = normalizeDay(date);
    if ((await approvedLeaveIds(req, day)).includes(String(employeeId))) {
      return res.status(409).json({ status: 'error', message: 'This employee has approved leave for this day. Change the leave request first.' });
    }
    const record = await Attendance.findOneAndUpdate(
      scopeFilter(req, { employeeId, date: day }),
      {
        $set: { status: status || 'present', checkIn, checkOut, workHours, overtimeHours, notes },
        $setOnInsert: { employeeId, date: day, ...ownership(req) }
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ status: 'success', message: 'Attendance saved', data: { attendance: record } });
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving attendance', error: error.message });
  }
});

// POST /api/hr/attendance/bulk - mark attendance for many employees on one date
// body: { date, records: [{ employeeId, status }] }
router.post('/bulk', async (req, res) => {
  try {
    const { date, records } = req.body;
    if (!date || !Array.isArray(records)) {
      return res.status(400).json({ status: 'error', message: 'date and records[] are required' });
    }
    const day = normalizeDay(date);
    const own = ownership(req);
    const onLeave = new Set(await approvedLeaveIds(req, day));
    if (records.some((r) => onLeave.has(String(r.employeeId)) && r.status !== 'leave')) {
      return res.status(409).json({ status: 'error', message: 'An employee has approved leave for this day. Change the leave request first.' });
    }

    // Leave is derived from the approved request. Do not persist a duplicate
    // mark that would remain after the request is cancelled.
    const ops = records.filter((r) => !onLeave.has(String(r.employeeId))).map(r => ({
      updateOne: {
        filter: { ...scopeFilter(req), employeeId: r.employeeId, date: day },
        update: {
          $set: { status: r.status || 'present', notes: r.notes },
          $setOnInsert: { employeeId: r.employeeId, date: day, ...own }
        },
        upsert: true
      }
    }));

    if (ops.length) await Attendance.bulkWrite(ops);

    res.json({ status: 'success', message: `Attendance saved for ${ops.length} employees` });
  } catch (error) {
    console.error('Bulk attendance error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while saving bulk attendance', error: error.message });
  }
});

// DELETE /api/hr/attendance/:id
router.delete('/:id', async (req, res) => {
  try {
    const record = await Attendance.findOneAndDelete(scopeFilter(req, { _id: req.params.id }));
    if (!record) return res.status(404).json({ status: 'error', message: 'Attendance record not found' });
    res.json({ status: 'success', message: 'Attendance deleted' });
  } catch (error) {
    console.error('Delete attendance error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while deleting attendance' });
  }
});

module.exports = router;
