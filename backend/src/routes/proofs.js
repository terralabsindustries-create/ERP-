/**
 * Proofing & approvals: proofs sent to customers for sign-off before a job is
 * printed. Mounted in app.js behind the "Job Proofing" module guard; approving
 * and recording requested changes need "Job Proofing: Approve" / "…: Reject".
 *
 * Every query is limited to the caller's business (see proofScope below).
 */
const express = require('express');
const mongoose = require('mongoose');
const { body, query, param } = require('express-validator');
const Proof = require('../models/Proof');
const Job = require('../models/Job');
const Customer = require('../models/Customer');
const File = require('../models/File');
const ActivityLog = require('../models/ActivityLog');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { orgUserFilter, orgScope } = require('../utils/accessScope');

const router = express.Router();

const STATUSES = ['draft', 'sent', 'approved', 'rejected', 'revised', 'expired'];
const VIEWS = ['all', 'draft', 'waiting', 'overdue', 'rejected', 'approved'];
const ACTIVE = Proof.ACTIVE_STATUSES;
const SEND_CHANNELS = ['whatsapp', 'email', 'in_person', 'other'];
const APPROVAL_CHANNELS = ['whatsapp', 'email', 'phone', 'in_person', 'other'];
const SORTABLE = ['createdAt', 'updatedAt', 'proofNumber', 'title', 'customerName', 'status'];
const MAX_FILES = 20;

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The caller's business. Proofs carry dataScope; proofs saved before it was
 * stored only have the creator's userId, so those are matched by creator.
 */
async function proofScope(user) {
  const byCreator = await orgUserFilter(user);
  if (!user.dataScope) return byCreator;
  return { $or: [{ dataScope: user.dataScope }, { dataScope: null, ...byCreator }] };
}

const withScope = async (user, ...conditions) => ({ $and: [await proofScope(user), ...conditions.filter(Boolean)] });

const viewFilter = (view) => {
  switch (view) {
    case 'draft': return { status: 'draft' };
    case 'waiting': return { status: { $in: ACTIVE } };
    case 'overdue': return { status: { $in: ACTIVE }, 'approval.expiresAt': { $lt: new Date() } };
    case 'rejected': return { status: 'rejected' };
    case 'approved': return { status: 'approved' };
    default: return null;
  }
};

const populateProof = (q) => q
  .populate('jobId', 'title status dueDate printSpecs')
  .populate('customerId', 'name email phone company');

const notFound = (res) => res.status(404).json({ status: 'error', message: 'Proof not found' });

const serverError = (res, what, error) => {
  console.error(`${what} error:`, error);
  if (error && error.name === 'ValidationError') {
    const first = Object.values(error.errors)[0];
    return res.status(400).json({ status: 'error', message: first?.message || 'Invalid proof' });
  }
  return res.status(500).json({ status: 'error', message: `Server error while ${what.toLowerCase()}` });
};

const log = (req, proof, action, actionType, description, severity = 'low', extra = {}) =>
  ActivityLog.logActivity({
    action,
    description,
    entityType: 'proof',
    entityId: proof._id,
    entityName: `${proof.proofNumber} ${proof.title}`.trim(),
    performedBy: req.user._id,
    performedByName: req.user.fullName,
    actionType,
    severity,
    relatedJob: proof.jobId?._id || proof.jobId,
    relatedCustomer: proof.customerId?._id || proof.customerId,
    userId: req.user._id,
    dataScope: req.user.dataScope,
    ...extra
  }).catch((err) => console.error(`Activity log (${action}) failed:`, err.message));

/** Find one proof of the caller's business, as a document (for changes). */
async function findProof(req) {
  return Proof.findOne(await withScope(req.user, { _id: req.params.id }));
}

async function respondWithProof(res, id, message, status = 200) {
  const proof = await populateProof(Proof.findById(id));
  return res.status(status).json({ status: 'success', ...(message && { message }), data: { proof } });
}

