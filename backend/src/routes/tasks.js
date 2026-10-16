const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/User');
const Job = require('../models/Job');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { userCan } = require('../middleware/requirePermission');
const { isOrgViewer, orgMemberIds, orgScope, isSameOrgUser } = require('../utils/accessScope');
const { notify } = require('../utils/notify');
const { body, query, param, validationResult } = require('express-validator');

/*
  Who can do what with a task
  ---------------------------
  Team lead   the admin, or a login with Staff & Tasks and "Can view all staff
              data". Sees and manages every task in the business.
  Assigner    whoever created the task (needs Staff & Tasks: Assign Tasks to
              create one). Manages the tasks they created.
  Assignee    the person doing the work. Sees their tasks and may change the
              status, progress and time, and comment. Cannot edit, reassign or
              delete.
  Everyone else gets a 404, as if the task did not exist.
*/

// Apply auth middleware to all routes
router.use(protect);

const isTeamLead = (user) => user.role === 'admin' || (isOrgViewer(user) && userCan(user, 'Staff & Tasks'));
const sameId = (a, b) => !!a && !!b && String(a._id || a) === String(b._id || b);
const isAssigner = (user, task) => sameId(task.userId, user);
const isAssignee = (user, task) => sameId(task.assignedTo, user);

/** Filter for the tasks this login may see. */
async function visibleTasks(user) {
  if (isTeamLead(user)) {
    const members = await orgMemberIds(user);
    return user.dataScope
      ? { $or: [{ dataScope: user.dataScope }, { userId: { $in: members } }] }
      : { userId: user._id };
  }
  return { $or: [{ assignedTo: user._id }, { userId: user._id }] };
}

/** One task the login may see, or null. */
async function findVisibleTask(user, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Task.findOne({ $and: [{ _id: id }, await visibleTasks(user)] });
}

const canManage = (user, task) => isTeamLead(user) || isAssigner(user, task);
const canWorkOn = (user, task) => canManage(user, task) || isAssignee(user, task);

const historyEntry = (user, type, extra = {}) => ({ type, by: user._id, byName: user.fullName, at: new Date(), ...extra });

// A task is overdue once its due day has ended (same rule as the team overview).
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const populateTask = (q) =>
  q.populate('assignedTo', 'fullName email role department')
    .populate('userId', 'fullName role')
    .populate('jobId', 'title status')
    .populate('parentTask', 'title status')
    .populate('comments.author', 'fullName email');

const notFound = (res) => res.status(404).json({ success: false, message: 'Task not found' });
const forbidden = (res, message) => res.status(403).json({ success: false, message, code: 'PERMISSION_DENIED' });

const rejectInvalid = (req, res) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
  return true;
};

const logTask = (req, task, action, actionType, description, severity = 'low', extra = {}) =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'task',
    entityId: task._id,
    entityName: task.title,
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    userId: req.user._id,
    dataScope: req.user.dataScope,
    ...extra
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

const taskLink = (task) => `/tasks/${task._id}`;

// Validation middleware
const taskValidation = [
  body('title').notEmpty().withMessage('Task title is required'),
  body('assignedTo').isMongoId().withMessage('Valid staff assignment is required'),
  body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Invalid priority'),
  body('status').optional().isIn(['pending', 'in_progress', 'completed', 'cancelled', 'on_hold']).withMessage('Invalid status'),
  body('progress').optional().isInt({ min: 0, max: 100 }).withMessage('Progress must be between 0 and 100'),
  body('estimatedHours').optional().isFloat({ min: 0 }).withMessage('Estimated hours must be positive'),
  body('actualHours').optional().isFloat({ min: 0 }).withMessage('Actual hours must be positive')
];

// Fields a create/edit request may set. Ownership, business, comments and
// history are maintained by the server.
const EDITABLE = ['title', 'description', 'priority', 'status', 'assignedTo', 'jobId', 'dueDate', 'startDate', 'estimatedHours', 'actualHours', 'progress', 'tags', 'notes'];
const pickEditable = (src) => Object.fromEntries(EDITABLE.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));

/** The assignee must be an active login in the same business. */
async function validAssignee(user, assigneeId) {
  if (!(await isSameOrgUser(user, assigneeId))) return null;
  return User.findOne({ _id: assigneeId, isActive: true }).select('fullName');
}

/** An optional job must belong to the same business. */
async function validJob(user, jobId) {
  if (!jobId) return { ok: true, job: null };
  const job = await Job.findOne({ _id: jobId, ...orgScope(user) }).select('title');
  return { ok: !!job, job };
}

