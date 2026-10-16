const mongoose = require('mongoose');

/**
 * One message for one person: "Asha assigned you a task", "Ravi marked the
 * proof task done", "New comment on…". Created by utils/notify.js when work
 * changes hands; read in the header bell and the dashboard.
 */
const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  dataScope: {
    type: String,
    index: true
  },
  type: {
    type: String,
    enum: ['task_assigned', 'task_reassigned', 'task_status', 'task_comment', 'job_assigned'],
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    trim: true
  },
  // Client route that shows the record, e.g. /staff?task=<id>
  link: {
    type: String,
    trim: true
  },
  entityType: {
    type: String,
    enum: ['task', 'job']
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  actorName: {
    type: String,
    trim: true
  },
  readAt: {
    type: Date
  }
}, {
  timestamps: true
});

notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