/** The job (and its customer) of the caller's business, or an error message. */
async function resolveJob(user, jobId) {
  const job = await Job.findOne({ _id: jobId, ...orgScope(user) });
  if (!job) return { error: 'Job not found' };
  const customer = await Customer.findOne({ _id: job.customerId, ...orgScope(user) });
  if (!customer) return { error: "This job's customer could not be found" };
  return { job, customer };
}

/**
 * Turn the uploaded files named in the body into proof files. Only files
 * uploaded by someone in the caller's business are accepted, and their details
 * come from the stored File record, not from the request.
 */
async function resolveFiles(user, files) {
  const ids = files.map((f) => String(f.fileId));
  if (new Set(ids).size !== ids.length) return { error: 'The same file is listed twice' };
  const found = await File.find({ _id: { $in: ids }, status: { $ne: 'deleted' }, ...(await orgUserFilter(user)) });
  const byId = new Map(found.map((f) => [String(f._id), f]));
  if (ids.some((id) => !byId.has(id))) return { error: 'One of the files was not found. Upload it again.' };
  return {
    files: ids.map((id) => {
      const f = byId.get(id);
      return {
        fileId: f._id,
        fileName: f.originalName,
        fileUrl: f.fileUrl,
        fileType: f.fileType,
        fileSize: f.fileSize,
        mimeType: f.mimeType,
        uploadedAt: f.createdAt || new Date(),
        uploadedBy: f.uploadedBy
      };
    })
  };
}

// ---------------------------------------------------------------- validators

const idParam = [param('id').isMongoId().withMessage('Invalid proof id')];

const specRules = [
  body('specifications').optional().isObject().withMessage('Specifications must be an object'),
  body('specifications.paperSize').optional({ values: 'null' }).isString().trim().isLength({ max: 100 }).withMessage('Paper size is too long'),
  body('specifications.paperType').optional({ values: 'null' }).isString().trim().isLength({ max: 100 }).withMessage('Paper type is too long'),
  body('specifications.colorMode').optional({ values: 'falsy' }).isIn(['color', 'black_white']).withMessage('Colour mode must be colour or black & white'),
  body('specifications.quantity').optional({ values: 'falsy' }).isInt({ min: 1, max: 100000000 }).withMessage('Quantity must be a whole number above 0').toInt(),
  body('specifications.finishing').optional({ values: 'null' }).isArray({ max: 20 }).withMessage('Finishing must be a list'),
  body('specifications.finishing.*').isString().trim().isLength({ min: 1, max: 60 }).withMessage('Each finishing option must be short text'),
  body('specifications.specialInstructions').optional({ values: 'null' }).isString().trim().isLength({ max: 2000 }).withMessage('Instructions are too long')
];

const fileRules = [
  body('files').isArray({ min: 1, max: MAX_FILES }).withMessage(`Add between 1 and ${MAX_FILES} files`),
  body('files.*.fileId').isMongoId().withMessage('Each file must be an uploaded file')
];

const createRules = [
  body('jobId').isMongoId().withMessage('Choose the job this proof is for'),
  body('title').isString().withMessage('Proof title is required').trim().notEmpty().withMessage('Proof title is required').isLength({ max: 200 }).withMessage('Proof title is too long'),
  body('description').optional({ values: 'null' }).isString().trim().isLength({ max: 2000 }).withMessage('Description is too long'),
  body('status').optional().isIn(['draft', 'sent']).withMessage('A new proof is saved as a draft or as sent'),
  body('sentVia').optional({ values: 'falsy' }).isIn(SEND_CHANNELS).withMessage('Invalid channel'),
  body('expiryDays').optional({ values: 'falsy' }).isInt({ min: 1, max: 90 }).withMessage('Reply-by days must be between 1 and 90').toInt(),
  ...specRules,
  ...fileRules
];