// GET /api/tasks - Get all tasks with advanced filtering
router.get('/', [
  query('status').optional().isIn(['pending', 'in_progress', 'completed', 'cancelled', 'on_hold', 'all']),
  query('priority').optional().isIn(['low', 'medium', 'high', 'urgent', 'all']),
  query('assignedTo').optional().isMongoId(),
  query('jobId').optional().isMongoId(),
  query('search').optional().isString(),
  query('overdue').optional().isBoolean(),
  query('dueFrom').optional().isISO8601(),
  query('dueTo').optional().isISO8601(),
  query('sortBy').optional().isIn(['createdAt', 'dueDate', 'priority', 'status', 'title', 'updatedAt']),
  query('sortOrder').optional().isIn(['asc', 'desc'])
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const {
      status,
      priority,
      assignedTo,
      jobId,
      search,
      overdue,
      dueFrom,
      dueTo,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      limit = 20
    } = req.query;

    const filters = {};
    if (status && status !== 'all') filters.status = status;
    if (priority && priority !== 'all') filters.priority = priority;
    if (assignedTo && assignedTo !== 'all') filters.assignedTo = assignedTo;
    if (jobId && jobId !== 'all') filters.jobId = jobId;
    if (overdue === 'true') {
      filters.dueDate = { $lt: startOfToday() };
      filters.status = { $nin: ['completed', 'cancelled'] };
    }
    // Due dates inside a window, e.g. the month the calendar shows.
    if (dueFrom || dueTo) {
      filters.dueDate = { ...(filters.dueDate || {}) };
      if (dueFrom) filters.dueDate.$gte = new Date(dueFrom);
      if (dueTo) filters.dueDate.$lte = new Date(dueTo);
    }
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filters.$or = [{ title: rx }, { description: rx }, { jobTitle: rx }, { tags: { $in: [rx] } }];
    }

    const query = { $and: [await visibleTasks(req.user), filters] };
    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
    const pageSize = Math.min(parseInt(limit) || 20, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * pageSize;

    const [tasks, totalTasks] = await Promise.all([
      populateTask(Task.find(query)).sort(sortOptions).skip(skip).limit(pageSize),
      Task.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: tasks,
      pagination: {
        current: parseInt(page) || 1,
        pages: Math.ceil(totalTasks / pageSize),
        total: totalTasks
      }
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
});

// GET /api/tasks/analytics - Task analytics over the tasks this login may see
router.get('/analytics', async (req, res) => {
  try {
    const match = await visibleTasks(req.user);
    const today = startOfToday();

    const [summary, priorityDistribution, statusDistribution, staffWorkload] = await Promise.all([
      Task.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalTasks: { $sum: 1 },
            completedTasks: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            overdueTasks: {
              $sum: {
                $cond: [
                  { $and: [{ $not: [{ $in: ['$status', ['completed', 'cancelled']] }] }, { $lt: ['$dueDate', today] }, { $ne: ['$dueDate', null] }] },
                  1,
                  0
                ]
              }
            },
            avgProgress: { $avg: '$progress' },
            totalEstimatedHours: { $sum: '$estimatedHours' },
            totalActualHours: { $sum: '$actualHours' }
          }
        }
      ]),
      Task.aggregate([{ $match: match }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
      Task.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Task.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$assignedTo',
            totalTasks: { $sum: 1 },
            completedTasks: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            avgProgress: { $avg: '$progress' }
          }
        },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'staff' } },
        { $unwind: '$staff' },
        { $project: { staffName: '$staff.fullName', totalTasks: 1, completedTasks: 1, avgProgress: 1 } }
      ])
    ]);

    res.json({
      success: true,
      data: {
        ...(summary[0] || { totalTasks: 0, completedTasks: 0, overdueTasks: 0, avgProgress: 0, totalEstimatedHours: 0, totalActualHours: 0 }),
        priorityDistribution,
        statusDistribution,
        staffWorkload
      }
    });
  } catch (error) {
    console.error('Error fetching task analytics:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch task analytics' });
  }
});

