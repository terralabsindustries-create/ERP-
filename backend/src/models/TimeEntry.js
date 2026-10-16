const mongoose = require('mongoose');

/*
  One block of time a person spent on a job (Design time page).

  An entry is either a live timer or time added by hand afterwards:
    timer   running → paused ↔ running → completed
    manual  completed from the start, with start–end times or only a duration

  duration   minutes worked, set once the entry is completed: endTime minus
             startTime, less the pauses. Running and paused entries keep 0
             until they are stopped (workedMs() gives the live figure).
             The Team overview sums this field.
  breaks     the pauses of a timer; the current pause has no endTime.
  isActive   true while running or paused. A person has at most one such
             entry (unique partial index), so two timers never run at once.
  staffId    the person whose time it is (the login that tracked it);
  staffName  their name when it was tracked. userId is the creator, the same
             login, used with dataScope to keep entries inside the business.
*/

const STATUSES = ['running', 'paused', 'completed'];
const ACTIVE_STATUSES = ['running', 'paused'];
const SOURCES = ['timer', 'manual'];

const breakSchema = new mongoose.Schema(
  {
    startTime: { type: Date, required: true },
    endTime: { type: Date }
  },
  { _id: false }
);

const timeEntrySchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: [true, 'Choose the job this time was spent on']
  },
  jobTitle: {
    type: String,
    required: [true, 'Job title is required'],
    trim: true
  },
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  },
  // The task's title, or what the person was doing when no task was picked.
  taskName: {
    type: String,
    required: [true, 'Task name is required'],
    trim: true,
    maxlength: [200, 'Task name is too long']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Keep the description under 500 characters'],
    default: ''
  },
  billable: {
    type: Boolean,
    default: true
  },
  source: {
    type: String,
    enum: SOURCES,
    default: 'timer'
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Staff ID is required']
  },
  staffName: {
    type: String,
    required: [true, 'Staff name is required'],
    trim: true
  },
  startTime: {
    type: Date,
    required: [true, 'Start time is required']
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number,
    min: [0, 'Duration cannot be negative'],
    default: 0
  },
  status: {
    type: String,
    enum: { values: STATUSES, message: 'Status must be running, paused or completed' },
    default: 'running'
  },
  isActive: {
    type: Boolean,
    default: false
  },
  breaks: {
    type: [breakSchema],
    default: []
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true
  }
}, {
  timestamps: true
});

timeEntrySchema.index({ userId: 1, startTime: -1 });
timeEntrySchema.index({ staffId: 1, startTime: -1 });
timeEntrySchema.index({ jobId: 1 });
timeEntrySchema.index(
  { staffId: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: 'one_open_timer_per_person' }
);

/**
 * Milliseconds worked from startTime to endTime (or `at` while the timer is
 * going), less the pauses. Pauses are clipped to the entry's span, so moving
 * the start or end of a stopped timer never counts a pause twice.
 */
timeEntrySchema.methods.workedMs = function workedMs(at = new Date()) {
  if (!this.startTime) return 0;
  const start = new Date(this.startTime).getTime();
  const end = new Date(this.endTime || at).getTime();
  if (end <= start) return 0;
  const paused = (this.breaks || []).reduce((sum, b) => {
    const from = Math.max(start, new Date(b.startTime).getTime());
    const to = Math.min(end, new Date(b.endTime || end).getTime());
    return sum + Math.max(0, to - from);
  }, 0);
  return Math.max(0, end - start - paused);
};

/** Minutes worked so far: the stored duration once completed, live otherwise. */
timeEntrySchema.methods.minutesSoFar = function minutesSoFar(at = new Date()) {
  if (this.status === 'completed') return this.duration || 0;
  return Math.round(this.workedMs(at) / 60000);
};

timeEntrySchema.pre('validate', function deriveState(next) {
  this.isActive = ACTIVE_STATUSES.includes(this.status);
  if (this.isActive) {
    this.endTime = null;
    this.duration = 0;
  } else if (this.endTime) {
    // A timer or a start–end entry: the minutes come from the times.
    this.duration = Math.round(this.workedMs() / 60000);
  }
  if (this.endTime && this.startTime && this.endTime < this.startTime) {
    this.invalidate('endTime', 'The end time must be after the start time');
  }
  next();
});

timeEntrySchema.statics.STATUSES = STATUSES;
timeEntrySchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;

module.exports = mongoose.model('TimeEntry', timeEntrySchema);