// Editing details never touches files or status: those have their own routes.
const updateRules = [
  ...idParam,
  body('jobId').optional().isMongoId().withMessage('Choose the job this proof is for'),
  body('title').optional().isString().withMessage('Proof title is required').trim().notEmpty().withMessage('Proof title is required').isLength({ max: 200 }).withMessage('Proof title is too long'),
  body('description').optional({ values: 'null' }).isString().trim().isLength({ max: 2000 }).withMessage('Description is too long'),
  body('expiryDays').optional({ values: 'falsy' }).isInt({ min: 1, max: 90 }).withMessage('Reply-by days must be between 1 and 90').toInt(),
  ...specRules
];

const cleanSpecs = (s = {}) => ({
  paperSize: s.paperSize || undefined,
  paperType: s.paperType || undefined,
  colorMode: s.colorMode || 'color',
  quantity: s.quantity || undefined,
  finishing: Array.isArray(s.finishing) ? s.finishing.filter(Boolean) : [],
  specialInstructions: s.specialInstructions || undefined
});

// ------------------------------------------------------------------- routes

// @route   GET /api/proofs/stats/summary
// @desc    Counts for the summary strip, for the caller's business
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const stats = await Proof.getProofStats(await proofScope(req.user));
    res.status(200).json({ status: 'success', data: { stats } });
  } catch (error) {
    serverError(res, 'Fetching proof statistics', error);
  }
});

// @route   GET /api/proofs
// @desc    Proofs of the caller's business, with per-view counts over the search
router.get('/', protect, [
  query('view').optional().isIn(VIEWS).withMessage('Unknown view'),
  query('status').optional().isIn([...STATUSES, 'all']).withMessage('Unknown status'),
  query('jobId').optional().isMongoId().withMessage('Invalid job id'),
  query('customerId').optional().isMongoId().withMessage('Invalid customer id'),
  query('search').optional().isString().trim().isLength({ max: 100 }),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('sortBy').optional().isIn(SORTABLE).withMessage('Unknown sort field'),
  query('sortOrder').optional().isIn(['asc', 'desc'])
], validate, async (req, res) => {
  try {
    const { view = 'all', status, jobId, customerId, search, sortBy = 'updatedAt', sortOrder = 'desc' } = req.query;
    const page = req.query.page || 1;
    const limit = req.query.limit || 25;

    const base = [];
    if (jobId) base.push({ jobId: new mongoose.Types.ObjectId(jobId) });
    if (customerId) base.push({ customerId: new mongoose.Types.ObjectId(customerId) });
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const jobIds = await Job.find({ title: rx, ...orgScope(req.user) }).distinct('_id');
      base.push({
        $or: [
          { proofNumber: rx },
          { title: rx },
          { customerName: rx },
          { jobTitle: rx },
          ...(jobIds.length ? [{ jobId: { $in: jobIds } }] : [])
        ]
      });
    }

    const listFilter = await withScope(req.user, ...base, viewFilter(view), status && status !== 'all' ? { status } : null);
    const countFor = async (v) => Proof.countDocuments(await withScope(req.user, ...base, viewFilter(v)));

    const [proofs, totalProofs, all, draft, waiting, overdue, rejected, approved] = await Promise.all([
      populateProof(Proof.find(listFilter))
        .select('-feedback -previousVersions.files')
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Proof.countDocuments(listFilter),
      countFor('all'),
      countFor('draft'),
      countFor('waiting'),
      countFor('overdue'),
      countFor('rejected'),
      countFor('approved')
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        proofs,
        summary: { all, draft, waiting, overdue, rejected, approved },
        pagination: {
          current: page,
          total: Math.ceil(totalProofs / limit),
          count: proofs.length,
          totalProofs
        }
      }
    });
  } catch (error) {
    serverError(res, 'Fetching proofs', error);
  }
});

