const express = require('express');
const mongoose = require('mongoose');
const { body, query, param } = require('express-validator');
const TimeEntry = require('../models/TimeEntry');
const Job = require('../models/Job');
const Task = require('../models/Task');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { isOrgViewer, orgMemberIds, orgScope } = require('../utils/accessScope');
const { visibleTasks } = require('./tasks');

/*
  Design time: the time each person spends on jobs, from a live timer or added
  by hand. Mounted behind the "Designer Timer" guard in app.js (read:
  Designer Timer or Staff & Tasks; write: Designer Timer: Track Time).

  Who sees what
    staff         only their own entries; the rest answer 404
    team viewers  the admin and logins with "Can view all staff data" see,
                  edit, stop and delete every entry in the business
  A timer is always the caller's own: starting, pausing and resuming act on
  the caller's timer only. Each person has at most one running or paused
  timer; starting another stops (completes) the previous one.
*/

const router = express.Router();

const MINUTE = 60000;
const DAY_MINUTES = 24 * 60;
const ACTIVE = TimeEntry.ACTIVE_STATUSES;

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const ok = (res, data, code = 200, message) => res.status(code).json({ status: 'success', ...(message ? { message } : {}), data });
const fail = (res, code, message) => res.status(code).json({ status: 'error', message });

/** The entries this login may see and change. */
async function entryScope(user) {
  if (isOrgViewer(user)) return { userId: { $in: await orgMemberIds(user) } };
  return { staffId: user._id };
}

async function findInScope(user, id) {
  return TimeEntry.findOne({ $and: [{ _id: id }, await entryScope(user)] });
}

/** The caller's running or paused timer, if any. */
const findOwnActive = (user) => TimeEntry.findOne({ staffId: user._id, status: { $in: ACTIVE } });

const describeEntry = (e) => [e.taskName, e.jobTitle].filter(Boolean).join(' · ');

function log(req, entry, action, actionType, extra = {}) {
  ActivityLog.logActivity({
    action,
    description: `${action}: ${describeEntry(entry)} (${entry.staffName})`,
    entityType: 'time_entry',
    entityId: entry._id,
    entityName: describeEntry(entry),
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity: actionType === 'delete' ? 'medium' : 'low',
    userId: req.user._id,
    dataScope: req.user.dataScope,
    ...extra
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));
}

/**
 * Looks up the job and the optional task inside the caller's business and
 * returns the fields to store, or an error to answer with.
 */
async function resolveWork(user, { jobId, taskId, description }) {
  const job = await Job.findOne({ _id: jobId, ...orgScope(user) }).select('title').lean();
  if (!job) return { error: [404, 'Job not found'] };

  let task = null;
  if (taskId) {
    task = await Task.findOne({ $and: [{ _id: taskId }, await visibleTasks(user)] }).select('title jobId').lean();
    if (!task) return { error: [404, 'Task not found'] };
    if (task.jobId && String(task.jobId) !== String(job._id)) {
      return { error: [400, 'That task belongs to another job'] };
    }
  }

  return {
    fields: {
      jobId: job._id,
      jobTitle: job.title,
      taskId: task ? task._id : null,
      taskName: workName(task, description)
    }
  };
}

const workName = (task, description) => (task ? task.title : (description || '').trim().slice(0, 200) || 'Design work');

/** Completes a running or paused timer. A timer stopped while paused ends where the pause began. */
function stopEntry(entry, at = new Date()) {
  const open = entry.breaks.find((b) => !b.endTime);
  if (open) {
    entry.endTime = open.startTime < entry.startTime ? entry.startTime : open.startTime;
    entry.breaks = entry.breaks.filter((b) => b.endTime);
  } else {
    entry.endTime = at;
  }
  entry.status = 'completed';
  return entry;
}

/** Count and minutes (all and billable) for the entries matching `filter`, running timers counted up to now. */
async function totalsFor(filter, at = new Date()) {
  const [done] = await TimeEntry.aggregate([
    { $match: { $and: [filter, { status: 'completed' }] } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        minutes: { $sum: '$duration' },
        billableMinutes: { $sum: { $cond: [{ $eq: ['$billable', true] }, '$duration', 0] } }
      }
    }
  ]);
  const open = await TimeEntry.find({ $and: [filter, { status: { $in: ACTIVE } }] });
  const live = open.reduce(
    (t, e) => {
      const m = e.minutesSoFar(at);
      return { minutes: t.minutes + m, billableMinutes: t.billableMinutes + (e.billable ? m : 0) };
    },
    { minutes: 0, billableMinutes: 0 }
  );
  return {
    count: (done?.count || 0) + open.length,
    minutes: (done?.minutes || 0) + live.minutes,
    billableMinutes: (done?.billableMinutes || 0) + live.billableMinutes
  };
}

