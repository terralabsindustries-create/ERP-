const mongoose = require('mongoose');

/**
 * Durable trace of multi-document writes that ran WITHOUT a database
 * transaction (standalone MongoDB), where a crash or a failed undo can leave
 * half-finished data.
 *
 *   started              written before the work begins, deleted when it
 *                        finishes (committed) or is fully undone. One that
 *                        stays is an interrupted operation (process killed,
 *                        connection lost): the reconciliation report lists it.
 *   compensation_failed  the work failed AND at least one undo step failed:
 *                        records the original error and each failed step.
 *   resolved             a person reviewed and corrected / dismissed it
 *                        (scripts or the reconciliation workflow), with a note.
 *
 * Never modified by the application except to mark resolution.
 */
const schema = new mongoose.Schema({
  label: { type: String, required: true },
  status: { type: String, enum: ['started', 'compensation_failed', 'resolved'], default: 'started', index: true },
  correlationId: String,
  dataScope: { type: String, index: true },
  userId: mongoose.Schema.Types.ObjectId,
  originalError: String,
  undoErrors: [{ step: Number, message: String }],
  undoStepsTotal: Number,
  failedAt: Date,
  resolvedBy: mongoose.Schema.Types.ObjectId,
  resolvedAt: Date,
  resolutionNote: { type: String, maxlength: 1000 }
}, { timestamps: true });

schema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('TransactionJournal', schema);
