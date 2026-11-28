/**
 * One-line audit writer for route handlers:
 *
 *   audit(req, { action: 'Payslip Paid', entityType: 'payroll', entityId, entityName,
 *                actionType: 'update', before, after, reason, severity: 'high' });
 *
 * Tenant, actor, correlation id, client address and redaction come from the
 * request and from ActivityLog.logActivity. A failed write is logged loudly
 * but never fails the business operation it describes.
 */
const ActivityLog = require('../models/ActivityLog');

function audit(req, { action, description, entityType, entityId, entityName, actionType, before, after, reason, severity = 'medium', metadata, relatedCustomer, relatedInvoice, relatedJob, protected: isProtected }) {
  const hasChange = before !== undefined || after !== undefined;
  return ActivityLog.logActivity({
    action,
    description: description || `${action}${entityName ? `: ${entityName}` : ''}`,
    entityType,
    entityId,
    entityName,
    performedBy: req.user._id,
    performedByName: req.user.fullName || req.user.email || 'User',
    actionType,
    changes: hasChange ? { before, after } : undefined,
    reason,
    protected: isProtected,
    severity,
    metadata,
    relatedCustomer,
    relatedInvoice,
    relatedJob,
    userId: req.user._id,
    dataScope: req.user.dataScope
  }).catch((error) => console.error(`AUDIT WRITE FAILED (${action}):`, error.message));
}

module.exports = { audit };
