const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Task = require('../models/Task');
const Job = require('../models/Job');
const ActivityLog = require('../models/ActivityLog');
const TimeEntry = require('../models/TimeEntry');
const { protect } = require('../middleware/auth');
const { orgScope, orgMemberIds, isSameOrgUser } = require('../utils/accessScope');
const { visibleTasks } = require('./tasks');
const Team = require('../models/Team');

/*
  Team workload and evaluation for the admin and managers who see all staff
  data (the gate is in app.js). Every number here is a count of real records
  in the chosen period, and GET /members/:id returns the records behind them,
  so a figure can always be checked rather than taken on trust.

  Definitions (period = the last N days, default 30):
    open           tasks assigned to the person, not completed or cancelled
    overdue        open tasks whose due date is before today. A task due today
                   is not overdue until that day ends, the same day boundary
                   the on-time rule below uses
    on hold        open tasks marked on_hold (blocked)
    due soon       open tasks due today or in the next 3 days
    completed      tasks whose completedAt falls in the period
      on time      completed on or before the end of the due date
      late         completed after the due date (avg days late is shown)
      no due date  completed tasks that had no due date, so no timeliness
    jobs handling  open jobs where the person is the assigned handler
    job updates    job stage changes the person recorded in the period
    activity       entries the person created in the activity log in the period
    time logged    minutes on Designer Timer entries for the person in the period
*/

const router = express.Router();
router.use(protect);

const OPEN_STATUSES = ['pending', 'in_progress', 'on_hold'];
const OPEN_JOB = { status: { $nin: ['completed', 'delivered', 'cancelled'] } };
const DAY = 864e5;

const periodDays = (req) => {
  const n = parseInt(req.query.days, 10);
  return [7, 30, 90].includes(n) ? n : 30;
};

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

/** On time / late / no due date, and days late, for a completed task. */
function timeliness(task) {
  if (!task.completedAt) return { result: 'unknown' };
  if (!task.dueDate) return { result: 'no_due_date' };
  const late = task.completedAt.getTime() - endOfDay(task.dueDate).getTime();
  return late > 0 ? { result: 'late', daysLate: Math.ceil(late / DAY) } : { result: 'on_time' };
}

const ids = (list) => list.map((x) => x._id || x);

// GET /api/team/overview?days=30&team=<id>
router.get('/overview', async (req, res) => {
  try {
    const days = periodDays(req);
    // Optionally only the people in one team (User Management → Teams).
    let teamMembers = null;
    if (req.query.team) {
      const team = mongoose.isValidObjectId(req.query.team)
        ? await Team.findOne({ _id: req.query.team, ...orgScope(req.user) }).select('members').lean()
        : null;
      if (!team) return res.status(404).json({ status: 'error', message: 'Team not found' });
      teamMembers = team.members;
    }
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY);
    const today = startOfDay(now);
    const isOverdue = (t) => t.dueDate && t.dueDate < today;
    // Due today or within the next n days.
    const dueWithin = (t, n) => t.dueDate && t.dueDate >= today && t.dueDate < new Date(today.getTime() + (n + 1) * DAY);

    const members = await User.find({
      ...(req.user.dataScope ? { dataScope: req.user.dataScope } : { _id: req.user._id }),
      status: { $ne: 'invited' },
      ...(teamMembers ? { _id: { $in: teamMembers } } : {})
    })
      .select('fullName role department isActive email')
      .sort({ role: 1, fullName: 1 })
      .lean();
    const memberIds = ids(members);
    const tasksScope = await visibleTasks(req.user);
    const jobScope = orgScope(req.user);

    const [tasks, completed, handling, jobMoves, activity, time, recentUpdates] = await Promise.all([
      Task.find({ $and: [tasksScope, { assignedTo: { $in: memberIds }, status: { $in: OPEN_STATUSES } }] })
        .select('title status priority dueDate assignedTo userId updatedAt notes jobTitle')
        .populate('assignedTo', 'fullName')
        .populate('userId', 'fullName')
        .lean(),
      Task.find({ $and: [tasksScope, { assignedTo: { $in: memberIds }, status: 'completed', completedAt: { $gte: since } }] })
        .select('assignedTo dueDate completedAt')
        .lean(),
      Job.aggregate([
        { $match: { ...jobScope, ...OPEN_JOB, 'assignedTo.handlerId': { $in: memberIds } } },
        { $group: { _id: '$assignedTo.handlerId', count: { $sum: 1 } } }
      ]),
      Job.aggregate([
        { $match: jobScope },
        { $unwind: '$flowHistory' },
        { $match: { 'flowHistory.updatedBy': { $in: memberIds }, 'flowHistory.enteredAt': { $gte: since } } },
        { $group: { _id: '$flowHistory.updatedBy', count: { $sum: 1 } } }
      ]),
      ActivityLog.aggregate([
        { $match: { ...orgScope(req.user), performedBy: { $in: memberIds }, createdAt: { $gte: since } } },
        { $group: { _id: '$performedBy', count: { $sum: 1 }, last: { $max: '$createdAt' } } }
      ]),
      TimeEntry.aggregate([
        { $match: { staffId: { $in: memberIds }, startTime: { $gte: since }, userId: { $in: await orgMemberIds(req.user) } } },
        { $group: { _id: '$staffId', minutes: { $sum: '$duration' } } }
      ]),
      ActivityLog.find({ ...orgScope(req.user), entityType: { $in: ['task', 'job'] }, ...(teamMembers ? { performedBy: { $in: memberIds } } : {}) })
        .sort({ createdAt: -1 })
        .limit(25)
        .select('action description entityType entityId entityName performedByName createdAt')
        .lean()
    ]);

    const byId = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r]));
    const handlingBy = byId(handling);
    const movesBy = byId(jobMoves);
    const activityBy = byId(activity);
    const timeBy = byId(time);

    const summaries = members.map((m) => {
      const id = String(m._id);
      const mine = tasks.filter((t) => String(t.assignedTo?._id || t.assignedTo) === id);
      const done = completed.filter((t) => String(t.assignedTo) === id).map(timeliness);
      const late = done.filter((d) => d.result === 'late');
      return {
        user: m,
        tasks: {
          open: mine.length,
          inProgress: mine.filter((t) => t.status === 'in_progress').length,
          onHold: mine.filter((t) => t.status === 'on_hold').length,
          overdue: mine.filter(isOverdue).length,
          dueSoon: mine.filter((t) => dueWithin(t, 3)).length,
          completed: done.length,
          onTime: done.filter((d) => d.result === 'on_time').length,
          late: late.length,
          noDueDate: done.filter((d) => d.result === 'no_due_date').length,
          avgDaysLate: late.length ? Math.round((late.reduce((s, d) => s + d.daysLate, 0) / late.length) * 10) / 10 : null
        },
        jobs: { handling: handlingBy[id]?.count || 0, stageUpdates: movesBy[id]?.count || 0 },
        activity: { count: activityBy[id]?.count || 0, lastAt: activityBy[id]?.last || null },
        timeLoggedMinutes: timeBy[id]?.minutes || 0
      };
    });

    const describeTask = (t) => ({
      _id: t._id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      jobTitle: t.jobTitle,
      notes: t.notes,
      updatedAt: t.updatedAt,
      assignee: t.assignedTo ? { _id: t.assignedTo._id, fullName: t.assignedTo.fullName } : null,
      assigner: t.userId ? { _id: t.userId._id, fullName: t.userId.fullName } : null
    });

    res.json({
      status: 'success',
      data: {
        periodDays: days,
        generatedAt: now,
        members: summaries,
        blocked: tasks.filter((t) => t.status === 'on_hold').map(describeTask),
        overdue: tasks
          .filter(isOverdue)
          .sort((a, b) => a.dueDate - b.dueDate)
          .map(describeTask),
        upcoming: tasks
          .filter((t) => dueWithin(t, 7))
          .sort((a, b) => a.dueDate - b.dueDate)
          .map(describeTask),
        recentUpdates
      }
    });
  } catch (error) {
    console.error('Team overview error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while building the team overview' });
  }
});