// GET /api/tasks/stats - Get task statistics
router.get('/stats', async (req, res) => {
  try {
    const visible = await visibleTasks(req.user);
    const within = (extra) => ({ $and: [visible, extra] });
    const [totalTasks, completedTasks, overdueTasks, activeTasks] = await Promise.all([
      Task.countDocuments(visible),
      Task.countDocuments(within({ status: 'completed' })),
      Task.countDocuments(within({ dueDate: { $lt: startOfToday() }, status: { $nin: ['completed', 'cancelled'] } })),
      Task.countDocuments(within({ status: 'in_progress' }))
    ]);

    res.json({ success: true, data: { totalTasks, completedTasks, overdueTasks, activeTasks } });
  } catch (error) {
    console.error('Error fetching task stats:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch task stats' });
  }
});

// GET /api/tasks/overdue - Get overdue tasks
router.get('/overdue', async (req, res) => {
  try {
    const tasks = await Task.find({
      $and: [await visibleTasks(req.user), { dueDate: { $lt: startOfToday() }, status: { $nin: ['completed', 'cancelled'] } }]
    }).populate('assignedTo', 'fullName email');
    res.json({ success: true, data: tasks });
  } catch (error) {
    console.error('Error fetching overdue tasks:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch overdue tasks' });
  }
});

// GET /api/tasks/by-priority/:priority - Get tasks by priority
router.get('/by-priority/:priority', [
  param('priority').isIn(['low', 'medium', 'high', 'urgent'])
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const tasks = await Task.find({ $and: [await visibleTasks(req.user), { priority: req.params.priority }] })
      .populate('assignedTo', 'fullName email role')
      .populate('jobId', 'title')
      .sort({ dueDate: 1 });
    res.json({ success: true, data: tasks });
  } catch (error) {
    console.error('Error fetching tasks by priority:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks by priority' });
  }
});

// GET /api/tasks/by-staff/:staffId - Tasks assigned to one person
router.get('/by-staff/:staffId', [
  param('staffId').isMongoId()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const { staffId } = req.params;
    const isSelf = staffId === req.user._id.toString();

    let filter;
    if (isSelf) {
      filter = { assignedTo: req.user._id };
    } else if (isTeamLead(req.user) && (await isSameOrgUser(req.user, staffId))) {
      filter = { $and: [await visibleTasks(req.user), { assignedTo: staffId }] };
    } else if (await isSameOrgUser(req.user, staffId)) {
      // Not a team lead: only the tasks you handed this person yourself.
      filter = { assignedTo: staffId, userId: req.user._id };
    } else {
      return forbidden(res, 'You can only view tasks for people in your business');
    }

    const tasks = await Task.find(filter)
      .populate('assignedTo', 'fullName email role')
      .populate('userId', 'fullName role')
      .populate('jobId', 'title')
      .populate('comments.author', 'fullName')
      .sort({ priority: -1, dueDate: 1 });

    res.json({ success: true, data: tasks });
  } catch (error) {
    console.error('Error fetching tasks by staff:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks by staff' });
  }
});

// GET /api/tasks/:id - Get specific task, with its comments and hand-off trail
router.get('/:id', [
  param('id').isMongoId()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const visible = await findVisibleTask(req.user, req.params.id);
    if (!visible) return notFound(res);

    const task = await populateTask(Task.findById(visible._id))
      .populate('subtasks', 'title status progress')
      .populate('dependencies.taskId', 'title status')
      .populate('timeEntries.userId', 'fullName email');

    // What the caller may do with it, so the screen only offers allowed actions.
    const access = { canManage: canManage(req.user, visible), canWorkOn: canWorkOn(req.user, visible) };
    res.json({ success: true, data: { ...task.toObject({ virtuals: true }), access } });
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch task' });
  }
});

// POST /api/tasks - Create new task
const requireAssign = (req, res, next) =>
  userCan(req.user, 'Staff & Tasks: Assign Tasks') ? next() : forbidden(res, 'You do not have permission to assign tasks');

router.post('/', requireAssign, taskValidation, async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;

    const data = pickEditable(req.body);
    const assignee = await validAssignee(req.user, data.assignedTo);
    if (!assignee) {
      return res.status(400).json({ success: false, message: 'Assigned staff not found' });
    }
    const { ok, job } = await validJob(req.user, data.jobId);
    if (!ok) {
      return res.status(400).json({ success: false, message: 'Job not found' });
    }

    const task = new Task({
      ...data,
      jobTitle: job?.title,
      // Who handed out the work (the field name predates this meaning).
      assignedByName: req.user.fullName,
      userId: req.user._id,
      dataScope: req.user.dataScope,
      history: [historyEntry(req.user, 'created', { to: assignee.fullName })]
    });
    await task.save();

    logTask(req, task, 'Task Created', 'create', `Task "${task.title}" was assigned to ${assignee.fullName}`);
    await notify({
      recipients: [assignee._id],
      actor: req.user,
      type: 'task_assigned',
      title: `New task: ${task.title}`,
      message: `${req.user.fullName} assigned you a task${task.dueDate ? ` due ${new Date(task.dueDate).toDateString()}` : ''}.`,
      link: taskLink(task),
      entityType: 'task',
      entityId: task._id
    });

    res.status(201).json({ success: true, data: await populateTask(Task.findById(task._id)) });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(400).json({ success: false, message: 'Failed to create task', error: error.message });
  }
});