// @route   GET /api/proofs/:id
router.get('/:id', protect, idParam, validate, async (req, res) => {
  try {
    const proof = await populateProof(Proof.findOne(await withScope(req.user, { _id: req.params.id })));
    if (!proof) return notFound(res);
    res.status(200).json({ status: 'success', data: { proof } });
  } catch (error) {
    serverError(res, 'Fetching proof', error);
  }
});

// @route   POST /api/proofs
// @desc    Create a proof from uploaded files, as a draft or already sent
router.post('/', protect, createRules, validate, async (req, res) => {
  try {
    const { job, customer, error } = await resolveJob(req.user, req.body.jobId);
    if (error) return res.status(400).json({ status: 'error', message: error });

    const resolved = await resolveFiles(req.user, req.body.files);
    if (resolved.error) return res.status(400).json({ status: 'error', message: resolved.error });

    const proof = new Proof({
      jobId: job._id,
      jobTitle: job.title,
      customerId: customer._id,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      title: req.body.title,
      description: req.body.description || undefined,
      specifications: cleanSpecs(req.body.specifications),
      files: resolved.files,
      status: 'draft',
      settings: { expiryDays: req.body.expiryDays || 7 },
      userId: req.user._id,
      dataScope: req.user.dataScope
    });
    if (req.body.status === 'sent') proof.markSent(req.user, req.body.sentVia);

    const saved = await Proof.createNumbered(proof);

    log(req, saved, 'Proof Created', 'create', `Proof ${saved.proofNumber} "${saved.title}" was created${saved.status === 'sent' ? ' and sent to the customer' : ''}`);

    return respondWithProof(res, saved._id, 'Proof created', 201);
  } catch (error) {
    serverError(res, 'Creating proof', error);
  }
});

// @route   PUT /api/proofs/:id
// @desc    Edit the details of a proof (title, notes, specifications, job)
router.put('/:id', protect, updateRules, validate, async (req, res) => {
  try {
    const proof = await findProof(req);
    if (!proof) return notFound(res);

    if (req.body.jobId && String(req.body.jobId) !== String(proof.jobId)) {
      const { job, customer, error } = await resolveJob(req.user, req.body.jobId);
      if (error) return res.status(400).json({ status: 'error', message: error });
      proof.jobId = job._id;
      proof.jobTitle = job.title;
      proof.customerId = customer._id;
      proof.customerName = customer.name;
      proof.customerEmail = customer.email;
      proof.customerPhone = customer.phone;
    }
    if (req.body.title !== undefined) proof.title = req.body.title;
    if (req.body.description !== undefined) proof.description = req.body.description || undefined;
    if (req.body.specifications !== undefined) proof.specifications = cleanSpecs(req.body.specifications);
    if (req.body.expiryDays) proof.settings.expiryDays = req.body.expiryDays;

    await proof.save();
    log(req, proof, 'Proof Updated', 'update', `Proof ${proof.proofNumber} details were updated`, 'low', {
      changes: { fields: Object.keys(req.body) }
    });
    return respondWithProof(res, proof._id, 'Proof updated');
  } catch (error) {
    serverError(res, 'Updating proof', error);
  }
});

// @route   POST /api/proofs/:id/send
// @desc    Record that the current version was sent to the customer
router.post('/:id/send', protect, [
  ...idParam,
  body('sentVia').optional({ values: 'falsy' }).isIn(SEND_CHANNELS).withMessage('Invalid channel')
], validate, async (req, res) => {
  try {
    const proof = await findProof(req);
    if (!proof) return notFound(res);
    if (proof.status === 'approved') {
      return res.status(400).json({ status: 'error', message: 'This proof is already approved' });
    }
    if (proof.status === 'rejected') {
      return res.status(400).json({ status: 'error', message: 'The customer asked for changes. Upload a new version to send it again.' });
    }

    const resend = ACTIVE.includes(proof.status);
    proof.markSent(req.user, req.body.sentVia);
    if (resend) proof.notifications.reminderSentAt = new Date();
    await proof.save();

    log(req, proof, resend ? 'Proof Re-sent' : 'Proof Sent', 'send', `Proof ${proof.proofNumber} v${proof.version} was ${resend ? 're-sent' : 'sent'} to ${proof.customerName}`);
    return respondWithProof(res, proof._id, resend ? 'Proof re-sent' : 'Proof marked as sent');
  } catch (error) {
    serverError(res, 'Sending proof', error);
  }
});