const withLive = (entry, at = new Date()) => ({ ...entry.toObject(), minutesSoFar: entry.minutesSoFar(at) });


// ---------------------------------------------------------------- validators

const idParam = [param('id').isMongoId().withMessage('Time entry not found')];

const workRules = (required) => [
  (required ? body('jobId').exists({ values: 'falsy' }).withMessage('Choose a job').bail() : body('jobId').optional({ values: 'falsy' }))
    .isMongoId().withMessage('Choose a job'),
  body('taskId').optional({ values: 'null' }).custom((v) => v === '' || mongoose.isValidObjectId(v)).withMessage('Choose a task from the list'),
  body('description').optional({ values: 'null' }).isString().withMessage('Description must be text').trim()
    .isLength({ max: 500 }).withMessage('Keep the description under 500 characters'),
  body('billable').optional().isBoolean().withMessage('Billable must be yes or no').toBoolean()
];

const timeRules = [
  body('startTime').optional().isISO8601().withMessage('Enter a valid start time'),
  body('endTime').optional({ values: 'null' }).custom((v) => v === '' || !Number.isNaN(Date.parse(v))).withMessage('Enter a valid end time'),
  body('duration').optional({ values: 'null' }).isInt({ min: 1, max: DAY_MINUTES }).withMessage('Duration must be between 1 minute and 24 hours').toInt()
];

/** Start, end and duration of a manual entry (or an edit of one) make sense together. */
function checkTimes({ startTime, endTime, duration }, res) {
  const start = new Date(startTime);
  if (start.getTime() > Date.now() + 5 * MINUTE) return fail(res, 400, 'The start time is in the future');
  if (endTime) {
    const end = new Date(endTime);
    if (end <= start) return fail(res, 400, 'The end time must be after the start time');
    if (end.getTime() > Date.now() + 5 * MINUTE) return fail(res, 400, 'The end time is in the future');
    if (end - start > DAY_MINUTES * MINUTE) return fail(res, 400, 'One entry can cover at most 24 hours');
  } else if (!duration) {
    return fail(res, 400, 'Enter the end time or how long it took');
  }
  return null;
}

// ---------------------------------------------------------------- reads