// PUT /api/tasks/:id - Edit or reassign a task (assigner or team lead)
router.put('/:id', [
  param('id').isMongoId(),
  ...taskValidation
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const task = await findVisibleTask(req.user, req.params.id);
    if (!task) return notFound(res);
    if (!canManage(req.user, task)) {
      return forbidden(res, 'Only the person who assigned this task or a manager can edit it');
    }

    const updates = pickEditable(req.body);
    const previousAssignee = task.assignedTo;
    const reassigned = updates.assignedTo && !sameId(updates.assignedTo, previousAssignee);
    let newAssignee = null;
    if (reassigned) {
      newAssignee = await validAssignee(req.user, updates.assignedTo);
      if (!newAssignee) return res.status(400).json({ success: false, message: 'Assigned staff not found' });
    }
    if (updates.jobId !== undefined && !sameId(updates.jobId, task.jobId)) {
      const { ok, job } = await validJob(req.user, updates.jobId);
      if (!ok) return res.status(400).json({ success: false, message: 'Job not found' });
      updates.jobTitle = job?.title;
    }

    const statusChanged = updates.status && updates.status !== task.status;
    const fromStatus = task.status;
    Object.assign(task, updates);
    if (!task.dataScope && req.user.dataScope) task.dataScope = req.user.dataScope;
    if (statusChanged && updates.status !== 'completed') task.completedAt = undefined;
    if (reassigned) task.history.push(historyEntry(req.user, 'reassigned', { to: newAssignee.fullName }));
    if (statusChanged) task.history.push(historyEntry(req.user, 'status', { from: fromStatus, to: updates.status }));
    if (!reassigned && !statusChanged) task.history.push(historyEntry(req.user, 'updated'));
    await task.save();

    logTask(req, task, 'Task Updated', 'update', `Task "${task.title}" was updated`, 'low', { changes: { fields: Object.keys(updates) } });
    if (reassigned) {
      await notify({
        recipients: [newAssignee._id],
        actor: req.user,
        type: 'task_reassigned',
        title: `Task handed to you: ${task.title}`,
        message: `${req.user.fullName} reassigned this task to you.`,
        link: taskLink(task),
        entityType: 'task',
        entityId: task._id
      });
    }

    const populated = await populateTask(Task.findById(task._id));
    res.json({ success: true, data: populated });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(400).json({ success: false, message: 'Failed to update task', error: error.message });
  }
});

// DELETE /api/tasks/:id - Delete task (assigner or team lead)
router.delete('/:id', [
  param('id').isMongoId()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const task = await findVisibleTask(req.user, req.params.id);
    if (!task) return notFound(res);
    if (!canManage(req.user, task)) {
      return forbidden(res, 'Only the person who assigned this task or a manager can delete it');
    }
    await Task.deleteOne({ _id: task._id });
    logTask(req, task, 'Task Deleted', 'delete', `Task "${task.title}" was deleted`, 'high');
    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ success: false, message: 'Failed to delete task' });
  }
});