// @route   POST /api/proofs/:id/versions
// @desc    Upload a new version: the current files move to the history
router.post('/:id/versions', protect, [
  ...idParam,
  ...fileRules,
  body('notes').optional({ values: 'null' }).isString().trim().isLength({ max: 2000 }).withMessage('Notes are too long'),
  body('send').optional().isBoolean().withMessage('send must be true or false').toBoolean(),
  body('sentVia').optional({ values: 'falsy' }).isIn(SEND_CHANNELS).withMessage('Invalid channel')
], validate, async (req, res) => {
  try {
    const proof = await findProof(req);
    if (!proof) return notFound(res);

    const resolved = await resolveFiles(req.user, req.body.files);
    if (resolved.error) return res.status(400).json({ status: 'error', message: resolved.error });

    proof.previousVersions.push({
      version: proof.version,
      files: proof.files.map((f) => ({
        fileId: f.fileId,
        fileName: f.fileName,
        fileUrl: f.fileUrl,
        fileType: f.fileType,
        fileSize: f.fileSize,
        mimeType: f.mimeType
      })),
      uploadedAt: proof.files[0]?.uploadedAt || proof.createdAt,
      uploadedBy: proof.files[0]?.uploadedBy || proof.userId,
      notes: proof.versionNotes,
      status: proof.status,
      sentAt: proof.notifications?.sentAt,
      rejectionReason: proof.approval?.rejectionReason,
      rejectedAt: proof.approval?.rejectedAt
    });

    (proof.feedback.revisions || []).forEach((r) => {
      if (r.status !== 'completed') r.status = 'completed';
    });

    proof.version += 1;
    proof.files = resolved.files;
    proof.versionNotes = req.body.notes || undefined;
    proof.approval = {
      status: 'pending',
      expiresAt: undefined
    };
    proof.notifications.sentAt = undefined;
    proof.notifications.sentBy = undefined;
    proof.notifications.sentByName = undefined;
    proof.notifications.sentVia = undefined;
    proof.notifications.reminderSentAt = undefined;
    proof.status = 'draft';
    if (req.body.send !== false) proof.markSent(req.user, req.body.sentVia);

    await proof.save();
    log(req, proof, 'Proof Version Uploaded', 'upload', `Version ${proof.version} of proof ${proof.proofNumber} was uploaded${proof.status === 'revised' ? ' and sent' : ''}`);
    return respondWithProof(res, proof._id, `Version ${proof.version} uploaded`);
  } catch (error) {
    serverError(res, 'Uploading new version', error);
  }
});

// @route   PUT /api/proofs/:id/approve
// @desc    Record that the customer approved the current version
router.put('/:id/approve', protect, [
  ...idParam,
  body('approvalNotes').optional({ values: 'null' }).isString().trim().isLength({ max: 2000 }).withMessage('Notes are too long'),
  body('approvedByName').optional({ values: 'null' }).isString().trim().isLength({ max: 120 }).withMessage('Name is too long'),
  body('channel').optional({ values: 'falsy' }).isIn(APPROVAL_CHANNELS).withMessage('Invalid channel')
], validate, async (req, res) => {
  try {
    const proof = await findProof(req);
    if (!proof) return notFound(res);
    if (proof.status === 'approved') {
      return res.status(400).json({ status: 'error', message: 'This proof is already approved' });
    }

    proof.status = 'approved';
    proof.approval.status = 'approved';
    proof.approval.approvedAt = new Date();
    proof.approval.approvedBy = proof.customerId;
    proof.approval.approvedByName = req.body.approvedByName || undefined;
    proof.approval.channel = req.body.channel || undefined;
    proof.approval.approvalNotes = req.body.approvalNotes || undefined;
    proof.approval.recordedBy = req.user._id;
    proof.approval.recordedByName = req.user.fullName;
    proof.approval.rejectedAt = undefined;
    proof.approval.rejectionReason = undefined;
    await proof.save();

    log(req, proof, 'Proof Approved', 'approve', `Proof ${proof.proofNumber} v${proof.version} was approved by ${proof.approval.approvedByName || proof.customerName}`, 'medium');
    return respondWithProof(res, proof._id, 'Approval recorded');
  } catch (error) {
    serverError(res, 'Approving proof', error);
  }
});