// GET /api/time-entries?from&to&jobId&staffId&status&billable&search&page&limit
// `from` is inclusive and `to` exclusive (send the start of the next day).
router.get('/', protect, [
  query('from').optional().isISO8601().withMessage('Invalid from date'),
  query('to').optional().isISO8601().withMessage('Invalid to date'),
  query('jobId').optional().isMongoId().withMessage('Invalid job'),
  query('staffId').optional().isMongoId().withMessage('Invalid person'),
  query('status').optional().isIn([...TimeEntry.STATUSES, 'open']).withMessage('Invalid status'),
  query('billable').optional().isIn(['true', 'false']).withMessage('Invalid billable filter'),
  query('search').optional().isString().trim().isLength({ max: 100 }),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
], validate, async (req, res) => {
  try {
    const { from, to, jobId, staffId, status, billable, search } = req.query;
    const page = req.query.page || 1;
    const limit = req.query.limit || 50;

    const filters = {};
    if (from || to) {
      filters.startTime = {};
      if (from) filters.startTime.$gte = new Date(from);
      if (to) filters.startTime.$lt = new Date(to);
    }
    if (jobId) filters.jobId = oid(jobId);
    if (staffId) filters.staffId = oid(staffId);
    if (status === 'open') filters.status = { $in: ACTIVE };
    else if (status) filters.status = status;
    if (billable) filters.billable = billable === 'true';
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filters.$or = [{ description: rx }, { jobTitle: rx }, { taskName: rx }, { staffName: rx }];
    }
    const match = { $and: [await entryScope(req.user), filters] };
    const now = new Date();

    const [entries, total, totals] = await Promise.all([
      TimeEntry.find(match).sort({ startTime: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
      TimeEntry.countDocuments(match),
      totalsFor(match, now)
    ]);

    ok(res, {
      timeEntries: entries.map((e) => withLive(e, now)),
      pagination: { current: page, pages: Math.max(1, Math.ceil(total / limit)), total },
      totals,
      serverTime: now
    });
  } catch (error) {
    console.error('Get time entries error:', error);
    fail(res, 500, 'Server error while fetching time entries');
  }
});

// GET /api/time-entries/active — the caller's own running or paused timer
router.get('/active', protect, async (req, res) => {
  try {
    const now = new Date();
    const entry = await findOwnActive(req.user);
    ok(res, { activeTimer: entry ? withLive(entry, now) : null, serverTime: now });
  } catch (error) {
    console.error('Get active timer error:', error);
    fail(res, 500, 'Server error while fetching the timer');
  }
});

// GET /api/time-entries/people — who the person filter can show
router.get('/people', protect, async (req, res) => {
  try {
    const canSeeTeam = isOrgViewer(req.user);
    const people = canSeeTeam
      ? await User.find({ _id: { $in: await orgMemberIds(req.user) }, status: { $ne: 'invited' } }).select('fullName role').sort({ fullName: 1 }).lean()
      : [{ _id: req.user._id, fullName: req.user.fullName, role: req.user.role }];
    ok(res, { people, canSeeTeam });
  } catch (error) {
    console.error('Get time entry people error:', error);
    fail(res, 500, 'Server error while fetching people');
  }
});

// GET /api/time-entries/stats/summary?dayStart&weekStart
// The caller's own today / this week, and for team viewers the team's and who
// is on the clock. Send the browser's local start of day and of week so the
// figures follow the person's calendar, not the server's time zone.
router.get('/stats/summary', protect, [
  query('dayStart').optional().isISO8601().withMessage('Invalid dayStart'),
  query('weekStart').optional().isISO8601().withMessage('Invalid weekStart')
], validate, async (req, res) => {
  try {
    const now = new Date();
    const dayStart = req.query.dayStart ? new Date(req.query.dayStart) : new Date(new Date(now).setHours(0, 0, 0, 0));
    let weekStart = req.query.weekStart ? new Date(req.query.weekStart) : null;
    if (!weekStart) {
      weekStart = new Date(dayStart);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
    }
    const since = dayStart < weekStart ? dayStart : weekStart;

    // Mine: few enough rows in a week to add up here, running timer included.
    const myEntries = await TimeEntry.find({ staffId: req.user._id, startTime: { $gte: since } });
    const sum = (rows, pick = () => true) => rows.reduce((s, e) => s + (pick(e) ? e.minutesSoFar(now) : 0), 0);
    const today = myEntries.filter((e) => e.startTime >= dayStart);
    const week = myEntries.filter((e) => e.startTime >= weekStart);
    const byJob = {};
    week.forEach((e) => {
      const k = String(e.jobId);
      byJob[k] = byJob[k] || { jobId: e.jobId, jobTitle: e.jobTitle, minutes: 0 };
      byJob[k].minutes += e.minutesSoFar(now);
    });
    const topJob = Object.values(byJob).sort((a, b) => b.minutes - a.minutes)[0] || null;

    const me = {
      todayMinutes: sum(today),
      weekMinutes: sum(week),
      billableWeekMinutes: sum(week, (e) => e.billable),
      todayEntries: today.length,
      weekEntries: week.length,
      topJob: topJob && topJob.minutes > 0 ? topJob : null
    };

    let team = null;
    if (isOrgViewer(req.user)) {
      const scope = await entryScope(req.user);
      const [todayTotals, weekTotals, open] = await Promise.all([
        totalsFor({ $and: [scope, { startTime: { $gte: dayStart } }] }, now),
        totalsFor({ $and: [scope, { startTime: { $gte: weekStart } }] }, now),
        TimeEntry.find({ $and: [scope, { status: { $in: ACTIVE } }] }).sort({ startTime: 1 })
      ]);
      team = {
        todayMinutes: todayTotals.minutes,
        weekMinutes: weekTotals.minutes,
        billableWeekMinutes: weekTotals.billableMinutes,
        onClock: open.map((e) => ({
          _id: e._id,
          staffId: e.staffId,
          staffName: e.staffName,
          status: e.status,
          jobTitle: e.jobTitle,
          taskName: e.taskName,
          startTime: e.startTime,
          minutesSoFar: e.minutesSoFar(now)
        }))
      };
    }

    ok(res, { stats: { me, team, dayStart, weekStart }, serverTime: now });
  } catch (error) {
    console.error('Get time entry stats error:', error);
    fail(res, 500, 'Server error while fetching time totals');
  }
});

// GET /api/time-entries/:id
router.get('/:id', protect, idParam, validate, async (req, res) => {
  try {
    const entry = await findInScope(req.user, req.params.id);
    if (!entry) return fail(res, 404, 'Time entry not found');
    ok(res, { timeEntry: withLive(entry) });
  } catch (error) {
    console.error('Get time entry error:', error);
    fail(res, 500, 'Server error while fetching the time entry');
  }
});

// ---------------------------------------------------------------- the timer

// POST /api/time-entries/start — start the caller's timer; stops one already going
router.post('/start', protect, workRules(true), validate, async (req, res) => {
  try {
    const { jobId, taskId, description = '', billable = true } = req.body;
    const work = await resolveWork(req.user, { jobId, taskId, description });
    if (work.error) return fail(res, ...work.error);

    const now = new Date();
    let stopped = null;
    const previous = await findOwnActive(req.user);
    if (previous) {
      stopped = await stopEntry(previous, now).save();
      log(req, stopped, 'Timer stopped', 'stop');
    }

    let entry;
    try {
      entry = await TimeEntry.create({
        ...work.fields,
        description,
        billable,
        source: 'timer',
        status: 'running',
        startTime: now,
        staffId: req.user._id,
        staffName: req.user.fullName || req.user.email,
        userId: req.user._id,
        dataScope: req.user.dataScope
      });
    } catch (error) {
      if (error.code === 11000) return fail(res, 409, 'You already have a timer going. Reload the page to see it.');
      throw error;
    }
    log(req, entry, 'Timer started', 'start');

    ok(res, { timeEntry: withLive(entry, now), stopped: stopped ? withLive(stopped, now) : null, serverTime: now }, 201, 'Timer started');
  } catch (error) {
    console.error('Start timer error:', error);
    fail(res, 500, 'Server error while starting the timer');
  }
});

// POST /api/time-entries/:id/pause — the caller's own running timer
router.post('/:id/pause', protect, idParam, validate, async (req, res) => {
  try {
    const entry = await TimeEntry.findOne({ _id: req.params.id, staffId: req.user._id });
    if (!entry) return fail(res, 404, 'Time entry not found');
    if (entry.status !== 'running') return fail(res, 400, entry.status === 'paused' ? 'This timer is already paused' : 'This timer has been stopped');
    const now = new Date();
    entry.breaks.push({ startTime: now });
    entry.status = 'paused';
    await entry.save();
    ok(res, { timeEntry: withLive(entry, now), serverTime: now }, 200, 'Timer paused');
  } catch (error) {
    console.error('Pause timer error:', error);
    fail(res, 500, 'Server error while pausing the timer');
  }
});

// POST /api/time-entries/:id/resume — the caller's own paused timer
router.post(['/:id/resume', '/:id/start'], protect, idParam, validate, async (req, res) => {
  try {
    const entry = await TimeEntry.findOne({ _id: req.params.id, staffId: req.user._id });
    if (!entry) return fail(res, 404, 'Time entry not found');
    if (entry.status !== 'paused') return fail(res, 400, entry.status === 'running' ? 'This timer is already running' : 'This timer has been stopped. Start a new one.');
    const now = new Date();
    const open = entry.breaks.find((b) => !b.endTime);
    if (open) open.endTime = now;
    entry.status = 'running';
    await entry.save();
    ok(res, { timeEntry: withLive(entry, now), serverTime: now }, 200, 'Timer resumed');
  } catch (error) {
    console.error('Resume timer error:', error);
    fail(res, 500, 'Server error while resuming the timer');
  }
});

// POST /api/time-entries/:id/stop — the caller's timer, or a team member's for team viewers
router.post('/:id/stop', protect, idParam, validate, async (req, res) => {
  try {
    const entry = await findInScope(req.user, req.params.id);
    if (!entry) return fail(res, 404, 'Time entry not found');
    if (entry.status === 'completed') return fail(res, 400, 'This timer has already been stopped');
    const now = new Date();
    await stopEntry(entry, now).save();
    log(req, entry, 'Timer stopped', 'stop');
    ok(res, { timeEntry: withLive(entry, now), serverTime: now }, 200, 'Timer stopped');
  } catch (error) {
    console.error('Stop timer error:', error);
    fail(res, 500, 'Server error while stopping the timer');
  }
});

// ---------------------------------------------------------------- manual entries

// POST /api/time-entries — time already spent: start–end, or a start date and a duration
router.post('/', protect, [
  ...workRules(true),
  body('startTime').exists({ values: 'falsy' }).withMessage('Enter when you started').bail().isISO8601().withMessage('Enter a valid start time'),
  ...timeRules.slice(1)
], validate, async (req, res) => {
  try {
    const { jobId, taskId, description = '', billable = true, startTime, endTime, duration } = req.body;
    if (checkTimes({ startTime, endTime, duration }, res)) return;
    const work = await resolveWork(req.user, { jobId, taskId, description });
    if (work.error) return fail(res, ...work.error);

    const entry = await TimeEntry.create({
      ...work.fields,
      description,
      billable,
      source: 'manual',
      status: 'completed',
      startTime: new Date(startTime),
      endTime: endTime ? new Date(endTime) : null,
      duration: endTime ? 0 : duration,
      staffId: req.user._id,
      staffName: req.user.fullName || req.user.email,
      userId: req.user._id,
      dataScope: req.user.dataScope
    });
    log(req, entry, 'Time added', 'create', { changes: { minutes: entry.duration } });

    ok(res, { timeEntry: withLive(entry) }, 201, 'Time added');
  } catch (error) {
    if (error.name === 'ValidationError') return fail(res, 400, Object.values(error.errors)[0].message);
    console.error('Create time entry error:', error);
    fail(res, 500, 'Server error while adding time');
  }
});

// PUT /api/time-entries/:id — edit the work, and for stopped entries the times
router.put('/:id', protect, idParam, [...workRules(false), ...timeRules], validate, async (req, res) => {
  try {
    const entry = await findInScope(req.user, req.params.id);
    if (!entry) return fail(res, 404, 'Time entry not found');
    const { jobId, taskId, description, billable, startTime, endTime, duration } = req.body;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

    if (has('description')) entry.description = description || '';
    if (has('billable')) entry.billable = billable;

    if (has('jobId') || has('taskId')) {
      const work = await resolveWork(req.user, {
        jobId: jobId || entry.jobId,
        taskId: has('taskId') ? taskId || null : entry.taskId,
        description: entry.description
      });
      if (work.error) return fail(res, ...work.error);
      Object.assign(entry, work.fields);
    } else if (has('description') && !entry.taskId) {
      entry.taskName = workName(null, entry.description);
    }

    if (has('startTime') || has('endTime') || has('duration')) {
      if (entry.status !== 'completed') {
        if (has('endTime') || has('duration')) return fail(res, 400, 'Stop the timer before changing when it ended');
        const start = new Date(startTime);
        const firstPause = entry.breaks[0]?.startTime;
        if (start > new Date()) return fail(res, 400, 'The start time is in the future');
        if (firstPause && start > firstPause) return fail(res, 400, 'The start time must be before the first pause');
        entry.startTime = start;
      } else {
        const next = {
          startTime: has('startTime') ? startTime : entry.startTime,
          endTime: has('endTime') ? endTime || null : entry.endTime,
          duration: has('duration') ? duration : entry.duration
        };
        if (checkTimes(next, res)) return;
        entry.startTime = new Date(next.startTime);
        entry.endTime = next.endTime ? new Date(next.endTime) : null;
        if (!entry.endTime) entry.duration = next.duration;
      }
    }

    await entry.save();
    log(req, entry, 'Time entry updated', 'update', { changes: { fields: Object.keys(req.body) } });
    ok(res, { timeEntry: withLive(entry) }, 200, 'Time entry updated');
  } catch (error) {
    if (error.name === 'ValidationError') return fail(res, 400, Object.values(error.errors)[0].message);
    console.error('Update time entry error:', error);
    fail(res, 500, 'Server error while updating the time entry');
  }
});

// DELETE /api/time-entries/:id
router.delete('/:id', protect, idParam, validate, async (req, res) => {
  try {
    const entry = await findInScope(req.user, req.params.id);
    if (!entry) return fail(res, 404, 'Time entry not found');
    await entry.deleteOne();
    log(req, entry, 'Time entry deleted', 'delete', { changes: { minutes: entry.minutesSoFar() } });
    ok(res, { id: entry._id }, 200, 'Time entry deleted');
  } catch (error) {
    console.error('Delete time entry error:', error);
    fail(res, 500, 'Server error while deleting the time entry');
  }
});

module.exports = router;