// GET /api/team/members/:userId?days=30 — the records behind one person's numbers
router.get('/members/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId) || !(await isSameOrgUser(req.user, userId))) {
      return res.status(404).json({ status: 'error', message: 'Team member not found' });
    }
    const days = periodDays(req);
    const since = new Date(Date.now() - days * DAY);
    const member = await User.findById(userId).select('fullName role department email isActive').lean();
    const tasksScope = await visibleTasks(req.user);

    const [tasks, jobs, activity, timeEntries] = await Promise.all([
      Task.find({
        $and: [
          tasksScope,
          { assignedTo: userId },
          { $or: [{ status: { $in: OPEN_STATUSES } }, { status: 'completed', completedAt: { $gte: since } }, { status: 'cancelled', updatedAt: { $gte: since } }] }
        ]
      })
        .select('title status priority dueDate completedAt updatedAt createdAt jobTitle userId history comments')
        .populate('userId', 'fullName')
        .sort({ dueDate: 1 })
        .lean(),
      Job.find({ ...orgScope(req.user), 'assignedTo.handlerId': userId })
        .select('title status dueDate priority updatedAt customerId')
        .populate('customerId', 'name')
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean(),
      ActivityLog.find({ ...orgScope(req.user), performedBy: userId, createdAt: { $gte: since } })
        .select('action description entityType entityName createdAt')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      TimeEntry.find({ staffId: userId, startTime: { $gte: since }, userId: { $in: await orgMemberIds(req.user) } })
        .select('jobTitle taskName startTime endTime duration status')
        .sort({ startTime: -1 })
        .limit(100)
        .lean()
    ]);

    res.json({
      status: 'success',
      data: {
        periodDays: days,
        member,
        tasks: tasks.map((t) => ({
          ...t,
          assigner: t.userId ? { _id: t.userId._id, fullName: t.userId.fullName } : null,
          userId: undefined,
          commentCount: (t.comments || []).length,
          comments: undefined,
          lastUpdate: (t.history || []).slice(-1)[0] || null,
          history: undefined,
          timeliness: t.status === 'completed' ? timeliness(t) : null
        })),
        jobs,
        activity,
        timeEntries
      }
    });
  } catch (error) {
    console.error('Team member detail error:', error);
    res.status(500).json({ status: 'error', message: 'Server error while loading the team member' });
  }
});

module.exports = router;