// @route   PUT /api/proofs/:id/reject
// @desc    Record that the customer asked for changes
router.put('/:id/reject', protect, [
  ...idParam,
  body('rejectionReason').isString().withMessage('Say what the customer wants changed').trim().notEmpty().withMessage('Say what the customer wants changed').isLength({ max: 2000 }).withMessage('Reason is too long')
], validate, async (req, res) => {
  try {
    const proof = await findProof(req);
    if (!proof) return notFound(res);
    if (proof.status === 'rejected') {
      return res.status(400).json({ status: 'error', message: 'Changes are already requested on this version' });
    }

    const now = new Date();
    proof.status = 'rejected';
    proof.approval.status = 'rejected';
    proof.approval.rejectedAt = now;
    proof.approval.rejectionReason = req.body.rejectionReason;
    proof.approval.approvedAt = undefined;
    proof.approval.approvedByName = undefined;
    proof.approval.approvalNotes = undefined;
    proof.approval.recordedBy = req.user._id;
    proof.approval.recordedByName = req.user.fullName;
    proof.feedback.revisions.push({
      revisionNumber: proof.version,
      requestedBy: proof.customerId,
      requestedAt: now,
      description: req.body.rejectionReason,
      status: 'pending'
    });
    await proof.save();

    log(req, proof, 'Proof Changes Requested', 'reject', `Changes requested on proof ${proof.proofNumber} v${proof.version}: ${req.body.rejectionReason}`, 'medium');
    return respondWithProof(res, proof._id, 'Changes recorded');
  } catch (error) {
    serverError(res, 'Recording changes', error);
  }
});

// @route   POST /api/proofs/:id/comments
// @desc    Add an internal note
router.post('/:id/comments', protect, [
  ...idParam,
  body('comment').isString().withMessage('Write a note first').trim().notEmpty().withMessage('Write a note first').isLength({ max: 2000 }).withMessage('Note is too long'),
  body('isInternal').optional().isBoolean().toBoolean()
], validate, async (req, res) => {
  try {
    const proof = await findProof(req);
    if (!proof) return notFound(res);

    proof.feedback.comments.push({
      comment: req.body.comment,
      commentedBy: req.user._id,
      commentedByName: req.user.fullName,
      commentedAt: new Date(),
      isInternal: req.body.isInternal !== false
    });
    await proof.save();
    return respondWithProof(res, proof._id, 'Note added');
  } catch (error) {
    serverError(res, 'Adding note', error);
  }
});

// @route   DELETE /api/proofs/:id
router.delete('/:id', protect, idParam, validate, async (req, res) => {
  try {
    const proof = await Proof.findOneAndDelete(await withScope(req.user, { _id: req.params.id }));
    if (!proof) return notFound(res);
    log(req, proof, 'Proof Deleted', 'delete', `Proof ${proof.proofNumber} "${proof.title}" was deleted`, 'high');
    res.status(200).json({ status: 'success', message: 'Proof deleted' });
  } catch (error) {
    serverError(res, 'Deleting proof', error);
  }
});

module.exports = router;