// PUT /api/tasks/:id/status - Update task status (assignee, assigner or team lead)
router.put('/:id/status', [
  param('id').isMongoId(),
  body('status').isIn(['pending', 'in_progress', 'completed', 'cancelled', 'on_hold']).withMessage('Invalid status'),
  body('notes').optional().isString().trim()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const { status, notes } = req.body;

    const task = await findVisibleTask(req.user, req.params.id);
    if (!task || !canWorkOn(req.user, task)) {
      return res.status(404).json({ success: false, message: 'Task not found or you do not have permission to update this task' });
    }
    // Cancelling is a decision about the work, not progress on it.
    if (status === 'cancelled' && !canManage(req.user, task)) {
      return forbidden(res, 'Only the person who assigned this task or a manager can cancel it');
    }

    const from = task.status;
    task.status = status;
    if (notes !== undefined) task.notes = notes;
    if (status === 'completed') {
      task.completedAt = task.completedAt || new Date();
      task.progress = 100;
    } else {
      task.completedAt = undefined;
    }
    if (!task.dataScope && req.user.dataScope) task.dataScope = req.user.dataScope;
    task.history.push(historyEntry(req.user, 'status', { from, to: status, note: notes || undefined }));
    await task.save();

    const updatedTask = await populateTask(Task.findById(task._id));
    const statusActionType = status === 'completed' ? 'complete' : status === 'cancelled' ? 'cancel' : 'update';
    logTask(req, task, 'Task Status Changed', statusActionType, `Task "${task.title}" status changed to ${status.replace('_', ' ')}`, 'medium');

    // The assignee reports back to whoever assigned the work; a manager's
    // change goes to the assignee.
    await notify({
      recipients: isAssignee(req.user, task) ? [task.userId] : [task.assignedTo, task.userId],
      actor: req.user,
      type: 'task_status',
      title: `${task.title}: ${status.replace('_', ' ')}`,
      message: `${req.user.fullName} changed the status from ${from.replace('_', ' ')} to ${status.replace('_', ' ')}${notes ? ` — "${notes}"` : ''}.`,
      link: taskLink(task),
      entityType: 'task',
      entityId: task._id
    });

    res.json({ success: true, data: updatedTask });
  } catch (error) {
    console.error('Error updating task status:', error);
    res.status(400).json({ success: false, message: 'Failed to update task status', error: error.message });
  }
});

// PUT /api/tasks/:id/progress - Update task progress
router.put('/:id/progress', [
  param('id').isMongoId(),
  body('progress').isInt({ min: 0, max: 100 }).withMessage('Progress must be between 0 and 100'),
  body('actualHours').optional().isFloat({ min: 0 }).withMessage('Actual hours must be positive')
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const task = await findVisibleTask(req.user, req.params.id);
    if (!task || !canWorkOn(req.user, task)) return notFound(res);

    const { progress, actualHours } = req.body;
    task.progress = progress;
    if (actualHours !== undefined) task.actualHours = actualHours;
    task.history.push(historyEntry(req.user, 'progress', { to: `${progress}%` }));
    await task.save();

    res.json({ success: true, data: await populateTask(Task.findById(task._id)) });
  } catch (error) {
    console.error('Error updating task progress:', error);
    res.status(400).json({ success: false, message: 'Failed to update task progress', error: error.message });
  }
});

// POST /api/tasks/:id/comments - Add comment to task
router.post('/:id/comments', [
  param('id').isMongoId(),
  body('text').isString().trim().notEmpty().withMessage('Comment text is required').isLength({ max: 2000 }).withMessage('Comments are limited to 2000 characters')
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const task = await findVisibleTask(req.user, req.params.id);
    if (!task || !canWorkOn(req.user, task)) return notFound(res);

    await task.addComment(req.body.text, req.user._id, req.user.fullName);

    const updatedTask = await populateTask(Task.findById(task._id));
    await notify({
      recipients: [task.assignedTo, task.userId],
      actor: req.user,
      type: 'task_comment',
      title: `Comment on ${task.title}`,
      message: `${req.user.fullName}: ${req.body.text.slice(0, 140)}`,
      link: taskLink(task),
      entityType: 'task',
      entityId: task._id
    });

    res.json({ success: true, data: updatedTask });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(400).json({ success: false, message: 'Failed to add comment', error: error.message });
  }
});

// POST /api/tasks/:id/time-entries - Add time entry to task
router.post('/:id/time-entries', [
  param('id').isMongoId(),
  body('startTime').isISO8601().withMessage('Valid start time is required'),
  body('endTime').isISO8601().withMessage('Valid end time is required'),
  body('description').optional().isString().trim()
], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const task = await findVisibleTask(req.user, req.params.id);
    if (!task || !canWorkOn(req.user, task)) return notFound(res);

    const { startTime, endTime, description } = req.body;
    await task.addTimeEntry(new Date(startTime), new Date(endTime), description, req.user._id);

    const updatedTask = await Task.findById(task._id).populate('timeEntries.userId', 'fullName email');
    res.json({ success: true, data: updatedTask });
  } catch (error) {
    console.error('Error adding time entry:', error);
    res.status(400).json({ success: false, message: 'Failed to add time entry', error: error.message });
  }
});

module.exports = router;
module.exports.visibleTasks = visibleTasks;
module.exports.isTeamLead = isTeamLead;
